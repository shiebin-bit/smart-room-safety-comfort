from __future__ import annotations

import csv
import io
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from typing import Callable, TypeVar

from flask import Flask, Response, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "smart_room.db"
DEFAULT_DEVICE_ID = "ESP32_ROOM_01"
DEFAULT_BACKEND_URL = os.environ.get("SMARTROOM_BACKEND_URL", "https://smartroomsafety.shiebindev.com")
SAVED_WIFI_PASSWORD_MARKER = "__SAVED_WIFI_PROFILE__"
PAIRING_MINUTES = 15
ONLINE_SECONDS = 15
DELAYED_SECONDS = 60
DEFAULT_INVITE_CODES = {
    "SMARTROOM-DEMO-2026": 30,
    "SMARTROOM-LECTURER": 10,
    "A252-SENSOR-DEMO": 30,
    "ROOMSAFETY-TEST": 20,
}
HISTORY_RANGES = {
    "1h": timedelta(hours=1),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}

app = Flask(__name__)
app.secret_key = os.environ.get("SMARTROOM_SECRET_KEY", "dev-smart-room-secret-change-me")

F = TypeVar("F", bound=Callable)


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_error: Exception | None = None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def digital_label(value: int | str | None) -> str:
    return "HIGH" if int(value or 0) == 1 else "LOW"


def normalize_device_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", value.strip())
    return cleaned.upper()[:48] or DEFAULT_DEVICE_ID


def password_error(password: str, confirm: str | None = None) -> str | None:
    if len(password) < 8:
        return "Password must be at least 8 characters."
    if not re.search(r"[A-Za-z]", password):
        return "Password must include at least one letter."
    if not re.search(r"\d", password):
        return "Password must include at least one number."
    if confirm is not None and password != confirm:
        return "Password confirmation does not match."
    return None


def invite_code_error(db: sqlite3.Connection, invite_code: str) -> tuple[str | None, sqlite3.Row | None]:
    cleaned = invite_code.strip()
    if not cleaned:
        return "Invite code is required.", None
    rows = db.execute(
        """
        SELECT * FROM invite_codes
        WHERE is_active = 1 AND use_count < max_uses
        ORDER BY id
        """
    ).fetchall()
    for row in rows:
        if check_password_hash(row["code_hash"], cleaned):
            return None, row
    return "Invite code is invalid or no longer available.", None


def generate_device_id() -> str:
    return f"SR-{secrets.token_hex(3).upper()}"


def generate_pairing_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def generate_device_token() -> str:
    return secrets.token_urlsafe(32)


def device_state(row: sqlite3.Row | dict) -> str:
    pairing_status = row["pairing_status"] if isinstance(row, sqlite3.Row) else row.get("pairing_status")
    expires = parse_utc(row["pairing_expires_at"] if isinstance(row, sqlite3.Row) else row.get("pairing_expires_at"))
    if pairing_status == "WAITING" and expires and datetime.now(timezone.utc) > expires:
        return "PAIRING_EXPIRED"
    if pairing_status == "WAITING":
        return "WAITING_FOR_SETUP"
    last_seen = parse_utc(row["last_seen"] if isinstance(row, sqlite3.Row) else row.get("last_seen"))
    if not last_seen:
        return "OFFLINE"
    age = (datetime.now(timezone.utc) - last_seen).total_seconds()
    if age <= ONLINE_SECONDS:
        return "ONLINE"
    if age <= DELAYED_SECONDS:
        return "DELAYED"
    return "OFFLINE"


def history_filter(device_id: str) -> tuple[str, list]:
    range_key = str(request.args.get("range", "all")).lower()
    params: list = [device_id]
    where = "device_id = ?"
    if range_key in HISTORY_RANGES:
        since = (datetime.now(timezone.utc) - HISTORY_RANGES[range_key]).isoformat(timespec="seconds")
        where += " AND created_at >= ?"
        params.append(since)
    return where, params


def summary_for_device(db: sqlite3.Connection, device_id: str) -> dict:
    where, params = history_filter(device_id)
    row = db.execute(
        f"""
        SELECT
            COUNT(*) AS total_records,
            ROUND(AVG(temperature), 1) AS avg_temperature,
            ROUND(AVG(humidity), 1) AS avg_humidity,
            MAX(gas_raw) AS highest_gas,
            MIN(light_raw) AS lowest_light,
            ROUND(AVG(sound_raw), 0) AS avg_sound,
            MAX(sound_raw) AS highest_sound,
            SUM(CASE WHEN sound_raw = 1 THEN 1 ELSE 0 END) AS sound_trigger_count,
            SUM(CASE WHEN status IN ('WARNING', 'CRITICAL') THEN 1 ELSE 0 END) AS warning_count,
            SUM(CASE WHEN status = 'CRITICAL' THEN 1 ELSE 0 END) AS critical_count
        FROM sensor_data
        WHERE {where}
        """,
        params,
    ).fetchone()
    return row_to_dict(row) or {}


def settings_for_device(db: sqlite3.Connection, device_id: str) -> dict:
    ensure_device_defaults(db, device_id)
    row = db.execute("SELECT * FROM device_settings WHERE device_id = ?", (device_id,)).fetchone()
    return row_to_dict(row) or {}


def latest_insights(reading: dict, settings: dict, connection_state: str) -> dict:
    if not reading:
        return {
            "comfort_score": None,
            "comfort_label": "Waiting",
            "alert_reasons": ["No room reading has been received yet."],
            "action_recommendations": ["Complete setup and wait for the first ESP32 upload."],
        }

    temp = float(reading.get("temperature") or 0)
    humidity = float(reading.get("humidity") or 0)
    gas = int(reading.get("gas_raw") or 0)
    light = int(reading.get("light_raw") or 0)
    sound = int(reading.get("sound_raw") or 0)
    status = str(reading.get("status") or "NORMAL").upper()
    temp_warning = float(settings.get("temp_warning", 32))
    temp_critical = float(settings.get("temp_critical", 38))
    gas_warning = int(settings.get("gas_warning", 1800))
    gas_critical = int(settings.get("gas_critical", 2600))
    dark_state = int(settings.get("light_low", 1))

    reasons: list[str] = []
    actions: list[str] = []
    score = 100

    if connection_state == "OFFLINE":
        score -= 30
        reasons.append("The room sensor is offline.")
        actions.append("Check ESP32 power, WiFi connection and Cloudflare tunnel status.")
    elif connection_state == "DELAYED":
        score -= 12
        reasons.append("The latest device check-in is delayed.")
        actions.append("Wait for the next upload or check the WiFi signal.")

    if temp >= temp_critical:
        score -= 28
        reasons.append(f"Temperature is {temp:.1f} C, above the critical limit.")
        actions.append("Turn on ventilation and check the room heat source.")
    elif temp >= temp_warning:
        score -= 14
        reasons.append(f"Temperature is {temp:.1f} C, above the warning limit.")
        actions.append("Improve airflow or reduce room heat.")
    elif temp < 18:
        score -= 8
        reasons.append("Temperature is below the usual comfort range.")
        actions.append("Check whether the room is too cold for occupants.")

    if humidity >= 80:
        score -= 12
        reasons.append("Humidity is high and may feel uncomfortable.")
        actions.append("Improve ventilation or reduce moisture sources.")
    elif humidity < 35:
        score -= 8
        reasons.append("Humidity is low and may feel dry.")
        actions.append("Consider adding moisture or reducing air conditioning.")

    if gas >= gas_critical:
        score -= 35
        reasons.append("Gas reading is above the critical threshold.")
        actions.append("Check for smoke or gas source immediately.")
    elif gas >= gas_warning:
        score -= 18
        reasons.append("Gas reading is above the warning threshold.")
        actions.append("Ventilate the room and monitor the gas trend.")

    if light == dark_state:
        score -= 5
        reasons.append("The room is currently dark.")
        actions.append("Turn on lighting if the room is occupied.")

    if sound > 0:
        score -= 6
        reasons.append("Sound trigger is active.")
        actions.append("Check for unusual noise in the room.")

    if status == "NORMAL" and not reasons:
        reasons.append("All readings are within the configured limits.")
        actions.append("No immediate action is needed.")
    elif not actions:
        actions.append("Review the latest reading and adjust thresholds if needed.")

    score = max(0, min(100, score))
    if score >= 85:
        label = "Comfortable"
    elif score >= 65:
        label = "Monitor"
    elif score >= 40:
        label = "Needs Action"
    else:
        label = "Unsafe"

    return {
        "comfort_score": score,
        "comfort_label": label,
        "alert_reasons": reasons[:4],
        "action_recommendations": actions[:4],
    }


def health_from(device: sqlite3.Row, summary: dict) -> dict:
    state = device_state(device)
    score = 100
    reasons = []
    total_records = int(summary.get("total_records") or 0)
    warning_count = int(summary.get("warning_count") or 0)
    critical_count = int(summary.get("critical_count") or 0)

    if state == "OFFLINE":
        score -= 45
        reasons.append("Device is offline.")
    elif state == "DELAYED":
        score -= 20
        reasons.append("Device check-in is delayed.")
    elif state in {"WAITING_FOR_SETUP", "PAIRING_EXPIRED"}:
        score -= 30
        reasons.append("Device setup is not complete.")

    if total_records == 0:
        score -= 20
        reasons.append("No sensor records have been received.")
    if critical_count:
        score -= min(35, 12 + critical_count * 3)
        reasons.append(f"{critical_count} critical event(s) recorded.")
    elif warning_count:
        score -= min(20, 8 + warning_count)
        reasons.append(f"{warning_count} warning event(s) recorded.")

    rssi = device["wifi_rssi"]
    if rssi is not None and int(rssi) < -75:
        score -= 15
        reasons.append("WiFi signal is weak.")
    wifi_status = str(device["wifi_status"] or "").upper()
    if "FAILED" in wifi_status or "ERROR" in wifi_status:
        score -= 20
        reasons.append("Last WiFi operation failed.")

    score = max(0, min(100, score))
    if state in {"WAITING_FOR_SETUP", "PAIRING_EXPIRED"}:
        label = "Setup Needed"
    elif score >= 80:
        label = "Good"
    elif score >= 55:
        label = "Watch"
    else:
        label = "Needs Attention"
    return {"health_score": score, "health_label": label, "health_reasons": reasons[:3]}


def init_db() -> None:
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            invite_code_label TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS invite_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code_label TEXT NOT NULL UNIQUE,
            code_hash TEXT NOT NULL,
            max_uses INTEGER NOT NULL DEFAULT 1,
            use_count INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY,
            user_id INTEGER,
            device_name TEXT NOT NULL,
            room_name TEXT NOT NULL,
            backend_url TEXT NOT NULL DEFAULT '',
            is_active INTEGER NOT NULL DEFAULT 1,
            last_seen TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            device_token_hash TEXT,
            pairing_code_hash TEXT,
            pairing_code_display TEXT,
            pairing_expires_at TEXT,
            pairing_status TEXT NOT NULL DEFAULT 'LEGACY',
            current_ssid TEXT,
            wifi_rssi INTEGER,
            wifi_status TEXT NOT NULL DEFAULT 'UNKNOWN',
            wifi_last_error TEXT,
            wifi_updated_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS sensor_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            temperature REAL NOT NULL,
            humidity REAL NOT NULL,
            gas_raw INTEGER NOT NULL,
            light_raw INTEGER NOT NULL,
            sound_raw INTEGER NOT NULL DEFAULT 0,
            relay_on INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            recommendation TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS device_settings (
            device_id TEXT PRIMARY KEY,
            temp_warning REAL NOT NULL DEFAULT 32,
            temp_critical REAL NOT NULL DEFAULT 38,
            gas_warning INTEGER NOT NULL DEFAULT 1800,
            gas_critical INTEGER NOT NULL DEFAULT 2600,
            light_low INTEGER NOT NULL DEFAULT 1,
            upload_interval INTEGER NOT NULL DEFAULT 5,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS device_control (
            device_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL DEFAULT 'AUTO',
            relay INTEGER NOT NULL DEFAULT 0,
            buzzer INTEGER NOT NULL DEFAULT 1,
            enter_setup INTEGER NOT NULL DEFAULT 0,
            scan_wifi INTEGER NOT NULL DEFAULT 0,
            wifi_connect_ssid TEXT NOT NULL DEFAULT '',
            wifi_connect_password TEXT NOT NULL DEFAULT '',
            wifi_forget_ssid TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wifi_scan_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            ssid TEXT NOT NULL,
            rssi INTEGER,
            encryption TEXT,
            scanned_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wifi_profiles (
            device_id TEXT NOT NULL,
            ssid TEXT NOT NULL,
            last_success_at TEXT,
            failure_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (device_id, ssid)
        );

        CREATE TABLE IF NOT EXISTS device_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )

    for column, definition in {
        "invite_code_label": "TEXT",
    }.items():
        ensure_column(db, "users", column, definition)

    for code, max_uses in DEFAULT_INVITE_CODES.items():
        db.execute(
            """
            INSERT OR IGNORE INTO invite_codes (
                code_label, code_hash, max_uses, use_count, is_active, created_at
            )
            VALUES (?, ?, ?, 0, 1, ?)
            """,
            (code, generate_password_hash(code), max_uses, utc_now()),
        )
    db.execute(
        """
        UPDATE invite_codes
        SET use_count = (
            SELECT COUNT(*) FROM users
            WHERE users.invite_code_label = invite_codes.code_label
        )
        """
    )

    for column, definition in {
        "sound_raw": "INTEGER NOT NULL DEFAULT 0",
        "relay_on": "INTEGER NOT NULL DEFAULT 0",
    }.items():
        ensure_column(db, "sensor_data", column, definition)

    for column, definition in {
        "enter_setup": "INTEGER NOT NULL DEFAULT 0",
        "scan_wifi": "INTEGER NOT NULL DEFAULT 0",
        "wifi_connect_ssid": "TEXT NOT NULL DEFAULT ''",
        "wifi_connect_password": "TEXT NOT NULL DEFAULT ''",
        "wifi_forget_ssid": "TEXT NOT NULL DEFAULT ''",
    }.items():
        ensure_column(db, "device_control", column, definition)

    for column, definition in {
        "backend_url": "TEXT NOT NULL DEFAULT ''",
        "last_seen": "TEXT",
        "is_active": "INTEGER NOT NULL DEFAULT 1",
        "device_token_hash": "TEXT",
        "pairing_code_hash": "TEXT",
        "pairing_code_display": "TEXT",
        "pairing_expires_at": "TEXT",
        "pairing_status": "TEXT NOT NULL DEFAULT 'LEGACY'",
        "current_ssid": "TEXT",
        "wifi_rssi": "INTEGER",
        "wifi_status": "TEXT NOT NULL DEFAULT 'UNKNOWN'",
        "wifi_last_error": "TEXT",
        "wifi_updated_at": "TEXT",
    }.items():
        ensure_column(db, "devices", column, definition)

    db.execute("UPDATE device_settings SET light_low = 1 WHERE light_low NOT IN (0, 1)")
    db.execute(
        "UPDATE device_settings SET upload_interval = 5 "
        "WHERE upload_interval IS NULL OR upload_interval = 15 OR upload_interval < 1"
    )
    db.execute("UPDATE devices SET backend_url = ? WHERE backend_url = '' OR backend_url IS NULL", (DEFAULT_BACKEND_URL,))
    ensure_device_defaults(db, DEFAULT_DEVICE_ID)
    db.commit()
    db.close()


def ensure_column(db: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def ensure_device_defaults(db: sqlite3.Connection, device_id: str) -> None:
    now = utc_now()
    db.execute(
        """
        INSERT OR IGNORE INTO devices (
            device_id, user_id, device_name, room_name, backend_url, pairing_status, created_at, updated_at
        )
        VALUES (?, NULL, ?, ?, ?, 'LEGACY', ?, ?)
        """,
        (device_id, "Smart Room Sensor", "Living Room", DEFAULT_BACKEND_URL, now, now),
    )
    db.execute(
        "INSERT OR IGNORE INTO device_settings (device_id, updated_at) VALUES (?, ?)",
        (device_id, now),
    )
    db.execute(
        "INSERT OR IGNORE INTO device_control (device_id, updated_at) VALUES (?, ?)",
        (device_id, now),
    )


def add_event(db: sqlite3.Connection, device_id: str, event_type: str, message: str) -> None:
    db.execute(
        "INSERT INTO device_events (device_id, event_type, message, created_at) VALUES (?, ?, ?, ?)",
        (device_id, event_type, message, utc_now()),
    )


def login_required(view: F) -> F:
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required"}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped  # type: ignore[return-value]


def current_user_id() -> int:
    user_id = session.get("user_id")
    if not user_id:
        raise RuntimeError("No user in session")
    return int(user_id)


def claim_default_device_for_user(db: sqlite3.Connection, user_id: int) -> None:
    # Kept for older sessions, but new commercial onboarding should start with
    # an explicit Add Device pairing flow instead of auto-claiming ESP32_ROOM_01.
    db.commit()


def get_owned_device_or_404(device_id: str) -> sqlite3.Row | tuple[dict, int]:
    row = get_db().execute(
        "SELECT * FROM devices WHERE device_id = ? AND user_id = ? AND is_active = 1",
        (device_id, current_user_id()),
    ).fetchone()
    if row is None:
        return {"error": "Device not found"}, 404
    return row


def token_from_request() -> str:
    return request.headers.get("X-Device-Token", "") or (request.get_json(silent=True) or {}).get("device_token", "")


def validate_device_token(db: sqlite3.Connection, device_id: str, token: str) -> tuple[sqlite3.Row | None, tuple[dict, int] | None]:
    row = db.execute("SELECT * FROM devices WHERE device_id = ? AND is_active = 1", (device_id,)).fetchone()
    if row is None:
        return None, ({"error": "Unknown device"}, 404)
    token_hash = row["device_token_hash"]
    if token_hash and (not token or not check_password_hash(token_hash, token)):
        return None, ({"error": "Invalid device token"}, 401)
    return row, None


@app.route("/")
@login_required
def dashboard():
    return render_template("dashboard.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        row = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if row and check_password_hash(row["password_hash"], password):
            session.clear()
            session["user_id"] = row["id"]
            session["user_name"] = row["name"]
            claim_default_device_for_user(get_db(), row["id"])
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Invalid email or password.", email=email)
    return render_template("login.html")


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")
        invite_code = request.form.get("invite_code", "").strip()
        error = None
        if not name or not email:
            error = "Enter a name and valid email."
        error = error or password_error(password, confirm_password)
        db = get_db()
        invite_row = None
        if not error:
            error, invite_row = invite_code_error(db, invite_code)
        if error:
            return render_template("register.html", error=error, name=name, email=email, invite_code=invite_code)

        try:
            cursor = db.execute(
                """
                INSERT INTO users (name, email, password_hash, invite_code_label, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (name, email, generate_password_hash(password), invite_row["code_label"], utc_now()),
            )
            db.execute(
                "UPDATE invite_codes SET use_count = use_count + 1 WHERE id = ?",
                (invite_row["id"],),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return render_template("register.html", error="This email is already registered.", name=name, email=email, invite_code=invite_code)

        user_id = int(cursor.lastrowid)
        session.clear()
        session["user_id"] = user_id
        session["user_name"] = name
        claim_default_device_for_user(db, user_id)
        return redirect(url_for("dashboard"))
    return render_template("register.html")


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.post("/api/device-pair")
def pair_device():
    data = request.get_json(silent=True) or {}
    pairing_code = str(data.get("pairing_code", "")).strip()
    if not pairing_code:
        return jsonify({"error": "Pairing code is required"}), 400

    db = get_db()
    rows = db.execute(
        """
        SELECT * FROM devices
        WHERE pairing_status = 'WAITING' AND pairing_code_hash IS NOT NULL AND is_active = 1
        """
    ).fetchall()
    now_dt = datetime.now(timezone.utc)
    for row in rows:
        expires = parse_utc(row["pairing_expires_at"])
        if expires and now_dt > expires:
            db.execute(
                """
                UPDATE devices
                SET pairing_status = 'PAIRING_EXPIRED', pairing_code_display = NULL,
                    updated_at = ?
                WHERE device_id = ?
                """,
                (utc_now(), row["device_id"]),
            )
            continue
        if check_password_hash(row["pairing_code_hash"], pairing_code):
            device_token = generate_device_token()
            db.execute(
                """
                UPDATE devices
                SET device_token_hash = ?, pairing_code_hash = NULL,
                    pairing_code_display = NULL, pairing_status = 'PAIRED',
                    backend_url = ?, updated_at = ?
                WHERE device_id = ?
                """,
                (generate_password_hash(device_token), DEFAULT_BACKEND_URL, utc_now(), row["device_id"]),
            )
            add_event(db, row["device_id"], "paired", "Device paired successfully.")
            db.commit()
            return jsonify(
                {
                    "ok": True,
                    "device_id": row["device_id"],
                    "device_token": device_token,
                    "backend_url": DEFAULT_BACKEND_URL,
                }
            )
    db.commit()
    return jsonify({"error": "Invalid or expired pairing code"}), 404


@app.post("/api/sensor-data")
def create_sensor_data():
    data = request.get_json(silent=True) or {}
    required = ["device_id", "temperature", "humidity", "gas_raw", "light_raw", "status"]
    missing = [field for field in required if field not in data]
    if missing:
        return jsonify({"error": "Missing fields", "fields": missing}), 400

    device_id = normalize_device_id(str(data["device_id"]))
    db = get_db()
    row = db.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    if row is None:
        ensure_device_defaults(db, device_id)
        row = db.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    _device, error = validate_device_token(db, device_id, token_from_request())
    if error:
        return jsonify(error[0]), error[1]

    now = utc_now()
    db.execute(
        """
        INSERT INTO sensor_data (
            device_id, temperature, humidity, gas_raw, light_raw, sound_raw, relay_on,
            status, recommendation, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            device_id,
            float(data["temperature"]),
            float(data["humidity"]),
            int(data["gas_raw"]),
            int(data["light_raw"]),
            int(data.get("sound_raw", 0)),
            int(data.get("relay_on", 0)),
            str(data["status"]),
            str(data.get("recommendation", "")),
            now,
        ),
    )
    db.execute(
        """
        UPDATE devices
        SET last_seen = ?, updated_at = ?, pairing_status = CASE
            WHEN pairing_status IN ('WAITING', 'PAIRING_EXPIRED') THEN 'PAIRED'
            ELSE pairing_status
        END,
            pairing_code_display = CASE
            WHEN pairing_status IN ('WAITING', 'PAIRING_EXPIRED') THEN NULL
            ELSE pairing_code_display
        END
        WHERE device_id = ?
        """,
        (now, now, device_id),
    )
    db.commit()
    return jsonify({"ok": True}), 201


@app.get("/api/me")
@login_required
def me():
    return jsonify({"id": current_user_id(), "name": session.get("user_name", "User")})


@app.get("/api/devices")
@login_required
def list_devices():
    rows = get_db().execute(
        """
        SELECT
            d.*,
            sd.status AS latest_status,
            sd.created_at AS latest_reading_at
        FROM devices d
        LEFT JOIN sensor_data sd ON sd.id = (
            SELECT id FROM sensor_data WHERE device_id = d.device_id ORDER BY id DESC LIMIT 1
        )
        WHERE d.user_id = ? AND d.is_active = 1
        ORDER BY d.room_name, d.device_name
        """,
        (current_user_id(),),
    ).fetchall()
    devices = []
    db = get_db()
    for row in rows:
        item = row_to_dict(row) or {}
        item["connection_state"] = device_state(row)
        if item["connection_state"] == "PAIRING_EXPIRED" and row["pairing_status"] == "WAITING":
            db.execute(
                """
                UPDATE devices
                SET pairing_status = 'PAIRING_EXPIRED', pairing_code_display = NULL,
                    updated_at = ?
                WHERE device_id = ?
                """,
                (utc_now(), row["device_id"]),
            )
            item["pairing_code"] = None
        elif item["connection_state"] == "WAITING_FOR_SETUP":
            item["pairing_code"] = row["pairing_code_display"]
        else:
            item["pairing_code"] = None
        item.pop("pairing_code_display", None)
        devices.append(item)
    db.commit()
    return jsonify(devices)


@app.post("/api/devices")
@login_required
def add_device():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id") or generate_device_id()))
    device_name = str(data.get("device_name", "Smart Room Sensor")).strip()[:80] or "Smart Room Sensor"
    room_name = str(data.get("room_name", "Living Room")).strip()[:80] or "Living Room"
    pairing_code = generate_pairing_code()
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=PAIRING_MINUTES)).isoformat(timespec="seconds")
    db = get_db()
    now = utc_now()
    existing = db.execute("SELECT user_id FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    if existing and existing["user_id"] not in (None, current_user_id()):
        return jsonify({"error": "This device is already assigned to another user"}), 409
    ensure_device_defaults(db, device_id)
    db.execute(
        """
        UPDATE devices
        SET user_id = ?, device_name = ?, room_name = ?, backend_url = ?,
            pairing_code_hash = ?, pairing_code_display = ?, pairing_expires_at = ?, pairing_status = 'WAITING',
            device_token_hash = NULL, updated_at = ?, is_active = 1
        WHERE device_id = ?
        """,
        (
            current_user_id(),
            device_name,
            room_name,
            DEFAULT_BACKEND_URL,
            generate_password_hash(pairing_code),
            pairing_code,
            expires_at,
            now,
            device_id,
        ),
    )
    add_event(db, device_id, "pairing_created", "Pairing code generated.")
    db.commit()
    return jsonify(
        {
            "ok": True,
            "device_id": device_id,
            "pairing_code": pairing_code,
            "pairing_expires_at": expires_at,
            "backend_url": DEFAULT_BACKEND_URL,
        }
    ), 201


@app.patch("/api/devices/<device_id>")
@login_required
def update_device(device_id: str):
    normalized = normalize_device_id(device_id)
    device = get_owned_device_or_404(normalized)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    data = request.get_json(silent=True) or {}
    device_name = str(data.get("device_name", device["device_name"])).strip()[:80] or device["device_name"]
    room_name = str(data.get("room_name", device["room_name"])).strip()[:80] or device["room_name"]
    get_db().execute(
        "UPDATE devices SET device_name = ?, room_name = ?, updated_at = ? WHERE device_id = ?",
        (device_name, room_name, utc_now(), normalized),
    )
    get_db().commit()
    return jsonify({"ok": True})


@app.delete("/api/devices/<device_id>")
@login_required
def delete_device(device_id: str):
    normalized = normalize_device_id(device_id)
    device = get_owned_device_or_404(normalized)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    now = utc_now()
    get_db().execute(
        """
        UPDATE devices
        SET is_active = 0, pairing_code_hash = NULL, pairing_code_display = NULL,
            pairing_status = 'REMOVED',
            device_token_hash = NULL, updated_at = ?
        WHERE device_id = ? AND user_id = ?
        """,
        (now, normalized, current_user_id()),
    )
    get_db().commit()
    return jsonify({"ok": True})


@app.get("/api/latest")
@login_required
def latest():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    row = get_db().execute(
        "SELECT * FROM sensor_data WHERE device_id = ? ORDER BY id DESC LIMIT 1",
        (device_id,),
    ).fetchone()
    result = row_to_dict(row) or {}
    connection_state = device_state(device)
    result["connection_state"] = connection_state
    result.update(latest_insights(result, settings_for_device(get_db(), device_id), connection_state))
    return jsonify(result)


@app.get("/api/history")
@login_required
def history():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    limit = min(int(request.args.get("limit", 200)), 1000)
    where, params = history_filter(device_id)
    rows = get_db().execute(
        f"SELECT * FROM sensor_data WHERE {where} ORDER BY id DESC LIMIT ?",
        (*params, limit),
    ).fetchall()
    return jsonify([row_to_dict(row) for row in reversed(rows)])


@app.get("/api/history/export.csv")
@login_required
def export_history():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    where, params = history_filter(device_id)
    rows = get_db().execute(
        f"SELECT * FROM sensor_data WHERE {where} ORDER BY id DESC LIMIT 5000",
        params,
    ).fetchall()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["created_at", "temperature", "humidity", "gas_raw", "light_raw", "sound_raw", "relay_on", "status", "recommendation"])
    for row in rows:
        writer.writerow(
            [
                row["created_at"],
                row["temperature"],
                row["humidity"],
                row["gas_raw"],
                row["light_raw"],
                row["sound_raw"],
                row["relay_on"],
                row["status"],
                row["recommendation"],
            ]
        )
    filename = f"{device_id.lower()}-history.csv"
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.get("/api/summary")
@login_required
def summary():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    result = summary_for_device(get_db(), device_id)
    last_seen = parse_utc(device["last_seen"])
    result["offline_seconds"] = int((datetime.now(timezone.utc) - last_seen).total_seconds()) if last_seen else None
    result.update(health_from(device, result))
    return jsonify(result)


@app.get("/api/alerts")
@login_required
def alerts():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    db = get_db()
    sensor_rows = db.execute(
        """
        SELECT status AS event_type, recommendation AS message, created_at
        FROM sensor_data
        WHERE device_id = ? AND status IN ('WARNING', 'CRITICAL')
        ORDER BY id DESC
        LIMIT 12
        """,
        (device_id,),
    ).fetchall()
    event_rows = db.execute(
        """
        SELECT event_type, message, created_at
        FROM device_events
        WHERE device_id = ?
        ORDER BY id DESC
        LIMIT 12
        """,
        (device_id,),
    ).fetchall()
    items = [row_to_dict(row) for row in sensor_rows] + [row_to_dict(row) for row in event_rows]
    items = [item for item in items if item]
    items.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return jsonify(items[:16])


@app.get("/api/summary/export.csv")
@login_required
def export_summary():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    result = summary_for_device(get_db(), device_id)
    result.update(health_from(device, result))
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["metric", "value"])
    writer.writerow(["device_id", device_id])
    writer.writerow(["room_name", device["room_name"]])
    writer.writerow(["health_label", result.get("health_label")])
    writer.writerow(["health_score", result.get("health_score")])
    for key in [
        "total_records",
        "avg_temperature",
        "avg_humidity",
        "highest_gas",
        "highest_sound",
        "sound_trigger_count",
        "warning_count",
        "critical_count",
    ]:
        writer.writerow([key, result.get(key)])
    filename = f"{device_id.lower()}-summary.csv"
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.get("/api/settings")
@login_required
def get_settings():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    ensure_device_defaults(get_db(), device_id)
    row = get_db().execute("SELECT * FROM device_settings WHERE device_id = ?", (device_id,)).fetchone()
    return jsonify(row_to_dict(row) or {})


@app.post("/api/settings")
@login_required
def update_settings():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id", DEFAULT_DEVICE_ID)))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    db = get_db()
    db.execute(
        """
        INSERT INTO device_settings (
            device_id, temp_warning, temp_critical, gas_warning, gas_critical,
            light_low, upload_interval, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            temp_warning = excluded.temp_warning,
            temp_critical = excluded.temp_critical,
            gas_warning = excluded.gas_warning,
            gas_critical = excluded.gas_critical,
            light_low = excluded.light_low,
            upload_interval = excluded.upload_interval,
            updated_at = excluded.updated_at
        """,
        (
            device_id,
            float(data.get("temp_warning", 32)),
            float(data.get("temp_critical", 38)),
            int(data.get("gas_warning", 1800)),
            int(data.get("gas_critical", 2600)),
            1 if int(data.get("light_low", 1)) == 1 else 0,
            max(1, min(int(data.get("upload_interval", 5)), 120)),
            utc_now(),
        ),
    )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/control")
@login_required
def get_control():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    row = get_db().execute("SELECT * FROM device_control WHERE device_id = ?", (device_id,)).fetchone()
    return jsonify(row_to_dict(row) or {})


@app.post("/api/control")
@login_required
def update_control():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id", DEFAULT_DEVICE_ID)))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    mode = str(data.get("mode", "AUTO")).upper()
    if mode not in {"AUTO", "MANUAL"}:
        return jsonify({"error": "mode must be AUTO or MANUAL"}), 400

    db = get_db()
    db.execute(
        """
        INSERT INTO device_control (device_id, mode, relay, buzzer, enter_setup, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            mode = excluded.mode,
            relay = excluded.relay,
            buzzer = excluded.buzzer,
            enter_setup = excluded.enter_setup,
            updated_at = excluded.updated_at
        """,
        (
            device_id,
            mode,
            1 if data.get("relay") else 0,
            1 if data.get("buzzer", True) else 0,
            1 if data.get("enter_setup") else 0,
            utc_now(),
        ),
    )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/wifi/status")
@login_required
def wifi_status():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    db = get_db()
    scans = db.execute(
        "SELECT ssid, rssi, encryption, scanned_at FROM wifi_scan_results WHERE device_id = ? ORDER BY rssi DESC",
        (device_id,),
    ).fetchall()
    profiles = db.execute(
        "SELECT ssid, last_success_at, failure_count, updated_at FROM wifi_profiles WHERE device_id = ? ORDER BY updated_at DESC",
        (device_id,),
    ).fetchall()
    events = db.execute(
        "SELECT event_type, message, created_at FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 10",
        (device_id,),
    ).fetchall()
    return jsonify(
        {
            "current_ssid": device["current_ssid"],
            "wifi_rssi": device["wifi_rssi"],
            "wifi_status": device["wifi_status"],
            "wifi_last_error": device["wifi_last_error"],
            "wifi_updated_at": device["wifi_updated_at"],
            "scan_results": [row_to_dict(row) for row in scans],
            "saved_profiles": [row_to_dict(row) for row in profiles],
            "events": [row_to_dict(row) for row in events],
        }
    )


@app.post("/api/wifi/scan")
@login_required
def request_wifi_scan():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id", DEFAULT_DEVICE_ID)))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    get_db().execute(
        """
        INSERT INTO device_control (device_id, scan_wifi, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(device_id) DO UPDATE SET scan_wifi = 1, updated_at = excluded.updated_at
        """,
        (device_id, utc_now()),
    )
    add_event(get_db(), device_id, "wifi_scan_requested", "WiFi scan requested from dashboard.")
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/wifi/connect")
@login_required
def request_wifi_connect():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id", DEFAULT_DEVICE_ID)))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    ssid = str(data.get("ssid", "")).strip()
    password = str(data.get("password", ""))
    if not ssid:
        return jsonify({"error": "SSID is required"}), 400
    get_db().execute(
        """
        INSERT INTO device_control (device_id, wifi_connect_ssid, wifi_connect_password, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            wifi_connect_ssid = excluded.wifi_connect_ssid,
            wifi_connect_password = excluded.wifi_connect_password,
            updated_at = excluded.updated_at
        """,
        (device_id, ssid, password, utc_now()),
    )
    add_event(get_db(), device_id, "wifi_connect_requested", f"WiFi switch requested for {ssid}.")
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/wifi/reconnect")
@login_required
def request_wifi_reconnect():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id", DEFAULT_DEVICE_ID)))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    ssid = str(data.get("ssid", "")).strip()
    if not ssid:
        return jsonify({"error": "SSID is required"}), 400
    get_db().execute(
        """
        INSERT INTO device_control (device_id, wifi_connect_ssid, wifi_connect_password, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            wifi_connect_ssid = excluded.wifi_connect_ssid,
            wifi_connect_password = excluded.wifi_connect_password,
            updated_at = excluded.updated_at
        """,
        (device_id, ssid, SAVED_WIFI_PASSWORD_MARKER, utc_now()),
    )
    add_event(get_db(), device_id, "wifi_reconnect_requested", f"Reconnect requested for saved WiFi {ssid}.")
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/wifi/forget")
@login_required
def request_wifi_forget():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id", DEFAULT_DEVICE_ID)))
    device = get_owned_device_or_404(device_id)
    if isinstance(device, tuple):
        return jsonify(device[0]), device[1]
    ssid = str(data.get("ssid", "")).strip()
    if not ssid:
        return jsonify({"error": "SSID is required"}), 400
    get_db().execute(
        """
        INSERT INTO device_control (device_id, wifi_forget_ssid, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET wifi_forget_ssid = excluded.wifi_forget_ssid, updated_at = excluded.updated_at
        """,
        (device_id, ssid, utc_now()),
    )
    get_db().execute("DELETE FROM wifi_profiles WHERE device_id = ? AND ssid = ?", (device_id, ssid))
    add_event(get_db(), device_id, "wifi_forget_requested", f"Forget WiFi requested for {ssid}.")
    get_db().commit()
    return jsonify({"ok": True})


@app.post("/api/device-status")
def device_status_update():
    data = request.get_json(silent=True) or {}
    device_id = normalize_device_id(str(data.get("device_id", DEFAULT_DEVICE_ID)))
    db = get_db()
    _device, error = validate_device_token(db, device_id, token_from_request())
    if error:
        return jsonify(error[0]), error[1]

    now = utc_now()
    current_ssid = str(data.get("current_ssid", "")).strip() or None
    wifi_status_value = str(data.get("wifi_status", "UNKNOWN")).strip().upper()[:40] or "UNKNOWN"
    wifi_last_error = str(data.get("wifi_last_error", "")).strip()[:160] or None
    wifi_rssi = data.get("wifi_rssi")
    db.execute(
        """
        UPDATE devices
        SET current_ssid = COALESCE(?, current_ssid),
            wifi_rssi = ?,
            wifi_status = ?,
            wifi_last_error = ?,
            wifi_updated_at = ?,
            updated_at = ?
        WHERE device_id = ?
        """,
        (current_ssid, int(wifi_rssi) if wifi_rssi not in (None, "") else None, wifi_status_value, wifi_last_error, now, now, device_id),
    )

    if current_ssid and wifi_status_value == "CONNECTED":
        db.execute(
            """
            INSERT INTO wifi_profiles (device_id, ssid, last_success_at, failure_count, updated_at)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(device_id, ssid) DO UPDATE SET
                last_success_at = excluded.last_success_at,
                failure_count = 0,
                updated_at = excluded.updated_at
            """,
            (device_id, current_ssid, now, now),
        )

    if wifi_status_value in {"CONNECT_FAILED", "SWITCH_FAILED"} and current_ssid:
        db.execute(
            """
            INSERT INTO wifi_profiles (device_id, ssid, failure_count, updated_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(device_id, ssid) DO UPDATE SET
                failure_count = failure_count + 1,
                updated_at = excluded.updated_at
            """,
            (device_id, current_ssid, now),
        )

    if "networks" in data and isinstance(data.get("networks"), list):
        networks = data.get("networks") or []
        db.execute("DELETE FROM wifi_scan_results WHERE device_id = ?", (device_id,))
        for network in networks[:30]:
            if not isinstance(network, dict):
                continue
            ssid = str(network.get("ssid", "")).strip()
            if not ssid:
                continue
            db.execute(
                """
                INSERT INTO wifi_scan_results (device_id, ssid, rssi, encryption, scanned_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    device_id,
                    ssid[:80],
                    int(network.get("rssi", 0)),
                    str(network.get("encryption", ""))[:40],
                    now,
                ),
            )
        if networks:
            add_event(db, device_id, "wifi_scan_result", f"Received {len(networks)} WiFi networks.")

    event_type = str(data.get("event_type", "")).strip()
    event_message = str(data.get("event_message", "")).strip()
    if event_type and event_message:
        add_event(db, device_id, event_type[:60], event_message[:200])

    db.commit()
    return jsonify({"ok": True})


@app.get("/api/device-command")
def device_command():
    device_id = normalize_device_id(request.args.get("device_id", DEFAULT_DEVICE_ID))
    db = get_db()
    ensure_device_defaults(db, device_id)
    _device, error = validate_device_token(db, device_id, token_from_request())
    if error:
        return jsonify(error[0]), error[1]

    settings = db.execute("SELECT * FROM device_settings WHERE device_id = ?", (device_id,)).fetchone()
    control = db.execute("SELECT * FROM device_control WHERE device_id = ?", (device_id,)).fetchone()

    settings_dict = row_to_dict(settings) or {}
    control_dict = row_to_dict(control) or {}

    lines = [
        f"mode={control_dict.get('mode', 'AUTO')}",
        f"relay={control_dict.get('relay', 0)}",
        f"buzzer={control_dict.get('buzzer', 1)}",
        f"enter_setup={control_dict.get('enter_setup', 0)}",
        f"wifi_scan={control_dict.get('scan_wifi', 0)}",
        f"wifi_ssid={control_dict.get('wifi_connect_ssid', '')}",
        f"wifi_password={control_dict.get('wifi_connect_password', '')}",
        f"wifi_forget={control_dict.get('wifi_forget_ssid', '')}",
        f"temp_warning={settings_dict.get('temp_warning', 32)}",
        f"temp_critical={settings_dict.get('temp_critical', 38)}",
        f"gas_warning={settings_dict.get('gas_warning', 1800)}",
        f"gas_critical={settings_dict.get('gas_critical', 2600)}",
        f"light_low={settings_dict.get('light_low', 1)}",
        f"ldr_dark_state={digital_label(settings_dict.get('light_low', 1))}",
        f"upload_interval={settings_dict.get('upload_interval', 5)}",
    ]
    if any(
        [
            int(control_dict.get("enter_setup", 0)) == 1,
            int(control_dict.get("scan_wifi", 0)) == 1,
            control_dict.get("wifi_connect_ssid"),
            control_dict.get("wifi_forget_ssid"),
        ]
    ):
        db.execute(
            """
            UPDATE device_control
            SET enter_setup = 0, scan_wifi = 0, wifi_connect_ssid = '',
                wifi_connect_password = '', wifi_forget_ssid = '', updated_at = ?
            WHERE device_id = ?
            """,
            (utc_now(), device_id),
        )
        db.commit()
    return "\n".join(lines) + "\n", 200, {"Content-Type": "text/plain; charset=utf-8"}


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)

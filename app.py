from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "smart_room.db"

app = Flask(__name__)


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


def init_db() -> None:
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS sensor_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            temperature REAL NOT NULL,
            humidity REAL NOT NULL,
            gas_raw INTEGER NOT NULL,
            light_raw INTEGER NOT NULL,
            sound_raw INTEGER NOT NULL DEFAULT 0,
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
            updated_at TEXT NOT NULL
        );
        """
    )
    columns = {
        row[1]
        for row in db.execute("PRAGMA table_info(sensor_data)").fetchall()
    }
    if "sound_raw" not in columns:
        db.execute("ALTER TABLE sensor_data ADD COLUMN sound_raw INTEGER NOT NULL DEFAULT 0")
    db.execute("UPDATE device_settings SET light_low = 0 WHERE light_low NOT IN (0, 1)")
    db.execute("UPDATE device_settings SET upload_interval = 5 WHERE upload_interval IS NULL OR upload_interval = 15 OR upload_interval < 1")
    now = utc_now()
    db.execute(
        """
        INSERT OR IGNORE INTO device_settings (device_id, updated_at)
        VALUES (?, ?)
        """,
        ("ESP32_ROOM_01", now),
    )
    db.execute(
        """
        INSERT OR IGNORE INTO device_control (device_id, updated_at)
        VALUES (?, ?)
        """,
        ("ESP32_ROOM_01", now),
    )
    db.commit()
    db.close()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def digital_label(value: int | str | None) -> str:
    return "HIGH" if int(value or 0) == 1 else "LOW"


@app.route("/")
def dashboard():
    return render_template("dashboard.html")


@app.post("/api/sensor-data")
def create_sensor_data():
    data = request.get_json(silent=True) or {}
    required = ["device_id", "temperature", "humidity", "gas_raw", "light_raw", "status"]
    missing = [field for field in required if field not in data]
    if missing:
        return jsonify({"error": "Missing fields", "fields": missing}), 400

    db = get_db()
    db.execute(
        """
        INSERT INTO sensor_data (
            device_id, temperature, humidity, gas_raw, light_raw, sound_raw,
            status, recommendation, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(data["device_id"]),
            float(data["temperature"]),
            float(data["humidity"]),
            int(data["gas_raw"]),
            int(data["light_raw"]),
            int(data.get("sound_raw", 0)),
            str(data["status"]),
            str(data.get("recommendation", "")),
            utc_now(),
        ),
    )
    db.commit()
    return jsonify({"ok": True}), 201


@app.get("/api/latest")
def latest():
    row = get_db().execute(
        "SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return jsonify(row_to_dict(row) or {})


@app.get("/api/history")
def history():
    limit = min(int(request.args.get("limit", 200)), 200)
    rows = get_db().execute(
        "SELECT * FROM sensor_data ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return jsonify([row_to_dict(row) for row in reversed(rows)])


@app.get("/api/summary")
def summary():
    row = get_db().execute(
        """
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
        """
    ).fetchone()
    return jsonify(row_to_dict(row) or {})


@app.get("/api/settings")
def get_settings():
    device_id = request.args.get("device_id", "ESP32_ROOM_01")
    row = get_db().execute(
        "SELECT * FROM device_settings WHERE device_id = ?",
        (device_id,),
    ).fetchone()
    return jsonify(row_to_dict(row) or {})


@app.post("/api/settings")
def update_settings():
    data = request.get_json(silent=True) or {}
    device_id = str(data.get("device_id", "ESP32_ROOM_01"))
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
            1 if int(data.get("light_low", 0)) == 1 else 0,
            max(1, min(int(data.get("upload_interval", 5)), 120)),
            utc_now(),
        ),
    )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/control")
def get_control():
    device_id = request.args.get("device_id", "ESP32_ROOM_01")
    row = get_db().execute(
        "SELECT * FROM device_control WHERE device_id = ?",
        (device_id,),
    ).fetchone()
    return jsonify(row_to_dict(row) or {})


@app.post("/api/control")
def update_control():
    data = request.get_json(silent=True) or {}
    device_id = str(data.get("device_id", "ESP32_ROOM_01"))
    mode = str(data.get("mode", "AUTO")).upper()
    if mode not in {"AUTO", "MANUAL"}:
        return jsonify({"error": "mode must be AUTO or MANUAL"}), 400

    db = get_db()
    db.execute(
        """
        INSERT INTO device_control (device_id, mode, relay, buzzer, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
            mode = excluded.mode,
            relay = excluded.relay,
            buzzer = excluded.buzzer,
            updated_at = excluded.updated_at
        """,
        (
            device_id,
            mode,
            1 if data.get("relay") else 0,
            1 if data.get("buzzer", True) else 0,
            utc_now(),
        ),
    )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/device-command")
def device_command():
    device_id = request.args.get("device_id", "ESP32_ROOM_01")
    db = get_db()
    settings = db.execute(
        "SELECT * FROM device_settings WHERE device_id = ?",
        (device_id,),
    ).fetchone()
    control = db.execute(
        "SELECT * FROM device_control WHERE device_id = ?",
        (device_id,),
    ).fetchone()

    settings_dict = row_to_dict(settings) or {}
    control_dict = row_to_dict(control) or {}

    lines = [
        f"mode={control_dict.get('mode', 'AUTO')}",
        f"relay={control_dict.get('relay', 0)}",
        f"buzzer={control_dict.get('buzzer', 1)}",
        f"temp_warning={settings_dict.get('temp_warning', 32)}",
        f"temp_critical={settings_dict.get('temp_critical', 38)}",
        f"gas_warning={settings_dict.get('gas_warning', 1800)}",
        f"gas_critical={settings_dict.get('gas_critical', 2600)}",
        f"light_low={settings_dict.get('light_low', 0)}",
        f"ldr_dark_state={digital_label(settings_dict.get('light_low', 0))}",
        f"upload_interval={settings_dict.get('upload_interval', 5)}",
    ]
    return "\n".join(lines) + "\n", 200, {"Content-Type": "text/plain; charset=utf-8"}


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)

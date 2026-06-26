# Smart Room Safety & Comfort Monitoring System

ESP32-based IoT prototype for monitoring room safety and comfort conditions. The system reads temperature, humidity, gas, light and sound signals, shows local status on an OLED display, sends readings to a Flask backend, stores data in SQLite and provides a web dashboard for live monitoring, history and actuator control.

## Features

- Register and login for dashboard users, with password validation
- Multi-device dashboard with pairing-code onboarding
- Live dashboard for latest sensor readings
- Room status classification: `NORMAL`, `WARNING` and `CRITICAL`
- Historical charts for temperature, gas, light and sound
- CSV export for stored sensor history
- SQLite storage with recent data table and summary values
- AUTO and MANUAL control for relay and buzzer output
- Settings drawer for room name, device name, thresholds, LDR dark state and upload interval
- ESP32 captive setup portal for Wi-Fi and pairing code configuration
- Remote WiFi scan, WiFi switch and saved-profile display from the cloud dashboard
- ESP32 OLED display with sensor, status and connection pages
- Push button for changing OLED pages and long-press Wi-Fi setup reset

## Project Structure

```text
.
├── app.py                         Flask API and SQLite backend
├── requirements.txt               Python dependencies
├── SmartRoomSafetyComfort/        ESP32 Arduino sketch
├── static/                        Dashboard CSS and JavaScript
├── templates/                     Flask HTML template
├── circuit/                       Fritzing circuit source and exported diagram image
└── screenshots/                   Dashboard or testing screenshots
```

Generated files such as `smart_room.db`, `logs/`, `.venv/` and `report/` are ignored by Git.

## Hardware

| Component | Connection / Pin |
|---|---|
| ESP32 30-pin Type-C | Main controller |
| OLED SSD1306 | SDA GPIO21, SCL GPIO22, VCC 3.3V, GND |
| DHT11 | OUT GPIO4, VCC 3.3V, GND |
| MQ-2 smoke and gas sensor | AO GPIO34, VCC 5V, GND |
| LDR light sensor module | DO GPIO35, VCC 3.3V, GND |
| Sound sensor module | OUT GPIO32, VCC 3.3V, GND |
| Push button | GPIO27 to GND, uses `INPUT_PULLUP` |
| Active buzzer | GPIO26, GND |
| 1-channel relay module | IN GPIO14, VCC 3.3V, GND |

The relay load should be connected through `COM` and `NO` so the fan or output device stays off by default and turns on only when the relay is activated.

## Power Rails

| Rail | Use |
|---|---|
| 3.3V | OLED, DHT11, LDR, sound sensor and relay |
| 5V/VIN | MQ-2 gas sensor |
| GND | Common ground for all modules |

The relay module was powered from 3.3V in the final prototype because it switched more reliably with the ESP32 GPIO14 output.

The Fritzing source file and exported circuit image are stored in `circuit/`.

## Arduino Setup

Install these libraries from Arduino IDE Library Manager:

- Adafruit SSD1306
- Adafruit GFX Library
- DHT sensor library
- Adafruit Unified Sensor

Use `ESP32 Dev Module` or an equivalent ESP32 DevKit board in Arduino IDE.

The Arduino sketch no longer stores a fixed Wi-Fi SSID, password or laptop IP address in code. On first boot, or after a long press on the push button, the ESP32 starts a setup Wi-Fi network.

1. Upload `SmartRoomSafetyComfort/SmartRoomSafetyComfort.ino`.
2. Open the cloud dashboard at `https://smartroomsafety.shiebindev.com`.
3. Register or login, then click **Add Device**.
4. Copy the pairing code shown by the dashboard.
5. Connect a phone or laptop to the ESP32 setup WiFi, for example `SmartRoom-Setup-xxxx`.
6. The captive portal should open automatically. If it does not, open `http://192.168.4.1`.
7. Select the home WiFi, enter the WiFi password and enter the pairing code.
8. Save and let the ESP32 restart.

The ESP32 sends the pairing code to the Cloudflare backend:

```text
https://smartroomsafety.shiebindev.com
```

After successful pairing, the backend returns the device ID and device token. The ESP32 saves WiFi credentials and device credentials in flash memory using `Preferences`, so the user only needs to configure it once unless the WiFi changes.

## Dashboard Backend

Run the Flask backend from this folder:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Open the local dashboard:

```text
http://localhost:5000
```

For a public or long-running demo, set a Flask secret key before starting the server:

```powershell
$env:SMARTROOM_SECRET_KEY="change-this-to-a-long-random-value"
$env:SMARTROOM_BACKEND_URL="https://smartroomsafety.shiebindev.com"
python app.py
```

For a phone or ESP32 outside the laptop, expose the Flask server through Cloudflare Tunnel. The ESP32 sketch already uses the project domain internally, so general users do not type the backend URL during setup.

```powershell
cloudflared tunnel --url http://localhost:5000
```

For this project, the permanent Cloudflare route should point to the Flask server:

```text
smartroomsafety.shiebindev.com -> http://localhost:5000
```

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Web dashboard |
| `/login` | GET/POST | User login page |
| `/register` | GET/POST | User registration page |
| `/api/me` | GET | Current dashboard user |
| `/api/devices` | GET/POST | List or add owned ESP32 devices |
| `/api/devices/<device_id>` | PATCH | Update device name and room |
| `/api/device-pair` | POST | Exchange ESP32 pairing code for device credentials |
| `/api/sensor-data` | POST | Receive ESP32 sensor data |
| `/api/latest` | GET | Return latest stored reading |
| `/api/history` | GET | Return historical readings |
| `/api/history/export.csv` | GET | Export selected device history |
| `/api/summary` | GET | Return stored-data summary |
| `/api/settings` | GET/POST | Read or update thresholds and configuration |
| `/api/control` | GET/POST | Read or update relay, buzzer and control mode |
| `/api/device-command` | GET | Plain-text command endpoint for ESP32 |
| `/api/device-status` | POST | Receive WiFi status, scan results and events |
| `/api/wifi/scan` | POST | Queue remote WiFi scan |
| `/api/wifi/connect` | POST | Queue remote WiFi switch |
| `/api/wifi/reconnect` | POST | Queue reconnect using a WiFi profile saved on ESP32 |
| `/api/wifi/forget` | POST | Queue saved WiFi deletion |

## Control Logic

AUTO mode:

```text
NORMAL   -> relay OFF
WARNING  -> relay OFF
CRITICAL -> relay ON
```

MANUAL mode:

```text
Relay switch ON  -> relay output ON
Relay switch OFF -> relay output OFF
Buzzer enabled   -> buzzer can sound in AUTO, or directly controls buzzer in MANUAL
```

## Notes

- LDR module behavior in this prototype is `LOW = bright` and `HIGH = dark`.
- GPIO34 is input-only and is used for MQ-2 analog output.
- GPIO35 is input-only and is used for LDR digital output.
- WiFi passwords are stored locally on the ESP32 after setup. The dashboard only stores SSID names, signal/status data and temporary command state.
- Device tokens are generated by the backend after pairing. Only token hashes are stored in SQLite.
- The report files are intentionally excluded from the GitHub repository.

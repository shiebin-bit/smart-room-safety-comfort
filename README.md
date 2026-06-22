# Smart Room Safety & Comfort Monitoring System

ESP32-based IoT prototype for monitoring room safety and comfort conditions. The system reads temperature, humidity, gas, light and sound signals, shows local status on an OLED display, sends readings to a Flask backend, stores data in SQLite and provides a web dashboard for live monitoring, history and actuator control.

## Features

- Live dashboard for latest sensor readings
- Room status classification: `NORMAL`, `WARNING` and `CRITICAL`
- Historical charts for temperature, gas, light and sound
- SQLite storage with recent data table and summary values
- AUTO and MANUAL control for relay and buzzer output
- Settings drawer for temperature threshold, gas threshold, LDR dark state and upload interval
- ESP32 OLED display with sensor, status and connection pages
- Push button for changing OLED pages

## Project Structure

```text
.
├── app.py                         Flask API and SQLite backend
├── requirements.txt               Python dependencies
├── SmartRoomSafetyComfort/        ESP32 Arduino sketch
├── static/                        Dashboard CSS and JavaScript
├── templates/                     Flask HTML template
├── circuit/                       Circuit diagram assets
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

## Arduino Setup

Install these libraries from Arduino IDE Library Manager:

- Adafruit SSD1306
- Adafruit GFX Library
- DHT sensor library
- Adafruit Unified Sensor

Use `ESP32 Dev Module` or an equivalent ESP32 DevKit board in Arduino IDE.

Create the local Arduino secrets file before uploading:

```powershell
Copy-Item .\SmartRoomSafetyComfort\arduino_secrets.example.h .\SmartRoomSafetyComfort\arduino_secrets.h
```

Then edit `SmartRoomSafetyComfort/arduino_secrets.h`:

```cpp
const char *WIFI_SSID = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *BACKEND_BASE_URL = "http://192.168.1.100:5000";
```

Do not use `localhost` in the ESP32 code. `localhost` on ESP32 means the ESP32 itself, not the laptop running Flask.

## Dashboard Backend

Run the Flask backend from this folder:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Open the dashboard:

```text
http://localhost:5000
```

Find the laptop IPv4 address for the ESP32 backend URL:

```powershell
ipconfig
```

Use the IPv4 address on the same Wi-Fi network, for example:

```cpp
const char *BACKEND_BASE_URL = "http://192.168.1.100:5000";
```

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Web dashboard |
| `/api/sensor-data` | POST | Receive ESP32 sensor data |
| `/api/latest` | GET | Return latest stored reading |
| `/api/history` | GET | Return historical readings |
| `/api/summary` | GET | Return stored-data summary |
| `/api/settings` | GET/POST | Read or update thresholds and configuration |
| `/api/control` | GET/POST | Read or update relay, buzzer and control mode |
| `/api/device-command` | GET | Plain-text command endpoint for ESP32 |

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
- `arduino_secrets.h` is ignored by Git so Wi-Fi credentials are not committed.
- The report files are intentionally excluded from the GitHub repository.

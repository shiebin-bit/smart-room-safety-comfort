#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

#define OLED_SDA_PIN 21
#define OLED_SCL_PIN 22

#define DHT_PIN 4
#define DHT_TYPE DHT11

#define MQ2_ANALOG_PIN 34
#define LDR_DIGITAL_PIN 35
#define SOUND_DIGITAL_PIN 32

#define BUTTON_PIN 27
#define BUZZER_PIN 26
#define RELAY_PIN 14

const bool RELAY_ACTIVE_LOW = true;

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
DHT dht(DHT_PIN, DHT_TYPE);

#include "arduino_secrets.h"

const char *DEVICE_ID = "ESP32_ROOM_01";

float tempWarningC = 32.0;
float tempCriticalC = 38.0;

int gasWarningRaw = 1800;
int gasCriticalRaw = 2600;
int ldrDarkState = HIGH;

float temperatureC = 0;
float humidityPct = 0;
int gasRaw = 0;
int lightRaw = HIGH;
int soundRaw = 0;

String roomStatus = "STARTING";
String recommendation = "Checking sensors";
String controlMode = "AUTO";

bool manualRelayCommand = false;
bool relayOutputOn = false;
bool buzzerEnabled = true;
bool buzzerShouldAlert = false;
bool buzzerShouldCritical = false;

int oledPage = 0;
const int OLED_PAGE_COUNT = 3;

unsigned long lastSensorReadMs = 0;
unsigned long lastOledUpdateMs = 0;
unsigned long lastUploadMs = 0;
unsigned long lastCommandFetchMs = 0;
unsigned long lastWiFiRetryMs = 0;
unsigned long lastButtonChangeMs = 0;
unsigned long buttonPressedAtMs = 0;
unsigned long uploadIntervalMs = 5000;

bool lastButtonReading = HIGH;
bool stableButtonState = HIGH;
bool longPressHandled = false;

const unsigned long SENSOR_INTERVAL_MS = 2000;
const unsigned long OLED_INTERVAL_MS = 500;
const unsigned long COMMAND_INTERVAL_MS = 5000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 15000;
const unsigned long BUTTON_DEBOUNCE_MS = 50;
const unsigned long BUTTON_LONG_PRESS_MS = 3000;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to WiFi");
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi not connected. Running offline until retry.");
  }
}

void setRelay(bool on) {
  relayOutputOn = on;
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, on ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  }
}

void setBuzzer(bool on) {
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
}

void updateBuzzer() {
  if (controlMode == "MANUAL") {
    setBuzzer(buzzerEnabled);
  } else if (!buzzerEnabled) {
    setBuzzer(false);
  } else if (buzzerShouldCritical) {
    setBuzzer(true);
  } else if (buzzerShouldAlert) {
    setBuzzer((millis() / 500) % 2 == 0);
  } else {
    setBuzzer(false);
  }
}

void updateRelayOutput() {
  if (controlMode == "MANUAL") {
    setRelay(manualRelayCommand);
  } else {
    setRelay(roomStatus == "CRITICAL");
  }
}

String jsonEscape(const String &value) {
  String out = "";
  for (unsigned int i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    if (c == '"' || c == '\\') {
      out += '\\';
    }
    out += c;
  }
  return out;
}

void classifyRoom() {
  bool gasCritical = gasRaw >= gasCriticalRaw;
  bool gasWarning = gasRaw >= gasWarningRaw;
  bool tempCritical = temperatureC >= tempCriticalC;
  bool tempWarning = temperatureC >= tempWarningC;
  bool lowLight = lightRaw == ldrDarkState;

  if (gasCritical || tempCritical) {
    roomStatus = "CRITICAL";
    recommendation = gasCritical ? "Ventilate room now" : "Turn on cooling";
  } else if (gasWarning || tempWarning || lowLight) {
    roomStatus = "WARNING";
    if (gasWarning) {
      recommendation = "Improve ventilation";
    } else if (tempWarning) {
      recommendation = "Reduce room heat";
    } else {
      recommendation = "Increase lighting";
    }
  } else {
    roomStatus = "NORMAL";
    recommendation = "Room condition OK";
  }

  bool alert = (roomStatus == "WARNING" || roomStatus == "CRITICAL");
  bool critical = (roomStatus == "CRITICAL");

  buzzerShouldAlert = alert;
  buzzerShouldCritical = critical;
  updateRelayOutput();
  updateBuzzer();
}

void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (!isnan(t)) {
    temperatureC = t;
  }
  if (!isnan(h)) {
    humidityPct = h;
  }

  gasRaw = analogRead(MQ2_ANALOG_PIN);
  lightRaw = digitalRead(LDR_DIGITAL_PIN);
  soundRaw = digitalRead(SOUND_DIGITAL_PIN);

  classifyRoom();

  Serial.print("Temp: ");
  Serial.print(temperatureC);
  Serial.print(" C, Humidity: ");
  Serial.print(humidityPct);
  Serial.print(" %, Gas: ");
  Serial.print(gasRaw);
  Serial.print(", Light: ");
  Serial.print(digitalLabel(lightRaw));
  Serial.print(" DarkRule: ");
  Serial.print(digitalLabel(ldrDarkState));
  Serial.print(" DarkDetected: ");
  Serial.print(lightRaw == ldrDarkState ? "YES" : "NO");
  Serial.print(", Sound: ");
  Serial.print(digitalLabel(soundRaw));
  Serial.print(", Relay: ");
  Serial.print(relayOutputOn ? "ON" : "OFF");
  Serial.print(", Status: ");
  Serial.println(roomStatus);
}

void drawHeader(const String &title) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(title);
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);
}

void updateOled() {
  if (oledPage == 0) {
    drawHeader("Room Safety Monitor");
    display.setCursor(0, 16);
    display.print("Temp: ");
    display.print(temperatureC, 1);
    display.println(" C");
    display.print("Hum : ");
    display.print(humidityPct, 1);
    display.println(" %");
    display.print("Gas : ");
    display.println(gasRaw);
    display.print("Light: ");
    display.println(digitalLabel(lightRaw));
    display.print("Sound: ");
    display.println(digitalLabel(soundRaw));
  } else if (oledPage == 1) {
    drawHeader("Room Status");
    display.setCursor(0, 18);
    display.setTextSize(2);
    display.println(roomStatus);
    display.setTextSize(1);
    display.setCursor(0, 42);
    display.println(recommendation);
  } else {
    drawHeader("Connection");
    display.setCursor(0, 16);
    display.print("WiFi: ");
    display.println(WiFi.status() == WL_CONNECTED ? "Connected" : "Offline");
    display.print("Mode: ");
    display.println(controlMode);
    display.print("Relay: ");
    display.println(relayOutputOn ? "ON" : "OFF");
    display.print("IP: ");
    display.println(WiFi.localIP());
    display.println("Button: next page");
  }

  display.display();
}

void uploadData() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Upload skipped: WiFi not connected");
    return;
  }

  String backendUrl = String(BACKEND_BASE_URL) + "/api/sensor-data";
  HTTPClient http;
  http.begin(backendUrl);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"temperature\":" + String(temperatureC, 1) + ",";
  payload += "\"humidity\":" + String(humidityPct, 1) + ",";
  payload += "\"gas_raw\":" + String(gasRaw) + ",";
  payload += "\"light_raw\":" + String(lightRaw) + ",";
  payload += "\"sound_raw\":" + String(soundRaw) + ",";
  payload += "\"relay_on\":" + String(relayOutputOn ? 1 : 0) + ",";
  payload += "\"status\":\"" + jsonEscape(roomStatus) + "\",";
  payload += "\"recommendation\":\"" + jsonEscape(recommendation) + "\"";
  payload += "}";

  int httpCode = http.POST(payload);
  Serial.print("POST ");
  Serial.print(backendUrl);
  Serial.print(" -> ");
  Serial.println(httpCode);

  http.end();
}

String getLineValue(const String &text, const String &key) {
  String prefix = key + "=";
  int start = text.indexOf(prefix);
  if (start < 0) {
    return "";
  }
  start += prefix.length();
  int end = text.indexOf('\n', start);
  if (end < 0) {
    end = text.length();
  }
  String value = text.substring(start, end);
  value.trim();
  return value;
}

String digitalLabel(int value) {
  return value == HIGH ? "HIGH" : "LOW";
}

bool parseDigitalState(const String &value, int &target) {
  if (value == "0" || value == "LOW") {
    target = LOW;
    return true;
  }
  if (value == "1" || value == "HIGH") {
    target = HIGH;
    return true;
  }
  return false;
}

void fetchBackendCommand() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  String commandUrl = String(BACKEND_BASE_URL) + "/api/device-command?device_id=" + DEVICE_ID;
  HTTPClient http;
  http.begin(commandUrl);
  int httpCode = http.GET();

  if (httpCode == 200) {
    String body = http.getString();

    String modeValue = getLineValue(body, "mode");
    String relayValue = getLineValue(body, "relay");
    String buzzerValue = getLineValue(body, "buzzer");
    String tempWarningValue = getLineValue(body, "temp_warning");
    String tempCriticalValue = getLineValue(body, "temp_critical");
    String gasWarningValue = getLineValue(body, "gas_warning");
    String gasCriticalValue = getLineValue(body, "gas_critical");
    String ldrDarkValue = getLineValue(body, "ldr_dark_state");
    String lightLowValue = getLineValue(body, "light_low");
    String uploadIntervalValue = getLineValue(body, "upload_interval");

    if (modeValue == "AUTO" || modeValue == "MANUAL") {
      controlMode = modeValue;
    }
    if (relayValue == "0" || relayValue == "1") {
      manualRelayCommand = relayValue == "1";
    }
    if (buzzerValue == "0" || buzzerValue == "1") {
      buzzerEnabled = buzzerValue == "1";
    }
    if (tempWarningValue.length() > 0) {
      tempWarningC = tempWarningValue.toFloat();
    }
    if (tempCriticalValue.length() > 0) {
      tempCriticalC = tempCriticalValue.toFloat();
    }
    if (gasWarningValue.length() > 0) {
      gasWarningRaw = gasWarningValue.toInt();
    }
    if (gasCriticalValue.length() > 0) {
      gasCriticalRaw = gasCriticalValue.toInt();
    }
    if (ldrDarkValue.length() > 0) {
      parseDigitalState(ldrDarkValue, ldrDarkState);
    } else if (lightLowValue.length() > 0) {
      parseDigitalState(lightLowValue, ldrDarkState);
    }
    if (uploadIntervalValue.length() > 0) {
      int requestedSeconds = uploadIntervalValue.toInt();
      if (requestedSeconds >= 1 && requestedSeconds <= 120) {
        uploadIntervalMs = (unsigned long)requestedSeconds * 1000UL;
      }
    }

    classifyRoom();
    Serial.print("Command applied: mode=");
    Serial.print(controlMode);
    Serial.print(", relay=");
    Serial.print(manualRelayCommand ? "ON" : "OFF");
    Serial.print(", relay output=");
    Serial.print(relayOutputOn ? "ON" : "OFF");
    Serial.print(", buzzer=");
    Serial.print(buzzerEnabled ? "ON" : "OFF");
    Serial.print(", LDR dark=");
    Serial.print(digitalLabel(ldrDarkState));
    Serial.print(", upload=");
    Serial.print(uploadIntervalMs / 1000);
    Serial.println("s");
  }

  Serial.print("GET command -> ");
  Serial.println(httpCode);
  http.end();
}

void handleButton() {
  bool reading = digitalRead(BUTTON_PIN);

  if (reading != lastButtonReading) {
    lastButtonChangeMs = millis();
    lastButtonReading = reading;
  }

  if ((millis() - lastButtonChangeMs) > BUTTON_DEBOUNCE_MS) {
    if (reading != stableButtonState) {
      stableButtonState = reading;

      if (stableButtonState == LOW) {
        buttonPressedAtMs = millis();
        longPressHandled = false;
      } else {
        unsigned long pressDuration = millis() - buttonPressedAtMs;
        if (!longPressHandled && pressDuration < BUTTON_LONG_PRESS_MS) {
          oledPage = (oledPage + 1) % OLED_PAGE_COUNT;
          Serial.print("Button short press. OLED page: ");
          Serial.println(oledPage);
          updateOled();
        }
      }
    }
  }

  if (stableButtonState == LOW && !longPressHandled) {
    if ((millis() - buttonPressedAtMs) >= BUTTON_LONG_PRESS_MS) {
      longPressHandled = true;
      Serial.println("Button long press detected.");
      display.clearDisplay();
      display.setCursor(0, 0);
      display.setTextColor(SSD1306_WHITE);
      display.setTextSize(1);
      display.println("Button held");
      display.println("Release to continue");
      display.display();
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LDR_DIGITAL_PIN, INPUT);
  pinMode(SOUND_DIGITAL_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  setBuzzer(false);
  setRelay(false);

  analogReadResolution(12);
  analogSetPinAttenuation(MQ2_ANALOG_PIN, ADC_11db);

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("OLED not found. Check SDA/SCL/VCC/GND.");
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("Starting system...");
    display.display();
  }

  dht.begin();

  connectWiFi();
  lastWiFiRetryMs = millis();

  readSensors();
  updateOled();
}

void loop() {
  handleButton();
  updateRelayOutput();
  updateBuzzer();

  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED && now - lastWiFiRetryMs >= WIFI_RETRY_INTERVAL_MS) {
    lastWiFiRetryMs = now;
    connectWiFi();
  }

  if (now - lastSensorReadMs >= SENSOR_INTERVAL_MS) {
    lastSensorReadMs = now;
    readSensors();
  }

  if (now - lastOledUpdateMs >= OLED_INTERVAL_MS) {
    lastOledUpdateMs = now;
    updateOled();
  }

  if (now - lastUploadMs >= uploadIntervalMs) {
    lastUploadMs = now;
    uploadData();
  }

  if (now - lastCommandFetchMs >= COMMAND_INTERVAL_MS) {
    lastCommandFetchMs = now;
    fetchBackendCommand();
  }
}

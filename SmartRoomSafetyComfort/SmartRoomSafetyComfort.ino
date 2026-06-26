#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
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
WebServer setupServer(80);
DNSServer dnsServer;
Preferences preferences;
WiFiClientSecure secureClient;

const byte DNS_PORT = 53;
const char *DEFAULT_BACKEND_BASE_URL = "https://smartroomsafety.shiebindev.com";
const char *SAVED_WIFI_PASSWORD_MARKER = "__SAVED_WIFI_PROFILE__";

String wifiSsid = "";
String wifiPassword = "";
String pairingCode = "";
String backendBaseUrl = DEFAULT_BACKEND_BASE_URL;
String deviceId = "UNPAIRED";
String deviceToken = "";

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
unsigned long lastPairRetryMs = 0;
unsigned long lastStatusPostMs = 0;
unsigned long lastButtonChangeMs = 0;
unsigned long buttonPressedAtMs = 0;
unsigned long uploadIntervalMs = 5000;

bool lastButtonReading = HIGH;
bool stableButtonState = HIGH;
bool longPressHandled = false;
bool setupPortalRunning = false;
bool setupSaveRequested = false;

const unsigned long SENSOR_INTERVAL_MS = 2000;
const unsigned long OLED_INTERVAL_MS = 500;
const unsigned long COMMAND_INTERVAL_MS = 5000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 15000;
const unsigned long PAIR_RETRY_INTERVAL_MS = 15000;
const unsigned long STATUS_INTERVAL_MS = 15000;
const unsigned long BUTTON_DEBOUNCE_MS = 50;
const unsigned long BUTTON_LONG_PRESS_MS = 3000;
const int WIFI_PROFILE_COUNT = 6;

void loadDeviceConfig() {
  preferences.begin("smartroom", true);
  wifiSsid = preferences.getString("ssid", "");
  wifiPassword = preferences.getString("password", "");
  pairingCode = preferences.getString("pairing", "");
  backendBaseUrl = preferences.getString("backend", DEFAULT_BACKEND_BASE_URL);
  deviceId = preferences.getString("device_id", "UNPAIRED");
  deviceToken = preferences.getString("token", "");
  preferences.end();
}

void saveSetupConfig(const String &ssid, const String &password, const String &code) {
  String cleanCode = code;
  cleanCode.trim();
  preferences.begin("smartroom", false);
  preferences.putString("ssid", ssid);
  preferences.putString("password", password);
  if (cleanCode.length() > 0) {
    preferences.putString("pairing", cleanCode);
  }
  preferences.putString("backend", DEFAULT_BACKEND_BASE_URL);
  preferences.end();
}

void saveDeviceCredentials(const String &newDeviceId, const String &newToken) {
  String cleanDeviceId = newDeviceId;
  cleanDeviceId.trim();
  String cleanToken = newToken;
  cleanToken.trim();
  preferences.begin("smartroom", false);
  preferences.putString("device_id", cleanDeviceId);
  preferences.putString("token", cleanToken);
  preferences.putString("pairing", "");
  preferences.putString("backend", DEFAULT_BACKEND_BASE_URL);
  preferences.end();
  deviceId = cleanDeviceId;
  deviceToken = cleanToken;
  pairingCode = "";
}

void clearSavedWiFiOnly() {
  preferences.begin("smartroom", false);
  preferences.putString("ssid", "");
  preferences.putString("password", "");
  preferences.end();
  wifiSsid = "";
  wifiPassword = "";
}

String htmlEscape(const String &value) {
  String escaped = "";
  for (unsigned int i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    if (c == '&') escaped += "&amp;";
    else if (c == '<') escaped += "&lt;";
    else if (c == '>') escaped += "&gt;";
    else if (c == '"') escaped += "&quot;";
    else escaped += c;
  }
  return escaped;
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

String getJsonString(const String &body, const String &key) {
  String pattern = "\"" + key + "\"";
  int start = body.indexOf(pattern);
  if (start < 0) return "";
  start += pattern.length();
  start = body.indexOf(":", start);
  if (start < 0) return "";
  start++;
  while (start < (int)body.length() && (body.charAt(start) == ' ' || body.charAt(start) == '\n' || body.charAt(start) == '\r' || body.charAt(start) == '\t')) {
    start++;
  }
  if (start >= (int)body.length() || body.charAt(start) != '"') return "";
  start++;
  int end = body.indexOf("\"", start);
  if (end < 0) return "";
  return body.substring(start, end);
}

String getLineValue(const String &text, const String &key) {
  String prefix = key + "=";
  int start = text.indexOf(prefix);
  if (start < 0) return "";
  start += prefix.length();
  int end = text.indexOf('\n', start);
  if (end < 0) end = text.length();
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

void showSetupScreen(const String &apName) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Setup Mode");
  display.println(apName);
  display.println("Open:");
  display.println("192.168.4.1");
  display.display();
}

String setupPage(const String &apName) {
  int networkCount = WiFi.scanNetworks();
  String options = "";
  for (int i = 0; i < networkCount; i++) {
    String ssid = WiFi.SSID(i);
    options += "<option value=\"" + htmlEscape(ssid) + "\">" + htmlEscape(ssid) + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }
  String page = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>";
  page += "<title>Smart Room Setup</title>";
  page += "<style>body{font-family:Arial;background:#071012;color:#fff8ec;margin:0;padding:20px}";
  page += "main{max-width:430px;margin:auto;background:#101d21;border:1px solid #314247;border-radius:8px;padding:20px}";
  page += "label{display:block;margin:14px 0 6px;color:#aab7b2}input,select,button{box-sizing:border-box;width:100%;min-height:42px;border-radius:6px;border:1px solid #40545a;padding:8px;background:#071113;color:#fff8ec}";
  page += ".password-wrap{display:grid;grid-template-columns:1fr 46px;gap:8px}.eye-btn{margin:0;display:grid;place-items:center;background:#13252a;color:#fff8ec}.eye-btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}";
  page += "button{margin-top:18px;background:#52d98f;color:#061012;font-weight:800}small{color:#aab7b2;line-height:1.5;display:block;margin-top:12px}</style></head><body><main>";
  page += "<h1>Smart Room Setup</h1>";
  page += "<p>Select home WiFi and enter the pairing code shown in the cloud dashboard.</p>";
  page += "<form method='post' action='/save'>";
  page += "<label>Home WiFi</label><select name='ssid'>" + options + "</select>";
  page += "<label>WiFi password</label><div class='password-wrap'><input id='wifi-pass' name='password' type='password' autocomplete='off' autocapitalize='none' spellcheck='false'>";
  page += "<button class='eye-btn' type='button' onclick=\"var p=document.getElementById('wifi-pass');p.type=p.type=='password'?'text':'password';\" aria-label='Show or hide password'><svg viewBox='0 0 24 24'><path d='M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z'></path><circle cx='12' cy='12' r='3'></circle></svg></button></div>";
  if (deviceToken.length() == 0) {
    page += "<label>Pairing code</label><input name='pairing' inputmode='numeric' maxlength='12' required>";
  } else {
    page += "<label>Pairing code</label><input name='pairing' inputmode='numeric' maxlength='12' placeholder='Already paired - optional'>";
  }
  page += "<button type='submit'>Connect Device</button></form>";
  page += "<small>Password is sent only to this ESP32 setup page. After saving, reconnect your phone or laptop to normal WiFi and return to the cloud dashboard.<br><br>Setup WiFi: " + htmlEscape(apName) + "<br>Fallback address: http://192.168.4.1<br>Cloud: " + String(DEFAULT_BACKEND_BASE_URL) + "</small>";
  page += "</main></body></html>";
  return page;
}

void startSetupPortal() {
  setupPortalRunning = true;
  setupSaveRequested = false;
  WiFi.mode(WIFI_AP_STA);
  String apName = "SmartRoom-Setup-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  WiFi.softAP(apName.c_str());
  delay(200);
  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());

  setupServer.on("/", HTTP_GET, [apName]() {
    setupServer.send(200, "text/html", setupPage(apName));
  });
  setupServer.on("/generate_204", HTTP_GET, []() {
    setupServer.sendHeader("Location", "http://192.168.4.1/", true);
    setupServer.send(302, "text/plain", "");
  });
  setupServer.on("/fwlink", HTTP_GET, []() {
    setupServer.sendHeader("Location", "http://192.168.4.1/", true);
    setupServer.send(302, "text/plain", "");
  });
  setupServer.on("/hotspot-detect.html", HTTP_GET, [apName]() {
    setupServer.send(200, "text/html", setupPage(apName));
  });
  setupServer.on("/save", HTTP_POST, []() {
    String ssid = setupServer.arg("ssid");
    String password = setupServer.arg("password");
    String code = setupServer.arg("pairing");
    if (ssid.length() == 0) {
      setupServer.send(400, "text/html", "<h1>Missing WiFi</h1><p>Please select a WiFi network.</p><p><a href='/'>Back</a></p>");
      return;
    }
    saveSetupConfig(ssid, password, code);
    setupSaveRequested = true;
    setupPortalRunning = false;
    setupServer.send(200, "text/html", "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{font-family:Arial;background:#071012;color:#fff8ec;padding:22px}main{max-width:430px;margin:auto}</style></head><body><main><h1>Saved</h1><p>ESP32 will restart in a few seconds, connect to your WiFi and pair with the cloud dashboard.</p><p>Reconnect your phone or laptop to normal WiFi, then return to the cloud dashboard.</p><p>If SmartRoom-Setup appears again after 30 seconds, WiFi connection or pairing code failed. Reopen this page and check the password and pairing code.</p></main></body></html>");
  });
  setupServer.onNotFound([apName]() {
    setupServer.send(200, "text/html", setupPage(apName));
  });

  setupServer.begin();
  Serial.print("Setup portal started. AP: ");
  Serial.println(apName);
  Serial.println("Open http://192.168.4.1");
  showSetupScreen(apName);

  while (setupPortalRunning) {
    dnsServer.processNextRequest();
    setupServer.handleClient();
    delay(5);
  }
  if (setupSaveRequested) {
    delay(6000);
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    ESP.restart();
  }
}

bool beginHttp(HTTPClient &http, const String &url) {
  if (url.startsWith("https://")) {
    secureClient.setInsecure();
    return http.begin(secureClient, url);
  }
  return http.begin(url);
}

void addDeviceTokenHeader(HTTPClient &http) {
  if (deviceToken.length() > 0) {
    http.addHeader("X-Device-Token", deviceToken);
  }
}

void saveWifiProfile(const String &ssid, const String &password) {
  preferences.begin("smartroom", false);
  for (int i = 0; i < WIFI_PROFILE_COUNT; i++) {
    String key = "p" + String(i) + "_ssid";
    if (preferences.getString(key.c_str(), "") == ssid || preferences.getString(key.c_str(), "").length() == 0) {
      preferences.putString(key.c_str(), ssid);
      preferences.putString(("p" + String(i) + "_pass").c_str(), password);
      preferences.putUInt(("p" + String(i) + "_fail").c_str(), 0);
      preferences.end();
      return;
    }
  }
  preferences.putString("p0_ssid", ssid);
  preferences.putString("p0_pass", password);
  preferences.putUInt("p0_fail", 0);
  preferences.end();
}

void forgetWifiProfile(const String &ssid) {
  preferences.begin("smartroom", false);
  for (int i = 0; i < WIFI_PROFILE_COUNT; i++) {
    String key = "p" + String(i) + "_ssid";
    if (preferences.getString(key.c_str(), "") == ssid) {
      preferences.putString(key.c_str(), "");
      preferences.putString(("p" + String(i) + "_pass").c_str(), "");
      preferences.putUInt(("p" + String(i) + "_fail").c_str(), 0);
    }
  }
  preferences.end();
}

bool getSavedWifiPassword(const String &ssid, String &password) {
  String targetSsid = ssid;
  targetSsid.trim();
  Serial.print("Reconnect requested for saved SSID: ");
  Serial.println(targetSsid);
  if (targetSsid == wifiSsid && wifiPassword.length() > 0) {
    Serial.println("Using current WiFi password from active config.");
    password = wifiPassword;
    return true;
  }
  preferences.begin("smartroom", true);
  Serial.println("Saved WiFi profiles on ESP32:");
  for (int i = 0; i < WIFI_PROFILE_COUNT; i++) {
    String savedSsid = preferences.getString(("p" + String(i) + "_ssid").c_str(), "");
    savedSsid.trim();
    if (savedSsid.length() > 0) {
      Serial.print(" - ");
      Serial.println(savedSsid);
    }
    if (savedSsid == targetSsid) {
      password = preferences.getString(("p" + String(i) + "_pass").c_str(), "");
      preferences.end();
      Serial.println(password.length() > 0 ? "Saved password found." : "Saved profile is an open network.");
      return true;
    }
  }
  preferences.end();
  Serial.println("Saved password not found on ESP32.");
  return false;
}

bool tryConnect(const String &ssid, const String &password, unsigned long timeoutMs) {
  if (ssid.length() == 0) return false;
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());
  unsigned long start = millis();
  Serial.print("Connecting to ");
  Serial.print(ssid);
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    wifiSsid = ssid;
    wifiPassword = password;
    preferences.begin("smartroom", false);
    preferences.putString("ssid", ssid);
    preferences.putString("password", password);
    preferences.end();
    saveWifiProfile(ssid, password);
    return true;
  }
  return false;
}

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  if (wifiSsid.length() > 0 && tryConnect(wifiSsid, wifiPassword, 15000)) return true;

  preferences.begin("smartroom", true);
  for (int i = 0; i < WIFI_PROFILE_COUNT; i++) {
    String ssid = preferences.getString(("p" + String(i) + "_ssid").c_str(), "");
    String pass = preferences.getString(("p" + String(i) + "_pass").c_str(), "");
    if (ssid.length() > 0 && tryConnect(ssid, pass, 12000)) {
      preferences.end();
      return true;
    }
  }
  preferences.end();

  Serial.println("No saved WiFi works. Starting setup portal.");
  startSetupPortal();
  return false;
}

bool pairDevice() {
  if (deviceToken.length() > 0) return true;
  if (pairingCode.length() == 0) {
    Serial.println("No pairing code available.");
    startSetupPortal();
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  String url = String(DEFAULT_BACKEND_BASE_URL) + "/api/device-pair";
  if (!beginHttp(http, url)) return false;
  http.addHeader("Content-Type", "application/json");
  String payload = "{\"pairing_code\":\"" + jsonEscape(pairingCode) + "\"}";
  int httpCode = http.POST(payload);
  String body = http.getString();
  Serial.print("PAIR -> ");
  Serial.println(httpCode);
  if (httpCode != 200) {
    Serial.print("PAIR body: ");
    Serial.println(body.substring(0, 160));
  }
  http.end();

  if (httpCode == 200) {
    String newDeviceId = getJsonString(body, "device_id");
    String newToken = getJsonString(body, "device_token");
    if (newDeviceId.length() > 0 && newToken.length() > 0) {
      saveDeviceCredentials(newDeviceId, newToken);
      Serial.print("Paired device ID: ");
      Serial.println(deviceId);
      return true;
    }
    Serial.println("PAIR parse failed. Response body:");
    Serial.println(body.substring(0, 240));
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.println("Pairing failed");
  if (httpCode == 400 || httpCode == 404) {
    display.println("Check code");
    display.display();
    delay(1500);
    startSetupPortal();
  } else {
    display.println("Cloud retry");
    display.display();
  }
  return false;
}

void setRelay(bool on) {
  relayOutputOn = on;
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
}

void setBuzzer(bool on) {
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
}

void updateBuzzer() {
  if (controlMode == "MANUAL") setBuzzer(buzzerEnabled);
  else if (!buzzerEnabled) setBuzzer(false);
  else if (buzzerShouldCritical) setBuzzer(true);
  else if (buzzerShouldAlert) setBuzzer((millis() / 500) % 2 == 0);
  else setBuzzer(false);
}

void updateRelayOutput() {
  if (controlMode == "MANUAL") setRelay(manualRelayCommand);
  else setRelay(roomStatus == "CRITICAL");
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
    if (gasWarning) recommendation = "Improve ventilation";
    else if (tempWarning) recommendation = "Reduce room heat";
    else recommendation = "Increase lighting";
  } else {
    roomStatus = "NORMAL";
    recommendation = "Room condition OK";
  }

  buzzerShouldAlert = roomStatus == "WARNING" || roomStatus == "CRITICAL";
  buzzerShouldCritical = roomStatus == "CRITICAL";
  updateRelayOutput();
  updateBuzzer();
}

void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) temperatureC = t;
  if (!isnan(h)) humidityPct = h;
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
    display.print("Temp: "); display.print(temperatureC, 1); display.println(" C");
    display.print("Hum : "); display.print(humidityPct, 1); display.println(" %");
    display.print("Gas : "); display.println(gasRaw);
    display.print("Light: "); display.println(digitalLabel(lightRaw));
    display.print("Sound: "); display.println(digitalLabel(soundRaw));
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
    display.print("WiFi: "); display.println(WiFi.status() == WL_CONNECTED ? "Connected" : "Offline");
    display.print("SSID: "); display.println(WiFi.SSID());
    display.print("ID: "); display.println(deviceId);
    display.print("Relay: "); display.println(relayOutputOn ? "ON" : "OFF");
    display.print("IP: "); display.println(WiFi.localIP());
  }
  display.display();
}

void postDeviceStatus(const String &status, const String &errorMessage, const String &eventType = "", const String &eventMessage = "") {
  if (WiFi.status() != WL_CONNECTED || deviceToken.length() == 0) return;
  HTTPClient http;
  String url = backendBaseUrl + "/api/device-status";
  if (!beginHttp(http, url)) return;
  http.addHeader("Content-Type", "application/json");
  addDeviceTokenHeader(http);
  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"current_ssid\":\"" + jsonEscape(WiFi.SSID()) + "\",";
  payload += "\"wifi_rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"wifi_status\":\"" + jsonEscape(status) + "\",";
  payload += "\"wifi_last_error\":\"" + jsonEscape(errorMessage) + "\"";
  if (eventType.length() > 0) {
    payload += ",\"event_type\":\"" + jsonEscape(eventType) + "\",";
    payload += "\"event_message\":\"" + jsonEscape(eventMessage) + "\"";
  }
  payload += "}";
  int httpCode = http.POST(payload);
  Serial.print("STATUS -> ");
  Serial.println(httpCode);
  http.end();
}

void postWifiScanResults() {
  if (WiFi.status() != WL_CONNECTED || deviceToken.length() == 0) return;
  int count = WiFi.scanNetworks();
  HTTPClient http;
  String url = backendBaseUrl + "/api/device-status";
  if (!beginHttp(http, url)) return;
  http.addHeader("Content-Type", "application/json");
  addDeviceTokenHeader(http);
  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  payload += "\"current_ssid\":\"" + jsonEscape(WiFi.SSID()) + "\",";
  payload += "\"wifi_rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"wifi_status\":\"CONNECTED\",";
  payload += "\"wifi_last_error\":\"\",";
  payload += "\"networks\":[";
  for (int i = 0; i < count && i < 20; i++) {
    if (i > 0) payload += ",";
    payload += "{\"ssid\":\"" + jsonEscape(WiFi.SSID(i)) + "\",";
    payload += "\"rssi\":" + String(WiFi.RSSI(i)) + ",";
    payload += "\"encryption\":\"" + String((int)WiFi.encryptionType(i)) + "\"}";
  }
  payload += "]}";
  int httpCode = http.POST(payload);
  Serial.print("SCAN POST -> ");
  Serial.println(httpCode);
  http.end();
}

void uploadData() {
  if (WiFi.status() != WL_CONNECTED || deviceToken.length() == 0) {
    Serial.println("Upload skipped: WiFi or token missing");
    return;
  }
  String backendUrl = backendBaseUrl + "/api/sensor-data";
  HTTPClient http;
  if (!beginHttp(http, backendUrl)) return;
  http.addHeader("Content-Type", "application/json");
  addDeviceTokenHeader(http);
  String payload = "{";
  payload += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
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

bool attemptWifiSwitch(const String &newSsid, const String &newPassword) {
  if (newSsid.length() == 0) return false;
  String passwordToUse = newPassword;
  passwordToUse.trim();
  if (passwordToUse == SAVED_WIFI_PASSWORD_MARKER && !getSavedWifiPassword(newSsid, passwordToUse)) {
    postDeviceStatus("SWITCH_FAILED", "Saved WiFi password not found for " + newSsid, "wifi_reconnect_failed", "Password not saved for " + newSsid);
    return false;
  }
  String oldSsid = wifiSsid;
  String oldPassword = wifiPassword;
  postDeviceStatus("SWITCHING", "", "wifi_switch_started", "Trying " + newSsid);
  WiFi.disconnect(true);
  delay(500);
  if (tryConnect(newSsid, passwordToUse, 20000)) {
    postDeviceStatus("CONNECTED", "", "wifi_switch_success", "Connected to " + newSsid);
    return true;
  }
  postDeviceStatus("SWITCH_FAILED", "Unable to connect to " + newSsid, "wifi_switch_failed", "Falling back to previous WiFi.");
  WiFi.disconnect(true);
  delay(500);
  if (tryConnect(oldSsid, oldPassword, 15000)) {
    postDeviceStatus("CONNECTED", "Fallback to previous WiFi", "wifi_fallback_success", "Reconnected to " + oldSsid);
  } else {
    startSetupPortal();
  }
  return false;
}

void fetchBackendCommand() {
  if (WiFi.status() != WL_CONNECTED || deviceToken.length() == 0) return;
  String commandUrl = backendBaseUrl + "/api/device-command?device_id=" + deviceId;
  HTTPClient http;
  if (!beginHttp(http, commandUrl)) return;
  addDeviceTokenHeader(http);
  int httpCode = http.GET();
  if (httpCode == 200) {
    String body = http.getString();
    String modeValue = getLineValue(body, "mode");
    String relayValue = getLineValue(body, "relay");
    String buzzerValue = getLineValue(body, "buzzer");
    String enterSetupValue = getLineValue(body, "enter_setup");
    String wifiScanValue = getLineValue(body, "wifi_scan");
    String wifiSsidValue = getLineValue(body, "wifi_ssid");
    String wifiPasswordValue = getLineValue(body, "wifi_password");
    String wifiForgetValue = getLineValue(body, "wifi_forget");
    String tempWarningValue = getLineValue(body, "temp_warning");
    String tempCriticalValue = getLineValue(body, "temp_critical");
    String gasWarningValue = getLineValue(body, "gas_warning");
    String gasCriticalValue = getLineValue(body, "gas_critical");
    String ldrDarkValue = getLineValue(body, "ldr_dark_state");
    String lightLowValue = getLineValue(body, "light_low");
    String uploadIntervalValue = getLineValue(body, "upload_interval");

    if (modeValue == "AUTO" || modeValue == "MANUAL") controlMode = modeValue;
    if (relayValue == "0" || relayValue == "1") manualRelayCommand = relayValue == "1";
    if (buzzerValue == "0" || buzzerValue == "1") buzzerEnabled = buzzerValue == "1";
    if (tempWarningValue.length() > 0) tempWarningC = tempWarningValue.toFloat();
    if (tempCriticalValue.length() > 0) tempCriticalC = tempCriticalValue.toFloat();
    if (gasWarningValue.length() > 0) gasWarningRaw = gasWarningValue.toInt();
    if (gasCriticalValue.length() > 0) gasCriticalRaw = gasCriticalValue.toInt();
    if (ldrDarkValue.length() > 0) parseDigitalState(ldrDarkValue, ldrDarkState);
    else if (lightLowValue.length() > 0) parseDigitalState(lightLowValue, ldrDarkState);
    if (uploadIntervalValue.length() > 0) {
      int requestedSeconds = uploadIntervalValue.toInt();
      if (requestedSeconds >= 1 && requestedSeconds <= 120) uploadIntervalMs = (unsigned long)requestedSeconds * 1000UL;
    }
    if (wifiScanValue == "1") postWifiScanResults();
    if (wifiForgetValue.length() > 0) {
      forgetWifiProfile(wifiForgetValue);
      postDeviceStatus("CONNECTED", "", "wifi_profile_forgotten", "Forgot " + wifiForgetValue);
    }
    if (wifiSsidValue.length() > 0) attemptWifiSwitch(wifiSsidValue, wifiPasswordValue);
    if (enterSetupValue == "1") {
      clearSavedWiFiOnly();
      delay(800);
      ESP.restart();
    }
    classifyRoom();
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
          updateOled();
        }
      }
    }
  }
  if (stableButtonState == LOW && !longPressHandled && (millis() - buttonPressedAtMs) >= BUTTON_LONG_PRESS_MS) {
    longPressHandled = true;
    clearSavedWiFiOnly();
    display.clearDisplay();
    display.setCursor(0, 0);
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.println("Button held");
    display.println("Restart setup mode");
    display.display();
    delay(800);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  loadDeviceConfig();

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
  pairDevice();
  postDeviceStatus("CONNECTED", "", "device_online", "Device connected to cloud.");
  lastWiFiRetryMs = millis();
  lastPairRetryMs = millis();
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
  if (WiFi.status() == WL_CONNECTED && deviceToken.length() == 0 && pairingCode.length() > 0 && now - lastPairRetryMs >= PAIR_RETRY_INTERVAL_MS) {
    lastPairRetryMs = now;
    pairDevice();
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
  if (now - lastStatusPostMs >= STATUS_INTERVAL_MS) {
    lastStatusPostMs = now;
    postDeviceStatus(WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED", WiFi.status() == WL_CONNECTED ? "" : "WiFi disconnected");
  }
}

const latestEls = {
  temperature: document.querySelector("#temperature"),
  humidity: document.querySelector("#humidity"),
  gas: document.querySelector("#gas"),
  light: document.querySelector("#light"),
  sound: document.querySelector("#sound"),
  status: document.querySelector("#room-status"),
  connection: document.querySelector("#connection"),
  recommendation: document.querySelector("#recommendation"),
  lastUpdate: document.querySelector("#last-update"),
  selectedRoom: document.querySelector("#selected-room"),
  fanRelayRow: document.querySelector("#fan-relay-row"),
  fanRelayState: document.querySelector("#fan-relay-state"),
};

const summaryEls = {
  avgTemp: document.querySelector("#avg-temp"),
  avgHumidity: document.querySelector("#avg-humidity"),
  highestGas: document.querySelector("#highest-gas"),
  avgSound: document.querySelector("#avg-sound"),
  warningCount: document.querySelector("#warning-count"),
  criticalCount: document.querySelector("#critical-count"),
  offlineDuration: document.querySelector("#offline-duration"),
};

const historyBody = document.querySelector("#history-body");
const recordCount = document.querySelector("#record-count");
const deviceSelect = document.querySelector("#device-select");
const userName = document.querySelector("#user-name");
const statusCard = document.querySelector(".status-card");
const criticalAlert = document.querySelector("#critical-alert");
const criticalAlertText = document.querySelector("#critical-alert-text");
const enableNotificationsButton = document.querySelector("#enable-notifications");
const exportCsv = document.querySelector("#export-csv");
const exportSummary = document.querySelector("#export-summary");
const historyRange = document.querySelector("#history-range");
const syncState = document.querySelector("#sync-state");
const alertLog = document.querySelector("#alert-log");
const healthScore = document.querySelector("#health-score");
const healthLabel = document.querySelector("#health-label");
const healthReasons = document.querySelector("#health-reasons");
const comfortScore = document.querySelector("#comfort-score");
const comfortLabel = document.querySelector("#comfort-label");
const alertReasons = document.querySelector("#alert-reasons");
const actionRecommendations = document.querySelector("#action-recommendations");

const charts = {
  temperature: { canvas: document.querySelector("#temp-chart"), latest: document.querySelector("#chart-temp-latest"), color: "#52d98f", label: "C" },
  gas: { canvas: document.querySelector("#gas-chart"), latest: document.querySelector("#chart-gas-latest"), color: "#ff6675", label: "raw" },
  light: { canvas: document.querySelector("#light-chart"), latest: document.querySelector("#chart-light-latest"), color: "#b68cff", label: "DO" },
  sound: { canvas: document.querySelector("#sound-chart"), latest: document.querySelector("#chart-sound-latest"), color: "#72a9ff", label: "OUT" },
};

const settingsDrawer = document.querySelector("#settings-drawer");
const settingsBackdrop = document.querySelector("#settings-backdrop");
const openSettingsButton = document.querySelector("#open-settings");
const closeSettingsButton = document.querySelector("#close-settings");
const settingsFeedback = document.querySelector("#settings-feedback");
const deviceDrawer = document.querySelector("#device-drawer");
const deviceBackdrop = document.querySelector("#device-backdrop");
const closeDeviceButton = document.querySelector("#close-device");
const addDeviceButtons = document.querySelectorAll("#add-device, [data-open-add-device]");
const deviceFeedback = document.querySelector("#device-feedback");
const deviceForm = document.querySelector("#device-form");
const deviceList = document.querySelector("#device-list");
const startDeleteDevicesButton = document.querySelector("#start-delete-devices");
const confirmDeleteDevicesButton = document.querySelector("#confirm-delete-devices");
const cancelDeleteDevicesButton = document.querySelector("#cancel-delete-devices");
const deviceDeleteFeedback = document.querySelector("#device-delete-feedback");
const onboardingPanel = document.querySelector("#onboarding-panel");
const pairingResult = document.querySelector("#pairing-result");
const pairingCode = document.querySelector("#pairing-code");
const pairingDeviceName = document.querySelector("#pairing-device-name");

const controlFeedback = document.querySelector("#control-feedback");
const saveControlButton = document.querySelector("#save-control");
const modeSelect = document.querySelector("#mode");
const relayControl = document.querySelector("#relay");
const relayControlRow = document.querySelector("#relay-control-row");
const relayHelp = document.querySelector("#relay-help");
const buzzerControl = document.querySelector("#buzzer");
const buzzerTitle = document.querySelector("#buzzer-title");
const buzzerHelp = document.querySelector("#buzzer-help");
const modeHelp = document.querySelector("#mode-help");
const wifiSetupButton = document.querySelector("#wifi-setup-control");
const lastCommandStatus = document.querySelector("#last-command-status");
const setupProgress = document.querySelector("#setup-progress");

const wifiEls = {
  scanButton: document.querySelector("#scan-wifi"),
  currentSsid: document.querySelector("#wifi-current-ssid"),
  rssi: document.querySelector("#wifi-rssi"),
  status: document.querySelector("#wifi-status"),
  updated: document.querySelector("#wifi-updated"),
  error: document.querySelector("#wifi-error"),
  feedback: document.querySelector("#wifi-feedback"),
  networkSelect: document.querySelector("#wifi-network-select"),
  networkList: document.querySelector("#wifi-network-list"),
  profileList: document.querySelector("#wifi-profile-list"),
  connectForm: document.querySelector("#wifi-connect-form"),
};

let devices = [];
let selectedDeviceId = localStorage.getItem("smartRoomSelectedDevice") || "";
let currentControl = { mode: "AUTO", relay: false, buzzer: true };
let lastStatusClass = "";
let notificationsRequested = false;
let lastDeviceRefreshAt = 0;
let lastHistoryRefreshAt = 0;
let lastSummaryRefreshAt = 0;
let cachedHistory = [];
let cachedSummary = { total_records: 0, warning_count: 0, critical_count: 0 };
let cachedAlerts = [];
let deviceDeleteMode = false;
let selectedDeleteDevices = new Set();

const DEVICE_REFRESH_MS = 15000;
const SUMMARY_REFRESH_MS = 15000;
const HISTORY_REFRESH_MS = 30000;

function apiUrl(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}device_id=${encodeURIComponent(selectedDeviceId)}`;
}

function selectedHistoryRange() {
  return historyRange?.value || "24h";
}

function setSyncState(message, tone = "idle") {
  if (!syncState) return;
  syncState.textContent = message;
  syncState.classList.remove("syncing", "error");
  if (tone !== "idle") syncState.classList.add(tone);
}

function setFeedback(element, message, tone = "neutral") {
  if (!element) return;
  element.textContent = message;
  element.classList.remove("success", "error", "neutral");
  element.classList.add(tone);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${url} returned ${res.status}`);
  return data;
}

function fmt(value, suffix = "") {
  if (value === null || value === undefined || value === "" || Number.isNaN(value)) return "--";
  return `${value}${suffix}`;
}

function fmtNumber(value, decimals = 0, suffix = "") {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(decimals)}${suffix}`;
}

function fmtDigital(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "--";
  const numeric = Number(value);
  if (numeric === 0) return "LOW";
  if (numeric === 1) return "HIGH";
  return String(value);
}

function fmtSound(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "--";
  return Number(value) > 0 ? "HIGH" : "LOW";
}

function digitalSoundPoint(value) {
  return Number(value || 0) > 0 ? 1 : 0;
}

function fmtDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString();
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "--";
  const numeric = Number(seconds);
  if (numeric < 60) return `${Math.max(0, Math.round(numeric))} sec`;
  if (numeric < 3600) return `${Math.round(numeric / 60)} min`;
  return `${Math.round(numeric / 3600)} hr`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function normalizeStatus(status) {
  return String(status || "").toLowerCase();
}

function selectedDevice() {
  return devices.find((device) => device.device_id === selectedDeviceId);
}

function selectedDeviceLabel() {
  const device = selectedDevice();
  if (!device) return "No device selected";
  return device.room_name || device.device_name || device.device_id;
}

function activeViewName() {
  return document.querySelector(".page-tab.active")?.dataset.view || "overview";
}

function connectionLabel(state) {
  const labels = {
    ONLINE: "Online",
    DELAYED: "Delayed",
    OFFLINE: "Offline",
    WAITING_FOR_SETUP: "Waiting",
    PAIRING_EXPIRED: "Expired",
  };
  return labels[state] || "Waiting";
}

function setConnection(state) {
  latestEls.connection.classList.remove("live", "offline", "no-data", "delayed", "waiting");
  const className = state === "ONLINE" ? "live" : state === "DELAYED" ? "delayed" : state === "WAITING_FOR_SETUP" ? "waiting" : "offline";
  latestEls.connection.classList.add(className);
  latestEls.connection.textContent = connectionLabel(state);
}

function updateExportLink() {
  const rangeQuery = `range=${encodeURIComponent(selectedHistoryRange())}`;
  exportCsv.href = selectedDeviceId ? apiUrl(`/api/history/export.csv?${rangeQuery}`) : "#";
  exportSummary.href = selectedDeviceId ? apiUrl(`/api/summary/export.csv?${rangeQuery}`) : "#";
}

function renderDeviceOptions() {
  deviceSelect.innerHTML = "";
  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Add a room sensor first";
    option.disabled = true;
    option.selected = true;
    deviceSelect.appendChild(option);
    selectedDeviceId = "";
    latestEls.selectedRoom.textContent = "No device added";
    updateExportLink();
    return;
  }

  if (!devices.some((device) => device.device_id === selectedDeviceId)) {
    selectedDeviceId = devices[0].device_id;
    localStorage.setItem("smartRoomSelectedDevice", selectedDeviceId);
  }

  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.device_id;
    option.textContent = `${device.room_name || "Room"} (${connectionLabel(device.connection_state)})`;
    deviceSelect.appendChild(option);
  }
  deviceSelect.value = selectedDeviceId;
  latestEls.selectedRoom.textContent = selectedDeviceLabel();
  updateExportLink();
  updateSetupProgress();
}

function renderDeviceList() {
  deviceList.innerHTML = "";
  updateDeviceDeleteControls();
  onboardingPanel.hidden = false;
  if (!devices.length) {
    deviceList.innerHTML = '<div class="empty-state">No room sensor has been added yet.</div>';
    return;
  }
  for (const device of devices) {
    const card = document.createElement("article");
    card.className = `device-card${deviceDeleteMode ? " is-selecting" : ""}`;
    card.innerHTML = `
      ${deviceDeleteMode ? `
      <label class="device-select-check">
        <input type="checkbox" data-device-select="${escapeHtml(device.device_id)}" ${selectedDeleteDevices.has(device.device_id) ? "checked" : ""}>
        <span>Select</span>
      </label>` : ""}
      <div>
        <span class="overline">${escapeHtml(device.device_id)}</span>
        <h3>${escapeHtml(device.room_name || "Room")}</h3>
        <p>${escapeHtml(device.device_name || "Smart Room Sensor")}</p>
        ${device.pairing_code ? `
          <div class="device-pairing-code">
            <span>Pairing code</span>
            <strong>${escapeHtml(device.pairing_code)}</strong>
            <small>Expires ${fmtDate(device.pairing_expires_at)}</small>
          </div>
        ` : ""}
      </div>
      <dl>
        <div><dt>Status</dt><dd>${connectionLabel(device.connection_state)}</dd></div>
        <div><dt>Last seen</dt><dd>${fmtDate(device.last_seen)}</dd></div>
        <div><dt>WiFi</dt><dd>${escapeHtml(device.current_ssid || "--")}</dd></div>
      </dl>
    `;
    deviceList.appendChild(card);
  }
  updateSetupProgress();
}

function updateDeviceDeleteControls() {
  if (!startDeleteDevicesButton) return;
  startDeleteDevicesButton.hidden = deviceDeleteMode;
  confirmDeleteDevicesButton.hidden = !deviceDeleteMode;
  cancelDeleteDevicesButton.hidden = !deviceDeleteMode;
  confirmDeleteDevicesButton.textContent = selectedDeleteDevices.size
    ? `Confirm Delete (${selectedDeleteDevices.size})`
    : "Confirm Delete";
  confirmDeleteDevicesButton.disabled = selectedDeleteDevices.size === 0;
}

async function deleteDeviceRequest(deviceId) {
  await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }).then((res) => {
    if (!res.ok) throw new Error(`/api/devices delete returned ${res.status}`);
    return res.json();
  });
}

async function deleteSelectedDevices() {
  const ids = [...selectedDeleteDevices];
  if (!ids.length) return;
  const labels = ids.map((id) => {
    const device = devices.find((item) => item.device_id === id);
    return device?.room_name || device?.device_name || id;
  });
  if (!window.confirm(`Delete ${labels.join(", ")}? This removes selected devices from the dashboard and disables their tokens.`)) return;
  setFeedback(deviceDeleteFeedback, "Deleting selected devices...", "neutral");
  for (const id of ids) {
    await deleteDeviceRequest(id);
  }
  if (ids.includes(selectedDeviceId)) {
    localStorage.removeItem("smartRoomSelectedDevice");
    selectedDeviceId = "";
  }
  deviceDeleteMode = false;
  selectedDeleteDevices.clear();
  await loadUserAndDevices();
  await loadControlSettingsWifi();
  await refreshDashboard({ force: true });
  setFeedback(deviceDeleteFeedback, "Selected devices deleted.", "success");
}

async function loadUserAndDevices() {
  const [me, deviceRows] = await Promise.all([getJson("/api/me"), getJson("/api/devices")]);
  userName.textContent = me.name || "User";
  devices = deviceRows;
  lastDeviceRefreshAt = Date.now();
  renderDeviceOptions();
  renderDeviceList();
}

function updateLatest(data) {
  statusCard.classList.remove("normal", "warning", "critical");

  if (!data || !data.id) {
    const device = selectedDevice();
    setConnection(device?.connection_state || "OFFLINE");
    latestEls.status.textContent = device?.connection_state === "WAITING_FOR_SETUP" ? "PAIRING" : "STANDBY";
    latestEls.recommendation.textContent = device?.connection_state === "WAITING_FOR_SETUP"
      ? "Enter the pairing code on the ESP32 setup page."
      : "Waiting for the first sensor reading.";
    latestEls.temperature.textContent = "--";
    latestEls.humidity.textContent = "--";
    latestEls.gas.textContent = "--";
    latestEls.light.textContent = "--";
    latestEls.sound.textContent = "--";
    latestEls.lastUpdate.textContent = "--";
    latestEls.selectedRoom.textContent = selectedDeviceLabel();
    latestEls.fanRelayRow.classList.remove("relay-on");
    latestEls.fanRelayState.textContent = "OFF until CRITICAL status";
    comfortScore.textContent = "--";
    comfortLabel.textContent = "Waiting";
    renderInsightList(alertReasons, ["No room reading has been received yet."]);
    renderInsightList(actionRecommendations, ["Complete setup and wait for the first ESP32 upload."]);
    criticalAlert.hidden = true;
    return;
  }

  const statusClass = normalizeStatus(data.status);
  lastStatusClass = statusClass;
  setConnection(data.connection_state || selectedDevice()?.connection_state || "ONLINE");
  latestEls.temperature.textContent = fmtNumber(data.temperature, 1, " C");
  latestEls.humidity.textContent = fmtNumber(data.humidity, 1, " %");
  latestEls.gas.textContent = fmt(data.gas_raw);
  latestEls.light.textContent = fmtDigital(data.light_raw);
  latestEls.sound.textContent = fmtSound(data.sound_raw);
  latestEls.status.textContent = data.status;
  latestEls.recommendation.textContent = data.recommendation || "No recommendation.";
  latestEls.lastUpdate.textContent = new Date(data.created_at).toLocaleTimeString();
  latestEls.selectedRoom.textContent = selectedDeviceLabel();

  if (["normal", "warning", "critical"].includes(statusClass)) statusCard.classList.add(statusClass);
  criticalAlert.hidden = statusClass !== "critical";
  criticalAlertText.textContent = data.recommendation || "Immediate attention required.";
  if (statusClass === "critical") notifyCritical(data.recommendation || "Critical room condition detected.");
  comfortScore.textContent = data.comfort_score === null || data.comfort_score === undefined ? "--" : `${data.comfort_score}`;
  comfortLabel.textContent = data.comfort_label || "Waiting";
  renderInsightList(alertReasons, data.alert_reasons || ["No explanation available."]);
  renderInsightList(actionRecommendations, data.action_recommendations || [data.recommendation || "Review the latest reading."]);
  renderFanRelayState(statusClass);
}

function renderInsightList(element, items) {
  if (!element) return;
  element.innerHTML = "";
  const cleanItems = (items || []).filter(Boolean).slice(0, 4);
  if (!cleanItems.length) {
    element.innerHTML = "<li>No details available.</li>";
    return;
  }
  for (const item of cleanItems) {
    const li = document.createElement("li");
    li.textContent = item;
    element.appendChild(li);
  }
}

function updateSummary(data) {
  recordCount.textContent = `${fmt(data.total_records)} records`;
  summaryEls.avgTemp.textContent = fmtNumber(data.avg_temperature, 1, " C");
  summaryEls.avgHumidity.textContent = fmtNumber(data.avg_humidity, 1, " %");
  summaryEls.highestGas.textContent = fmt(data.highest_gas);
  summaryEls.avgSound.textContent = `${fmt(data.sound_trigger_count ?? data.avg_sound)} events`;
  summaryEls.warningCount.textContent = fmt(data.warning_count);
  summaryEls.criticalCount.textContent = fmt(data.critical_count);
  summaryEls.offlineDuration.textContent = fmtDuration(data.offline_seconds);
  healthScore.textContent = data.health_score === null || data.health_score === undefined ? "--" : `${data.health_score}`;
  healthLabel.textContent = data.health_label || "Waiting";
  healthReasons.textContent = (data.health_reasons && data.health_reasons.length)
    ? data.health_reasons.join(" ")
    : "Room device is operating within expected conditions.";
}

function statusBadge(status) {
  const normalized = normalizeStatus(status);
  const className = ["normal", "warning", "critical"].includes(normalized) ? normalized : "";
  return `<span class="status-badge ${className}">${status || "--"}</span>`;
}

function updateTable(rows) {
  historyBody.innerHTML = "";
  if (!rows.length) {
    historyBody.innerHTML = '<tr class="empty-row"><td colspan="7">No SQLite records yet. Waiting for ESP32 sensor upload.</td></tr>';
    return;
  }
  for (const row of [...rows].reverse().slice(0, 20)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(row.created_at).toLocaleString()}</td>
      <td>${fmtNumber(row.temperature, 1)}</td>
      <td>${fmtNumber(row.humidity, 1)}</td>
      <td>${fmt(row.gas_raw)}</td>
      <td>${fmtDigital(row.light_raw)}</td>
      <td>${fmtSound(row.sound_raw)}</td>
      <td>${statusBadge(row.status)}</td>
    `;
    historyBody.appendChild(tr);
  }
}

function prepareCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(Math.floor(rect.width), 280);
  const height = Math.max(Math.floor(rect.height), 160);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawEmptyChart(canvas, label) {
  const dims = prepareCanvas(canvas);
  const { ctx } = dims;
  ctx.clearRect(0, 0, dims.width, dims.height);
  ctx.fillStyle = "#071113";
  ctx.fillRect(0, 0, dims.width, dims.height);
  ctx.fillStyle = "#a9b2ad";
  ctx.font = "13px Arial";
  ctx.textAlign = "center";
  ctx.fillText(`Waiting for ${label}`, dims.width / 2, dims.height / 2);
  ctx.textAlign = "left";
}

function drawLine(ctx, points, color, minValue, maxValue, dims) {
  if (points.length < 2) return;
  const padX = 26;
  const padY = 24;
  const xStep = (dims.width - padX * 2) / Math.max(points.length - 1, 1);
  const range = Math.max(maxValue - minValue, 1);
  ctx.beginPath();
  points.forEach((value, index) => {
    const x = padX + index * xStep;
    const y = dims.height - padY - ((value - minValue) / range) * (dims.height - padY * 2);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

function drawSingleChart(config, points, latestText) {
  config.latest.textContent = latestText;
  if (!points.length) {
    drawEmptyChart(config.canvas, config.label);
    return;
  }
  const dims = prepareCanvas(config.canvas);
  const { ctx } = dims;
  ctx.clearRect(0, 0, dims.width, dims.height);
  ctx.fillStyle = "#071113";
  ctx.fillRect(0, 0, dims.width, dims.height);
  ctx.strokeStyle = "rgba(211, 231, 223, 0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = 24 + i * ((dims.height - 48) / 3);
    ctx.beginPath();
    ctx.moveTo(26, y);
    ctx.lineTo(dims.width - 18, y);
    ctx.stroke();
  }
  const minValue = Math.min(...points, 0);
  const maxValue = Math.max(...points, 1);
  drawLine(ctx, points, config.color, minValue, maxValue, dims);
  ctx.fillStyle = "rgba(255, 248, 236, 0.68)";
  ctx.font = "11px Arial";
  ctx.fillText(`max ${Math.round(maxValue)}`, 28, 17);
  ctx.fillText(`min ${Math.round(minValue)}`, 28, dims.height - 8);
}

function updateChart(rows) {
  if (!rows.length) {
    Object.values(charts).forEach((config) => {
      config.latest.textContent = "--";
      drawEmptyChart(config.canvas, config.label);
    });
    return;
  }
  const latest = rows[rows.length - 1];
  drawSingleChart(charts.temperature, rows.map((row) => Number(row.temperature)), fmtNumber(latest.temperature, 1, " C"));
  drawSingleChart(charts.gas, rows.map((row) => Number(row.gas_raw)), fmt(latest.gas_raw));
  drawSingleChart(charts.light, rows.map((row) => Number(row.light_raw)), fmtDigital(latest.light_raw));
  drawSingleChart(charts.sound, rows.map((row) => digitalSoundPoint(row.sound_raw)), fmtSound(latest.sound_raw));
}

function renderFanRelayState(statusClass = lastStatusClass) {
  const selectedMode = modeSelect.value || currentControl.mode;
  const relayCommand = relayControl.checked;
  const relaySaved = selectedMode === currentControl.mode && relayCommand === Boolean(currentControl.relay);
  const relayOn = selectedMode === "MANUAL" ? relayCommand : statusClass === "critical";
  latestEls.fanRelayRow.classList.toggle("relay-on", relayOn);
  latestEls.fanRelayState.textContent = selectedMode === "MANUAL"
    ? (relayOn ? (relaySaved ? "MANUAL ON through NO terminal" : "MANUAL ON after Apply Control") : (relaySaved ? "MANUAL OFF" : "MANUAL OFF after Apply Control"))
    : (statusClass === "critical" ? "AUTO ON through NO terminal" : "AUTO OFF until CRITICAL status");
}

function updateControlModeUi() {
  const manual = modeSelect.value === "MANUAL";
  relayControl.disabled = !manual;
  relayControlRow.classList.toggle("is-disabled", !manual);
  modeHelp.textContent = manual
    ? "MANUAL sends direct ON/OFF commands to the relay and buzzer for output testing."
    : "AUTO uses sensor status. Relay turns on only when status is CRITICAL.";
  relayHelp.textContent = manual
    ? (relayControl.checked ? "Manual command: fan relay ON" : "Manual command: fan relay OFF")
    : "AUTO protects the room. Manual relay switch is ignored until MANUAL mode is selected.";
  buzzerTitle.textContent = manual ? "Buzzer output" : "Buzzer armed";
  buzzerHelp.textContent = manual
    ? (buzzerControl.checked ? "Manual command: buzzer ON" : "Manual command: buzzer OFF")
    : (buzzerControl.checked ? "AUTO warning and critical alerts are allowed" : "AUTO alert sound is muted");
  renderFanRelayState();
}

function applyControlState(control, updateForm = true) {
  currentControl = { mode: control.mode || "AUTO", relay: Boolean(control.relay), buzzer: control.buzzer !== 0 };
  if (updateForm) {
    modeSelect.value = currentControl.mode;
    relayControl.checked = currentControl.relay;
    buzzerControl.checked = currentControl.buzzer;
  }
  updateControlModeUi();
}

function renderWifiStatus(data) {
  wifiEls.currentSsid.textContent = data.current_ssid || "--";
  wifiEls.rssi.textContent = data.wifi_rssi === null || data.wifi_rssi === undefined ? "--" : `${data.wifi_rssi} dBm`;
  wifiEls.status.textContent = data.wifi_status || "--";
  wifiEls.updated.textContent = fmtDate(data.wifi_updated_at);
  wifiEls.error.textContent = data.wifi_last_error || "";
  renderWifiNetworks(data.scan_results || []);
  renderWifiProfiles(data.saved_profiles || []);
}

function renderWifiNetworks(networks) {
  wifiEls.networkSelect.innerHTML = "";
  wifiEls.networkList.innerHTML = "";
  const strongestNetworks = [...networks.reduce((map, network) => {
    const ssid = String(network.ssid || "").trim();
    if (!ssid) return map;
    const current = map.get(ssid);
    if (!current || Number(network.rssi || -999) > Number(current.rssi || -999)) {
      map.set(ssid, network);
    }
    return map;
  }, new Map()).values()].sort((a, b) => Number(b.rssi || -999) - Number(a.rssi || -999));

  if (!strongestNetworks.length) {
    const option = document.createElement("option");
    option.textContent = "Run scan to see networks";
    option.value = "";
    wifiEls.networkSelect.appendChild(option);
    wifiEls.networkList.innerHTML = '<div class="empty-state">No WiFi scan results yet.</div>';
    return;
  }
  for (const network of strongestNetworks) {
    const option = document.createElement("option");
    option.value = network.ssid;
    option.textContent = `${network.ssid} (${network.rssi} dBm)`;
    wifiEls.networkSelect.appendChild(option);
    const card = document.createElement("div");
    card.className = "wifi-network-card";
    card.innerHTML = `<strong>${escapeHtml(network.ssid)}</strong><span>${network.rssi} dBm · ${escapeHtml(network.encryption || "security unknown")}</span>`;
    wifiEls.networkList.appendChild(card);
  }
}

function renderWifiProfiles(profiles) {
  wifiEls.profileList.innerHTML = "";
  if (!profiles.length) {
    wifiEls.profileList.innerHTML = '<div class="empty-state">No saved WiFi profiles reported by the device.</div>';
    return;
  }
  for (const profile of profiles) {
    const row = document.createElement("div");
    row.className = "wifi-profile-row";
    row.innerHTML = `
      <span><strong>${escapeHtml(profile.ssid)}</strong><small>Last success: ${fmtDate(profile.last_success_at)}</small></span>
      <span class="wifi-profile-actions">
        <button class="secondary-action compact-action" type="button" data-reconnect-ssid="${escapeHtml(profile.ssid)}" title="Use the password saved on the ESP32">Reconnect</button>
        <button class="secondary-action compact-action" type="button" data-forget-ssid="${escapeHtml(profile.ssid)}">Forget</button>
      </span>
    `;
    wifiEls.profileList.appendChild(row);
  }
}

function renderAlerts(items) {
  alertLog.innerHTML = "";
  if (!items.length) {
    alertLog.innerHTML = '<div class="empty-state">No alert events yet.</div>';
    return;
  }
  for (const item of items.slice(0, 8)) {
    const type = String(item.event_type || "event").toLowerCase();
    const tone = type.includes("critical") ? "critical" : type.includes("warning") ? "warning" : type.includes("fail") ? "failed" : "";
    const row = document.createElement("div");
    row.className = `alert-item ${tone}`;
    row.innerHTML = `
      <span class="alert-dot" aria-hidden="true"></span>
      <span><strong>${escapeHtml(item.event_type || "event")}</strong><small>${escapeHtml(item.message || "No details")}</small></span>
      <span class="alert-time">${fmtDate(item.created_at)}</span>
    `;
    alertLog.appendChild(row);
  }
}

function updateSetupProgress() {
  if (!setupProgress) return;
  const device = selectedDevice();
  const steps = setupProgress.querySelectorAll("li");
  steps.forEach((step) => step.classList.remove("done", "current"));
  if (!device) {
    steps[0]?.classList.add("current");
    return;
  }
  steps[0]?.classList.add("done");
  const state = device.connection_state || "";
  if (state === "WAITING_FOR_SETUP" || state === "PAIRING_EXPIRED") {
    steps[1]?.classList.add("current");
    return;
  }
  steps[1]?.classList.add("done");
  steps[2]?.classList.add("done");
  if (state === "ONLINE" || state === "DELAYED") steps[3]?.classList.add("done");
  else steps[3]?.classList.add("current");
}

function updateCommandStatus(control) {
  if (!lastCommandStatus) return;
  const updated = fmtDate(control.updated_at);
  const mode = control.mode || "AUTO";
  const relay = Number(control.relay || 0) ? "relay ON" : "relay OFF";
  const buzzer = Number(control.buzzer || 0) ? "buzzer ON" : "buzzer OFF";
  lastCommandStatus.textContent = `${mode} command queued: ${relay}, ${buzzer}. Updated ${updated}.`;
}

async function loadControlSettingsWifi() {
  if (!selectedDeviceId) {
    applyControlState({ mode: "AUTO", relay: 0, buzzer: 1 });
    return;
  }
  const [control, settings, wifi] = await Promise.all([
    getJson(apiUrl("/api/control")),
    getJson(apiUrl("/api/settings")),
    getJson(apiUrl("/api/wifi/status")),
  ]);
  applyControlState(control);
  updateCommandStatus(control);
  renderWifiStatus(wifi);
  const form = document.querySelector("#settings-form");
  for (const [key, value] of Object.entries(settings)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  const device = selectedDevice();
  if (device) {
    if (form.elements.device_name) form.elements.device_name.value = device.device_name || "";
    if (form.elements.room_name) form.elements.room_name.value = device.room_name || "";
  }
}

async function refreshDashboard(options = {}) {
  const now = Date.now();
  const view = activeViewName();
  const force = Boolean(options.force);

  if (force || now - lastDeviceRefreshAt > DEVICE_REFRESH_MS) {
    await loadUserAndDevices();
  }

  if (!devices.length || !selectedDeviceId) {
    setConnection("OFFLINE");
    updateLatest(null);
    updateTable([]);
    updateChart([]);
    updateSummary({ total_records: 0, warning_count: 0, critical_count: 0 });
    return;
  }
  try {
    setSyncState("Syncing...", "syncing");
    const shouldRefreshHistory = force || view === "history" || now - lastHistoryRefreshAt > HISTORY_REFRESH_MS;
    const shouldRefreshSummary = force || now - lastSummaryRefreshAt > SUMMARY_REFRESH_MS;
    const baseRequests = await Promise.all([
      getJson(apiUrl("/api/latest")),
      getJson(apiUrl("/api/control")),
      getJson(apiUrl("/api/wifi/status")),
      shouldRefreshHistory ? getJson(apiUrl(`/api/history?limit=120&range=${encodeURIComponent(selectedHistoryRange())}`)) : Promise.resolve(null),
      shouldRefreshSummary ? getJson(apiUrl(`/api/summary?range=${encodeURIComponent(selectedHistoryRange())}`)) : Promise.resolve(null),
      shouldRefreshSummary ? getJson(apiUrl("/api/alerts")) : Promise.resolve(null),
    ]);
    const [latest, control, wifi, history, summary, alerts] = baseRequests;
    applyControlState(control, false);
    updateCommandStatus(control);
    updateLatest(latest);
    renderWifiStatus(wifi);
    if (shouldRefreshHistory) {
      cachedHistory = history;
      lastHistoryRefreshAt = Date.now();
      updateTable(cachedHistory);
      updateChart(cachedHistory);
    }
    if (shouldRefreshSummary) {
      cachedSummary = summary;
      lastSummaryRefreshAt = Date.now();
      updateSummary(cachedSummary);
    }
    if (shouldRefreshSummary) {
      cachedAlerts = alerts;
      renderAlerts(cachedAlerts);
    }
    setSyncState(`Synced ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setConnection("OFFLINE");
    setSyncState("Sync failed", "error");
    console.error(error);
  }
}

function openSettings() {
  settingsBackdrop.hidden = false;
  settingsDrawer.classList.add("open");
  settingsDrawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  const firstInput = settingsDrawer.querySelector("input");
  if (firstInput) firstInput.focus();
}

function closeSettings() {
  settingsDrawer.classList.remove("open");
  settingsDrawer.setAttribute("aria-hidden", "true");
  settingsBackdrop.hidden = true;
  document.body.style.overflow = "";
}

function openDeviceDrawer() {
  deviceBackdrop.hidden = false;
  deviceDrawer.classList.add("open");
  deviceDrawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  const firstInput = deviceDrawer.querySelector("input");
  if (firstInput) firstInput.focus();
}

function closeDeviceDrawer() {
  deviceDrawer.classList.remove("open");
  deviceDrawer.setAttribute("aria-hidden", "true");
  deviceBackdrop.hidden = true;
  document.body.style.overflow = "";
}

function notifyCritical(message) {
  if (!("Notification" in window) || Notification.permission !== "granted" || notificationsRequested) return;
  notificationsRequested = true;
  new Notification("Smart Room Critical Alert", { body: message });
  setTimeout(() => { notificationsRequested = false; }, 30000);
}

document.querySelectorAll(".page-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".page-tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#view-${button.dataset.view}`).classList.add("active");
    if (button.dataset.view === "history") updateChart([]);
    setTimeout(() => refreshDashboard({ force: button.dataset.view === "history" }), 0);
  });
});

historyRange.addEventListener("change", () => {
  updateExportLink();
  lastHistoryRefreshAt = 0;
  lastSummaryRefreshAt = 0;
  refreshDashboard({ force: true });
});

document.querySelectorAll("[data-toggle-password]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.togglePassword);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    button.classList.toggle("is-visible", hidden);
    button.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  });
});

enableNotificationsButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    enableNotificationsButton.textContent = "Not supported";
    return;
  }
  const permission = await Notification.requestPermission();
  enableNotificationsButton.textContent = permission === "granted" ? "Notifications Enabled" : "Notifications Blocked";
});

openSettingsButton.addEventListener("click", openSettings);
closeSettingsButton.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);
addDeviceButtons.forEach((button) => button.addEventListener("click", openDeviceDrawer));
closeDeviceButton.addEventListener("click", closeDeviceDrawer);
deviceBackdrop.addEventListener("click", closeDeviceDrawer);

saveControlButton.addEventListener("click", async () => {
  if (!selectedDeviceId) {
    setFeedback(controlFeedback, "Add a device before sending control commands.", "error");
    return;
  }
  saveControlButton.disabled = true;
  saveControlButton.textContent = "Applying...";
  setFeedback(controlFeedback, "Sending control command...", "neutral");
  try {
    await postJson("/api/control", { device_id: selectedDeviceId, mode: modeSelect.value, relay: relayControl.checked, buzzer: buzzerControl.checked });
    await loadControlSettingsWifi();
    setFeedback(controlFeedback, "Control saved. ESP32 will apply it on the next command fetch.", "success");
    lastCommandStatus.textContent = `Command queued now: ${modeSelect.value}, relay ${relayControl.checked ? "ON" : "OFF"}, buzzer ${buzzerControl.checked ? "ON" : "OFF"}.`;
  } catch (error) {
    setFeedback(controlFeedback, error.message, "error");
  } finally {
    saveControlButton.disabled = false;
    saveControlButton.textContent = "Apply Control";
  }
});

modeSelect.addEventListener("change", updateControlModeUi);
relayControl.addEventListener("change", updateControlModeUi);
buzzerControl.addEventListener("change", updateControlModeUi);

document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedDeviceId) {
    setFeedback(settingsFeedback, "Add a device before saving settings.", "error");
    return;
  }
  const form = event.currentTarget;
  const payload = { device_id: selectedDeviceId };
  for (const element of form.elements) {
    if (element.name && !["device_name", "room_name"].includes(element.name)) payload[element.name] = element.value;
  }
  setFeedback(settingsFeedback, "Saving settings...", "neutral");
  try {
    await fetch(`/api/devices/${encodeURIComponent(selectedDeviceId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: form.elements.device_name.value, room_name: form.elements.room_name.value }),
    }).then((res) => {
      if (!res.ok) throw new Error(`/api/devices returned ${res.status}`);
      return res.json();
    });
    await postJson("/api/settings", payload);
    await loadUserAndDevices();
    await loadControlSettingsWifi();
    setFeedback(settingsFeedback, "Settings saved.", "success");
    setTimeout(closeSettings, 450);
  } catch (error) {
    setFeedback(settingsFeedback, error.message, "error");
  }
});

deviceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {};
  for (const element of event.currentTarget.elements) {
    if (element.name) payload[element.name] = element.value;
  }
  setFeedback(deviceFeedback, "Generating pairing code...", "neutral");
  try {
    const result = await postJson("/api/devices", payload);
    selectedDeviceId = result.device_id;
    localStorage.setItem("smartRoomSelectedDevice", selectedDeviceId);
    pairingCode.textContent = result.pairing_code;
    pairingDeviceName.textContent = payload.room_name || "New room sensor";
    pairingResult.hidden = false;
    await loadUserAndDevices();
    await loadControlSettingsWifi();
    await refreshDashboard();
    setFeedback(deviceFeedback, "Pairing code generated.", "success");
    setTimeout(closeDeviceDrawer, 450);
    document.querySelector('[data-view="devices"]').click();
  } catch (error) {
    setFeedback(deviceFeedback, error.message, "error");
  }
});

deviceSelect.addEventListener("change", async () => {
  selectedDeviceId = deviceSelect.value;
  localStorage.setItem("smartRoomSelectedDevice", selectedDeviceId);
  updateExportLink();
  await loadControlSettingsWifi();
  await refreshDashboard({ force: true });
});

wifiSetupButton.addEventListener("click", async () => {
  setFeedback(controlFeedback, "Sending setup mode command...", "neutral");
  try {
    await postJson("/api/control", { device_id: selectedDeviceId, mode: modeSelect.value, relay: relayControl.checked, buzzer: buzzerControl.checked, enter_setup: true });
    setFeedback(controlFeedback, "Command saved. Device will enter local setup mode on next fetch.", "success");
  } catch (error) {
    setFeedback(controlFeedback, error.message, "error");
  }
});

wifiEls.scanButton.addEventListener("click", async () => {
  setFeedback(wifiEls.feedback, "Requesting WiFi scan...", "neutral");
  try {
    await postJson("/api/wifi/scan", { device_id: selectedDeviceId });
    setFeedback(wifiEls.feedback, "Scan requested. Results appear after the device checks in.", "success");
  } catch (error) {
    setFeedback(wifiEls.feedback, error.message, "error");
  }
});

wifiEls.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const ssid = wifiEls.networkSelect.value;
  const password = form.elements.password.value;
  if (!ssid) {
    setFeedback(wifiEls.feedback, "Select a WiFi network first.", "error");
    return;
  }
  setFeedback(wifiEls.feedback, "Sending WiFi switch command...", "neutral");
  try {
    await postJson("/api/wifi/connect", { device_id: selectedDeviceId, ssid, password });
    form.elements.password.value = "";
    setFeedback(wifiEls.feedback, "WiFi command queued. Device will try it on next check-in.", "success");
  } catch (error) {
    setFeedback(wifiEls.feedback, error.message, "error");
  }
});

wifiEls.profileList.addEventListener("click", async (event) => {
  const reconnectButton = event.target.closest("[data-reconnect-ssid]");
  if (reconnectButton) {
    setFeedback(wifiEls.feedback, `Reconnecting to ${reconnectButton.dataset.reconnectSsid}...`, "neutral");
    try {
      await postJson("/api/wifi/reconnect", { device_id: selectedDeviceId, ssid: reconnectButton.dataset.reconnectSsid });
      setFeedback(wifiEls.feedback, "Reconnect command queued. ESP32 will use its locally saved password. If it fails, enter the password once to refresh the saved profile.", "success");
    } catch (error) {
      setFeedback(wifiEls.feedback, error.message, "error");
    }
    return;
  }
  const button = event.target.closest("[data-forget-ssid]");
  if (!button) return;
  setFeedback(wifiEls.feedback, `Forgetting ${button.dataset.forgetSsid}...`, "neutral");
  try {
    await postJson("/api/wifi/forget", { device_id: selectedDeviceId, ssid: button.dataset.forgetSsid });
    await loadControlSettingsWifi();
    setFeedback(wifiEls.feedback, "Forget command queued.", "success");
  } catch (error) {
    setFeedback(wifiEls.feedback, error.message, "error");
  }
});

deviceList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-device-select]");
  if (!checkbox) return;
  if (checkbox.checked) selectedDeleteDevices.add(checkbox.dataset.deviceSelect);
  else selectedDeleteDevices.delete(checkbox.dataset.deviceSelect);
  updateDeviceDeleteControls();
});

startDeleteDevicesButton?.addEventListener("click", () => {
  deviceDeleteMode = true;
  selectedDeleteDevices.clear();
  setFeedback(deviceDeleteFeedback, "Select the room sensors you want to delete.", "neutral");
  renderDeviceList();
});

cancelDeleteDevicesButton?.addEventListener("click", () => {
  deviceDeleteMode = false;
  selectedDeleteDevices.clear();
  setFeedback(deviceDeleteFeedback, "", "neutral");
  renderDeviceList();
});

confirmDeleteDevicesButton?.addEventListener("click", async () => {
  try {
    confirmDeleteDevicesButton.disabled = true;
    await deleteSelectedDevices();
  } catch (error) {
    setFeedback(deviceDeleteFeedback, error.message, "error");
  } finally {
    updateDeviceDeleteControls();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && settingsDrawer.classList.contains("open")) closeSettings();
  if (event.key === "Escape" && deviceDrawer.classList.contains("open")) closeDeviceDrawer();
});

loadUserAndDevices()
  .then(loadControlSettingsWifi)
  .then(() => {
    updateExportLink();
    return refreshDashboard({ force: true });
  })
  .catch((error) => {
    setConnection("OFFLINE");
    console.error(error);
  });

setInterval(refreshDashboard, 5000);
window.addEventListener("resize", () => updateChart(cachedHistory));

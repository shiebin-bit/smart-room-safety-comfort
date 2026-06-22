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
};

const historyBody = document.querySelector("#history-body");
const recordCount = document.querySelector("#record-count");
const charts = {
  temperature: {
    canvas: document.querySelector("#temp-chart"),
    latest: document.querySelector("#chart-temp-latest"),
    color: "#52d98f",
    label: "C",
  },
  gas: {
    canvas: document.querySelector("#gas-chart"),
    latest: document.querySelector("#chart-gas-latest"),
    color: "#ff6675",
    label: "raw",
  },
  light: {
    canvas: document.querySelector("#light-chart"),
    latest: document.querySelector("#chart-light-latest"),
    color: "#b68cff",
    label: "DO",
  },
  sound: {
    canvas: document.querySelector("#sound-chart"),
    latest: document.querySelector("#chart-sound-latest"),
    color: "#72a9ff",
    label: "OUT",
  },
};
const statusCard = document.querySelector(".status-card");
const settingsDrawer = document.querySelector("#settings-drawer");
const settingsBackdrop = document.querySelector("#settings-backdrop");
const openSettingsButton = document.querySelector("#open-settings");
const closeSettingsButton = document.querySelector("#close-settings");
const controlFeedback = document.querySelector("#control-feedback");
const settingsFeedback = document.querySelector("#settings-feedback");
const saveControlButton = document.querySelector("#save-control");
const modeSelect = document.querySelector("#mode");
const relayControl = document.querySelector("#relay");
const relayControlRow = document.querySelector("#relay-control-row");
const relayHelp = document.querySelector("#relay-help");
const buzzerControl = document.querySelector("#buzzer");
const buzzerTitle = document.querySelector("#buzzer-title");
const buzzerHelp = document.querySelector("#buzzer-help");
const modeHelp = document.querySelector("#mode-help");
let currentControl = { mode: "AUTO", relay: false, buzzer: true };
let lastStatusClass = "";

function setFeedback(element, message, tone = "neutral") {
  if (!element) return;
  element.textContent = message;
  element.classList.remove("success", "error", "neutral");
  element.classList.add(tone);
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
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
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
  const numeric = Number(value || 0);
  return numeric > 0 ? 1 : 0;
}

function normalizeStatus(status) {
  return String(status || "").toLowerCase();
}

function setConnection(state, label) {
  latestEls.connection.classList.remove("live", "offline", "no-data");
  latestEls.connection.classList.add(state);
  latestEls.connection.textContent = label;
}

function updateLatest(data) {
  statusCard.classList.remove("normal", "warning", "critical");

  if (!data || !data.id) {
    setConnection("no-data", "No data");
    latestEls.status.textContent = "STANDBY";
    latestEls.recommendation.textContent = "Start the ESP32 or send a sample reading to populate the dashboard.";
    latestEls.temperature.textContent = "--";
    latestEls.humidity.textContent = "--";
    latestEls.gas.textContent = "--";
    latestEls.light.textContent = "--";
    latestEls.sound.textContent = "--";
    latestEls.lastUpdate.textContent = "--";
    latestEls.fanRelayRow.classList.remove("relay-on");
    latestEls.fanRelayState.textContent = "OFF until CRITICAL status";
    return;
  }

  const statusClass = normalizeStatus(data.status);
  lastStatusClass = statusClass;
  setConnection("live", "Live");
  latestEls.temperature.textContent = fmtNumber(data.temperature, 1, " C");
  latestEls.humidity.textContent = fmtNumber(data.humidity, 1, " %");
  latestEls.gas.textContent = fmt(data.gas_raw);
  latestEls.light.textContent = fmtDigital(data.light_raw);
  latestEls.sound.textContent = fmtSound(data.sound_raw);
  latestEls.status.textContent = data.status;
  latestEls.recommendation.textContent = data.recommendation || "No recommendation.";
  latestEls.lastUpdate.textContent = new Date(data.created_at).toLocaleTimeString();

  if (["normal", "warning", "critical"].includes(statusClass)) {
    statusCard.classList.add(statusClass);
  }

  renderFanRelayState(statusClass);
}

function renderFanRelayState(statusClass = lastStatusClass) {
  const selectedMode = modeSelect.value || currentControl.mode;
  const relayCommand = relayControl.checked;
  const relaySaved = selectedMode === currentControl.mode && relayCommand === Boolean(currentControl.relay);
  const relayOn = selectedMode === "MANUAL" ? relayCommand : statusClass === "critical";
  latestEls.fanRelayRow.classList.toggle("relay-on", relayOn);
  latestEls.fanRelayState.textContent = selectedMode === "MANUAL"
    ? (relayOn
      ? (relaySaved ? "MANUAL ON through NO terminal" : "MANUAL ON after Apply Control")
      : (relaySaved ? "MANUAL OFF" : "MANUAL OFF after Apply Control"))
    : (statusClass === "critical" ? "AUTO ON through NO terminal" : "AUTO OFF until CRITICAL status");
}

function updateSummary(data) {
  recordCount.textContent = `${fmt(data.total_records)} records`;
  summaryEls.avgTemp.textContent = fmtNumber(data.avg_temperature, 1, " C");
  summaryEls.avgHumidity.textContent = fmtNumber(data.avg_humidity, 1, " %");
  summaryEls.highestGas.textContent = fmt(data.highest_gas);
  summaryEls.avgSound.textContent = `${fmt(data.sound_trigger_count ?? data.avg_sound)} events`;
  summaryEls.warningCount.textContent = fmt(data.warning_count);
  summaryEls.criticalCount.textContent = fmt(data.critical_count);
}

function statusBadge(status) {
  const normalized = normalizeStatus(status);
  const className = ["normal", "warning", "critical"].includes(normalized) ? normalized : "";
  return `<span class="status-badge ${className}">${status || "--"}</span>`;
}

function updateTable(rows) {
  historyBody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    tr.innerHTML = '<td colspan="7">No SQLite records yet. Waiting for ESP32 sensor upload.</td>';
    historyBody.appendChild(tr);
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

function drawLine(ctx, points, color, minValue, maxValue, dims) {
  if (points.length < 2) return;
  const { width, height } = dims;
  const padX = 26;
  const padY = 24;
  const xStep = (width - padX * 2) / Math.max(points.length - 1, 1);
  const range = Math.max(maxValue - minValue, 1);

  ctx.beginPath();
  points.forEach((value, index) => {
    const x = padX + index * xStep;
    const y = height - padY - ((value - minValue) / range) * (height - padY * 2);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
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

function drawSingleChart(config, points, latestText) {
  config.latest.textContent = latestText;
  const dims = prepareCanvas(config.canvas);
  const { ctx } = dims;

  if (!points.length) {
    drawEmptyChart(config.canvas, config.label);
    return;
  }

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
  drawSingleChart(
    charts.temperature,
    rows.map((row) => Number(row.temperature)),
    fmtNumber(latest.temperature, 1, " C"),
  );
  drawSingleChart(
    charts.gas,
    rows.map((row) => Number(row.gas_raw)),
    fmt(latest.gas_raw),
  );
  drawSingleChart(
    charts.light,
    rows.map((row) => Number(row.light_raw)),
    fmtDigital(latest.light_raw),
  );
  drawSingleChart(
    charts.sound,
    rows.map((row) => digitalSoundPoint(row.sound_raw)),
    fmtSound(latest.sound_raw),
  );
}

async function refreshDashboard() {
  try {
    const [latest, history, summary, control] = await Promise.all([
      getJson("/api/latest"),
      getJson("/api/history?limit=200"),
      getJson("/api/summary"),
      getJson("/api/control"),
    ]);
    applyControlState(control, false);
    updateLatest(latest);
    updateTable(history);
    updateChart(history);
    updateSummary(summary);
  } catch (error) {
    setConnection("offline", "Offline");
    console.error(error);
  }
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
  currentControl = {
    mode: control.mode || "AUTO",
    relay: Boolean(control.relay),
    buzzer: control.buzzer !== 0,
  };
  if (updateForm) {
    modeSelect.value = currentControl.mode;
    relayControl.checked = currentControl.relay;
    buzzerControl.checked = currentControl.buzzer;
  }
  updateControlModeUi();
}

async function loadControlAndSettings() {
  const [control, settings] = await Promise.all([
    getJson("/api/control"),
    getJson("/api/settings"),
  ]);

  applyControlState(control);

  const form = document.querySelector("#settings-form");
  for (const [key, value] of Object.entries(settings)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  if (form.elements.upload_interval && !form.elements.upload_interval.value) {
    form.elements.upload_interval.value = 5;
  }
}

saveControlButton.addEventListener("click", async () => {
  saveControlButton.disabled = true;
  saveControlButton.textContent = "Applying...";
  setFeedback(controlFeedback, "Sending control command...", "neutral");
  try {
    await postJson("/api/control", {
      device_id: "ESP32_ROOM_01",
      mode: modeSelect.value,
      relay: relayControl.checked,
      buzzer: buzzerControl.checked,
    });
    await loadControlAndSettings();
    setFeedback(controlFeedback, "Control saved. ESP32 will apply it on the next command fetch.", "success");
  } catch (error) {
    console.error(error);
    setFeedback(controlFeedback, "Control failed. Check Flask server and browser console.", "error");
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
  const form = event.currentTarget;
  const payload = { device_id: "ESP32_ROOM_01" };
  for (const element of form.elements) {
    if (element.name) payload[element.name] = element.value;
  }
  setFeedback(settingsFeedback, "Saving settings...", "neutral");
  try {
    await postJson("/api/settings", payload);
    await loadControlAndSettings();
    setFeedback(settingsFeedback, "Settings saved.", "success");
    setTimeout(closeSettings, 450);
  } catch (error) {
    console.error(error);
    setFeedback(settingsFeedback, "Settings failed. Check Flask server and input values.", "error");
  }
});

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
  openSettingsButton.focus();
}

openSettingsButton.addEventListener("click", openSettings);
closeSettingsButton.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && settingsDrawer.classList.contains("open")) {
    closeSettings();
  }
});

loadControlAndSettings();
refreshDashboard();
setInterval(refreshDashboard, 3000);
window.addEventListener("resize", () => refreshDashboard());

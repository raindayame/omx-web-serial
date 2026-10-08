/* OMX Web Serial — 純前端 ESP32 氣體感測量測
 * 協定（對應 device_service.py）:
 *  - 115200 baud，UTF-8 文字行
 *  - 行內含 "SELECT MOD" -> 回寫 "1\\n"
 *  - 資料行須同時含 TEMP / HUMD，格式如 "123.4A 125.6B ... 25.3TEMP 60.1HUMD"
 *  - 首行自動偵測通道（16 / 32）；ADC 校正指令 "y{v1} {v2} {v3} {v4}\\n"
 */
"use strict";

const $ = (id) => document.getElementById(id);

/* ---------------- 日誌 ---------------- */
function log(msg) {
  const box = $("logBox");
  const div = document.createElement("div");
  const t = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  div.innerHTML = `<span class="t">${t}</span>${msg}`;
  box.appendChild(div);
  while (box.children.length > 150) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 設定（localStorage） ---------------- */
const store = {
  load() {
    try { return JSON.parse(localStorage.getItem("omx-web-serial") || "{}"); }
    catch { return {}; }
  },
  save(cfg) {
    try { localStorage.setItem("omx-web-serial", JSON.stringify(cfg)); } catch {}
  },
};

/* ---------------- 狀態 ---------------- */
const S = {
  port: null, reader: null, writer: null, keepReading: false,
  connected: false,
  channels: [], hasData: false,
  interval: 1, startTime: 0, lastRecordSec: 0,
  accum: {}, tempAcc: [], humdAcc: [],
  timeBuf: [], dataBuf: {}, sensBuf: {}, tempBuf: [], humdBuf: [],
  r0: {}, hasR0: false,
  mode: "RESISTANCE",
  csvRows: [], recording: false, recResRows: [], recSensRows: [],
  timerSec: 0, timerRunning: false,
  chPage: 0,
  adc: [3.28, 3.27, 3.27, 3.28],
  rules: {
    resistance: { enabled: false, min: 0, max: 1000 },
    sensitivity: { enabled: false, min: 0, max: 5 },
  },
  lineBuf: "",
};

const MAXP = 3600;
function pushBuf(arr, v) { arr.push(v); if (arr.length > MAXP) arr.shift(); }

/* ---------------- 圖表 ---------------- */
let mainChart, envChart;
function initCharts() {
  mainChart = new LineChart($("mainChart"), { windowSec: 600 });
  envChart = new LineChart($("envChart"), { windowSec: 600 });
  envChart.setSeries("temp", "#f87171");
  envChart.setSeries("humd", "#38bdf8");
}

/* ---------------- 序列埠 ---------------- */
async function connectSerial() {
  if (!("serial" in navigator)) {
    log("此瀏覽器不支援 Web Serial，請改用 Chrome / Edge。");
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    const baudRate = parseInt($("baudSel").value, 10);
    await port.open({ baudRate });
    S.port = port;
    S.writer = port.writable.getWriter();
    resetSession();
    S.connected = true;
    S.keepReading = true;
    updateConnUI();
    log(`已連接 COM（${baudRate} baud），等待硬體資料以進行通道自適應偵測…`);
    readLoop();
  } catch (e) {
    if (e.name !== "NotFoundError") log(`連線失敗：${e.message}`);
  }
}

async function disconnectSerial() {
  S.keepReading = false;
  try { if (S.reader) await S.reader.cancel(); } catch {}
  try { if (S.writer) { S.writer.releaseLock(); } } catch {}
  try { if (S.port) await S.port.close(); } catch {}
  S.port = null; S.reader = null; S.writer = null;
  S.connected = false;
  updateConnUI();
  log("已斷開連線。");
}

async function readLoop() {
  const decoder = new TextDecoderStream();
  S.port.readable.pipeTo(decoder.writable).catch(() => {});
  S.reader = decoder.readable.getReader();
  try {
    while (S.keepReading) {
      const { value, done } = await S.reader.read();
      if (done) break;
      if (value) handleText(value);
    }
  } catch (e) {
    if (S.keepReading) log(`讀取中斷：${e.message}`);
  }
}

async function writeLine(text) {
  if (!S.writer) throw new Error("尚未連線");
  await S.writer.write(new TextEncoder().encode(text));
}

function handleText(chunk) {
  S.lineBuf += chunk;
  let idx;
  while ((idx = S.lineBuf.indexOf("\n")) >= 0) {
    const line = S.lineBuf.slice(0, idx).trim();
    S.lineBuf = S.lineBuf.slice(idx + 1);
    if (line) handleLine(line);
  }
}

/* ---------------- 協定解析 ---------------- */
function handleLine(line) {
  if (line.includes("SELECT MOD")) {
    writeLine("1\n").catch((e) => log(`回寫 SELECT MOD 失敗：${e.message}`));
    return;
  }
  if (!line.includes("TEMP") || !line.includes("HUMD")) return;

  const clean = line.replace(/TEMP/g, " ").replace(/HUMD/g, " ");
  const matches = [...clean.matchAll(/([-0-9.]+)([a-zA-Z]+)/g)];
  if (!matches.length) return;

  if (!S.hasData) {
    S.channels = matches.map((m) => m[2]);
    S.hasData = true;
    for (const ch of S.channels) {
      S.accum[ch] = []; S.dataBuf[ch] = []; S.sensBuf[ch] = [];
      mainChart.setSeries(ch, "#94a3b8");
    }
    log(`自動偵測完成：${S.channels.length} 通道（${S.channels.join(",")}）。`);
    renderChannelGrid();
  }
  const parsed = {};
  for (const m of matches) parsed[m[2]] = parseFloat(m[1]);
  if (!S.channels.every((ch) => ch in parsed)) return;

  const tm = line.match(/([-0-9.]+)TEMP/);
  const hm = line.match(/([-0-9.]+)HUMD/);
  for (const ch of S.channels) S.accum[ch].push(parsed[ch]);
  if (tm) S.tempAcc.push(parseFloat(tm[1]));
  if (hm) S.humdAcc.push(parseFloat(hm[1]));

  const elapsed = (performance.now() - S.startTime) / 1000;
  if (elapsed - S.lastRecordSec < S.interval) return;
  S.lastRecordSec = elapsed;
  recordSample(Math.round(elapsed));
}

function recordSample(recordSec) {
  const avg = {};
  for (const ch of S.channels) {
    const a = S.accum[ch];
    avg[ch] = a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    S.accum[ch] = [];
  }
  const avgT = S.tempAcc.length ? S.tempAcc.reduce((x, y) => x + y, 0) / S.tempAcc.length : 0;
  const avgH = S.humdAcc.length ? S.humdAcc.reduce((x, y) => x + y, 0) / S.humdAcc.length : 0;
  S.tempAcc = []; S.humdAcc = [];

  if (!S.hasR0) { S.r0 = { ...avg }; S.hasR0 = true; log("R0 已自動擷取（首筆平均值）。"); }

  pushBuf(S.timeBuf, recordSec);
  pushBuf(S.tempBuf, avgT); pushBuf(S.humdBuf, avgH);
  const sens = {};
  for (const ch of S.channels) {
    pushBuf(S.dataBuf[ch], avg[ch]);
    const r0 = S.r0[ch] || 1;
    const sv = r0 !== 0 ? avg[ch] / r0 : 1;
    pushBuf(S.sensBuf[ch], sv);
    sens[ch] = sv;
    mainChart.push(ch, recordSec, S.mode === "SENSITIVITY" ? sv : avg[ch]);
  }
  envChart.push("temp", recordSec, avgT);
  envChart.push("humd", recordSec, avgH);

  const row = [recordSec, ...S.channels.map((ch) => avg[ch].toFixed(3)), avgT.toFixed(2), avgH.toFixed(2)];
  S.csvRows.push(row);
  if (S.recording) {
    S.recResRows.push(row);
    S.recSensRows.push([recordSec, ...S.channels.map((ch) => sens[ch].toFixed(4)), avgT.toFixed(2), avgH.toFixed(2)]);
  }
  updateLiveUI(avg, sens, avgT, avgH, recordSec);
}

/* ---------------- 即時 UI ---------------- */
function activeRule() {
  return S.mode === "SENSITIVITY" ? S.rules.sensitivity : S.rules.resistance;
}

function judge(value) {
  const r = activeRule();
  if (!r.enabled) return null;
  return value >= r.min && value <= r.max ? "pass" : "fail";
}

function channelColor(value) {
  const r = activeRule();
  if (!r.enabled) return "#94a3b8";
  const c = LineChart.spectrumColor(value, r.min, r.max);
  return c || "#475569";   // NO PASS -> 灰
}

function updateLiveUI(avg, sens, avgT, avgH, recordSec) {
  $("modTemp").textContent = avgT.toFixed(2);
  $("modHumd").textContent = avgH.toFixed(2);

  // 通道卡
  const vals = S.mode === "SENSITIVITY" ? sens : avg;
  const unit = S.mode === "SENSITIVITY" ? "R/R0" : "kΩ";
  for (const ch of S.channels) {
    const el = document.querySelector(`[data-ch="${ch}"]`);
    if (!el) continue;
    const v = vals[ch];
    el.querySelector(".ch-val").textContent = S.mode === "SENSITIVITY" ? v.toFixed(4) : v.toFixed(2);
    el.querySelector(".ch-unit").textContent = unit;
    const j = judge(v);
    el.classList.toggle("pass", j === "pass");
    el.classList.toggle("fail", j === "fail");
    el.querySelector(".ch-badge").textContent = j === "pass" ? "PASS" : j === "fail" ? "NO PASS" : ch;
  }

  // 主圖
  const colorFn = activeRule().enabled ? (v) => channelColor(v) : null;
  mainChart.draw(recordSec, S.mode === "SENSITIVITY" ? "靈敏度 R/R0" : "電阻 kΩ", colorFn);
  envChart.draw(recordSec, "℃ / %");

  const mm = String(Math.floor(recordSec / 60)).padStart(2, "0");
  const ss = String(recordSec % 60).padStart(2, "0");
  $("chartInfo").textContent =
    `已記錄 ${S.timeBuf.length} 點 · 經過 ${mm}:${ss} · ${S.channels.length} 通道 · ` +
    (S.recording ? "● 記錄中" : "未記錄");
}

function renderChannelGrid() {
  const grid = $("chGrid");
  grid.innerHTML = "";
  const start = S.chPage * 16;
  const list = S.channels.slice(start, start + 16);
  $("chPageLabel").textContent = S.channels.length > 16 ? `(${start + 1}–${start + list.length})` : "";
  for (const ch of list) {
    const d = document.createElement("div");
    d.className = "ch-card"; d.dataset.ch = ch;
    d.innerHTML = `<span class="ch-badge">${ch}</span><div class="ch-name">CH ${ch}</div>
      <div><span class="ch-val">--</span> <span class="ch-unit"></span></div>`;
    grid.appendChild(d);
  }
}

/* ---------------- 連線 UI ---------------- */
function updateConnUI() {
  $("btnConnect").disabled = S.connected;
  $("btnDisconnect").disabled = !S.connected;
  $("connStatus").classList.toggle("on", S.connected);
  $("connText").textContent = S.connected ? "已連線" : "未連線";
}

function resetSession() {
  Object.assign(S, {
    channels: [], hasData: false, startTime: performance.now(), lastRecordSec: 0,
    accum: {}, tempAcc: [], humdAcc: [],
    timeBuf: [], dataBuf: {}, sensBuf: {}, tempBuf: [], humdBuf: [],
    r0: {}, hasR0: false, csvRows: [], lineBuf: "",
  });
  mainChart.clear(); envChart.clear();
  $("chGrid").innerHTML = "";
  $("chartInfo").textContent = "等待資料…";
  if (S.recording) stopRecording(false);
}

/* ---------------- CSV 下載 ---------------- */
function downloadCSV(filename, rows) {
  const header = ["Time(s)", ...S.channels, "TEMP", "HUMD"];
  const text = "\uFEFF" + [header, ...rows].map((r) => r.join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stopRecording(download = true) {
  if (!S.recording) return;
  S.recording = false;
  $("btnRecStart").disabled = false;
  $("btnRecStop").disabled = true;
  if (download && S.recResRows.length) {
    downloadCSV(`gas_resistance_${stamp()}.csv`, S.recResRows);
    downloadCSV(`gas_senstivity_${stamp()}.csv`, S.recSensRows);
    log(`記錄停止，已下載 ${S.recResRows.length} 筆。`);
  }
  S.recResRows = []; S.recSensRows = [];
}

/* ---------------- ADC 校正 ---------------- */
function fmtAdc(v) { return String(parseFloat(Number(v).toFixed(4))); }
function readAdcInputs() {
  const vs = ["adc1", "adc2", "adc3", "adc4"].map((id) => parseFloat($(id).value));
  if (vs.length !== 4 || vs.some((v) => !Number.isFinite(v) || v <= 0 || v > 6)) {
    throw new Error("ADC 校正值需為 0 ~ 6 V 之間的有效數字（共 4 組）");
  }
  return vs;
}

/* ---------------- 事件綁定 ---------------- */
function bindEvents() {
  $("btnConnect").onclick = connectSerial;
  $("btnDisconnect").onclick = disconnectSerial;

  $("intervalInput").onchange = (e) => {
    S.interval = Math.max(1, parseInt(e.target.value, 10) || 1);
    saveSettings();
  };
  $("baudSel").onchange = saveSettings;

  $("btnCalSend").onclick = async () => {
    try {
      const vs = readAdcInputs();
      S.adc = vs; saveSettings();
      await writeLine("y" + vs.map(fmtAdc).join(" ") + "\n");
      $("calState").textContent = "已送出";
      log(`ADC 校正指令已送出 (y${vs.map(fmtAdc).join(" ")})`);
    } catch (e) { log(`校正失敗：${e.message}`); }
  };

  $("btnMode").onclick = () => {
    S.mode = S.mode === "RESISTANCE" ? "SENSITIVITY" : "RESISTANCE";
    const isSens = S.mode === "SENSITIVITY";
    $("btnMode").textContent = isSens ? "靈敏度模式" : "電阻模式";
    $("btnMode").classList.toggle("on", isSens);
    $("chartTitle").textContent = isSens ? "即時監控圖 — 靈敏度 (R/R0)" : "即時監控圖 — 電阻 (kΩ)";
    // 重建圖表序列以切換數值
    mainChart.clear();
    for (const ch of S.channels) mainChart.setSeries(ch, "#94a3b8");
    const n = S.timeBuf.length;
    for (let i = 0; i < n; i++) {
      const t = S.timeBuf[i];
      for (const ch of S.channels) {
        const buf = isSens ? S.sensBuf[ch] : S.dataBuf[ch];
        if (buf[i] !== undefined) mainChart.push(ch, t, buf[i]);
      }
    }
    log(`切換為${isSens ? "靈敏度" : "電阻"}模式。`);
  };

  $("btnR0").onclick = () => {
    if (!S.hasData || !S.timeBuf.length) { log("尚無資料，無法設置 Rair。"); return; }
    for (const ch of S.channels) {
      const b = S.dataBuf[ch];
      if (b.length) S.r0[ch] = b[b.length - 1];
    }
    // 靈敏度緩衝需重算
    for (const ch of S.channels) {
      S.sensBuf[ch] = S.dataBuf[ch].map((v) => (S.r0[ch] ? v / S.r0[ch] : 1));
    }
    log("設置 Rair 成功（以目前最新值為基準）。");
  };

  $("btnRecStart").onclick = () => {
    if (!S.hasData) { log("尚未收到通道資料，無法開始記錄。"); return; }
    S.recording = true; S.recResRows = []; S.recSensRows = [];
    $("btnRecStart").disabled = true;
    $("btnRecStop").disabled = false;
    log("開始手動記錄。");
  };
  $("btnRecStop").onclick = () => stopRecording(true);

  $("btnTimerStart").onclick = () => { S.timerRunning = true; };
  $("btnTimerStop").onclick = () => { S.timerRunning = false; };
  $("btnTimerReset").onclick = () => { S.timerRunning = false; S.timerSec = 0; drawTimer(); };
  setInterval(() => { if (S.timerRunning) { S.timerSec++; drawTimer(); } }, 1000);

  $("btnChPrev").onclick = () => { if (S.chPage > 0) { S.chPage--; renderChannelGrid(); } };
  $("btnChNext").onclick = () => {
    if ((S.chPage + 1) * 16 < S.channels.length) { S.chPage++; renderChannelGrid(); }
  };

  const ruleIds = [
    ["ruleResEn", "resistance", "enabled"], ["ruleResMin", "resistance", "min"], ["ruleResMax", "resistance", "max"],
    ["ruleSensEn", "sensitivity", "enabled"], ["ruleSensMin", "sensitivity", "min"], ["ruleSensMax", "sensitivity", "max"],
  ];
  for (const [id, key, prop] of ruleIds) {
    $(id).onchange = (e) => {
      const v = prop === "enabled" ? e.target.checked : parseFloat(e.target.value);
      S.rules[key][prop] = v;
      saveSettings();
    };
  }

  window.addEventListener("beforeunload", () => {
    if (S.recording && S.recResRows.length) {
      downloadCSV(`gas_resistance_${stamp()}.csv`, S.recResRows);
    }
  });
}

function drawTimer() {
  const h = String(Math.floor(S.timerSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((S.timerSec % 3600) / 60)).padStart(2, "0");
  const s = String(S.timerSec % 60).padStart(2, "0");
  $("timerDisplay").textContent = `${h}:${m}:${s}`;
}

/* ---------------- 設定存取 ---------------- */
function saveSettings() {
  store.save({
    baud: $("baudSel").value, interval: S.interval, adc: S.adc, rules: S.rules,
  });
}
function loadSettings() {
  const c = store.load();
  if (c.baud) $("baudSel").value = c.baud;
  if (c.interval) { S.interval = c.interval; $("intervalInput").value = c.interval; }
  if (Array.isArray(c.adc) && c.adc.length === 4) {
    S.adc = c.adc;
    ["adc1", "adc2", "adc3", "adc4"].forEach((id, i) => { $(id).value = c.adc[i]; });
  }
  if (c.rules) {
    Object.assign(S.rules.resistance, c.rules.resistance || {});
    Object.assign(S.rules.sensitivity, c.rules.sensitivity || {});
    $("ruleResEn").checked = S.rules.resistance.enabled;
    $("ruleResMin").value = S.rules.resistance.min;
    $("ruleResMax").value = S.rules.resistance.max;
    $("ruleSensEn").checked = S.rules.sensitivity.enabled;
    $("ruleSensMin").value = S.rules.sensitivity.min;
    $("ruleSensMax").value = S.rules.sensitivity.max;
  }
}

/* ---------------- 啟動 ---------------- */
initCharts();
loadSettings();
bindEvents();
drawTimer();
if (!("serial" in navigator)) {
  log("提醒：此瀏覽器不支援 Web Serial API，請使用 Chrome / Edge 開啟本頁。");
} else {
  log("就緒。按下「連接 COM」並選擇 ESP32 序列埠即可開始量測。");
}

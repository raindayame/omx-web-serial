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

// 結構化事件（Keithley 模式匯出用），同時寫入日誌
function recordEvent(kind, msg) {
  S.events.push({ t: new Date(), kind, msg });
  log(`[${kind}] ${msg}`);
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
  instrument: "esp32",
  channels: [], hasData: false,
  interval: 1, startTime: 0, lastRecordSec: 0,
  accum: {}, tempAcc: [], humdAcc: [],
  timeBuf: [], dataBuf: {}, sensBuf: {}, tempBuf: [], humdBuf: [],
  r0: {}, hasR0: false,
  mode: "RESISTANCE",
  csvRows: [], recording: false, recResRows: [], recSensRows: [],
  timerSec: 0, timerRunning: false,
  chPage: 0,
  dirHandle: null, segMs: 0, segStart: 0, segBusy: false, segFileHandle: null,
  events: [],
  k: {
    vSet: 1.0, comp: 0.1, outputOn: false, paused: false,
    buf: "", pending: null, loopRunning: false,
    samples: [], baselines: [],
  },
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
// 取得已開啟的 port：重用上次的 → 已配對的 → 選擇器
async function acquirePort(baudRate) {
  if (S.port) {
    try { await S.port.open({ baudRate }); return S.port; }
    catch { S.port = null; } // 裝置可能已拔除
  }
  const ports = await navigator.serial.getPorts();
  if (ports.length) {
    try { await ports[0].open({ baudRate }); S.port = ports[0]; return S.port; }
    catch { /* 掉到選擇器 */ }
  }
  const port = await navigator.serial.requestPort(); // 使用者取消會丟 NotFoundError
  await port.open({ baudRate });
  S.port = port;
  return port;
}

async function esp32Setup(port, baudRate) {
  S.port = port;
  S.writer = port.writable.getWriter();
  resetSession();
  S.connected = true;
  S.keepReading = true;
  updateConnUI();
  log(`已連接 COM（${baudRate} baud），等待硬體資料以進行通道自適應偵測…`);
  readLoop();
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    log("此瀏覽器不支援 Web Serial，請改用 Chrome / Edge。");
    return;
  }
  const baudRate = parseInt($("baudSel").value, 10);
  try {
    const port = await acquirePort(baudRate);
    if (S.instrument === "keithley") await keithleySetup(port, baudRate);
    else await esp32Setup(port, baudRate);
  } catch (e) {
    if (e.name !== "NotFoundError") log(`連線失敗：${e.message}`);
  }
}

async function disconnectSerial() {
  S.keepReading = false;
  // Keithley：先關 Output 並驗證（安全）
  if (S.instrument === "keithley" && S.connected && S.k.outputOn) {
    try {
      await scpiWrite(":OUTP OFF");
      await new Promise((r) => setTimeout(r, 300));
      const st = await scpiQuery(":OUTP?", 2000).catch(() => null);
      S.k.outputOn = false;
      if (st && st.trim() !== "0" && st.trim() !== "+0") {
        recordEvent("SAFETY", "OUTPUT OFF 未驗證：" + st);
        log("警告：無法確認 Output 已關閉，請檢查儀器面板。");
      } else {
        recordEvent("OUTPUT", "OFF");
      }
    } catch (e) { log("關閉 Output 失敗：" + e.message); }
    S.k.outputOn = false;
  }
  try { if (S.reader) await S.reader.cancel(); } catch {}
  try { if (S.writer) { S.writer.releaseLock(); } } catch {}
  try { if (S.port) await S.port.close(); } catch {}
  // 保留 S.port：下次按連接可直接重開，不用再選一次
  S.reader = null; S.writer = null;
  S.connected = false;
  updateConnUI();
  log("已斷開連線。再次按下「連接 COM」可直接重連。");
}

async function forgetDevice() {
  try {
    const port = S.port || (await navigator.serial.getPorts())[0];
    if (port) { try { await port.forget(); } catch {} }
  } catch {}
  S.port = null;
  log("已忘記裝置，下次連接會重新跳出選擇器。");
}

/* ---------------- Keithley 2400 SCPI ---------------- */
function scpiWrite(cmd) {
  return writeLine(cmd + "\n");
}
function scpiQuery(cmd, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (S.k.pending) { reject(new Error("SCPI 忙碌中")); return; }
    const timer = setTimeout(() => {
      if (S.k.pending && S.k.pending.resolve === resolve) {
        S.k.pending = null;
        reject(new Error("SCPI 逾時：" + cmd));
      }
    }, timeoutMs);
    S.k.pending = {
      resolve: (v) => { clearTimeout(timer); S.k.pending = null; resolve(v); },
      reject: (e) => { clearTimeout(timer); S.k.pending = null; reject(e); },
    };
    writeLine(cmd + "\n").catch(S.k.pending.reject);
  });
}
function kHandleText(chunk) {
  S.k.buf += chunk;
  let idx;
  while ((idx = S.k.buf.indexOf("\n")) >= 0) {
    const line = S.k.buf.slice(0, idx).trim();
    S.k.buf = S.k.buf.slice(idx + 1);
    if (!line) continue;
    if (S.k.pending) S.k.pending.resolve(line);
    else log("儀器訊息：" + line);
  }
}

function resetKeithleySession() {
  Object.assign(S.k, {
    buf: "", pending: null, paused: false, outputOn: false, loopRunning: false,
    samples: [], baselines: [],
  });
  S.events = [];
  S.channels = ["K2400"];
  S.hasData = true;
  S.csvRows = [];
  S.startTime = performance.now(); S.lastRecordSec = 0;
  S.segStart = performance.now(); S.segFileHandle = null;
  S.timeBuf = []; S.dataBuf = { K2400: [] }; S.sensBuf = { K2400: [] };
  S.tempBuf = []; S.humdBuf = [];
  S.r0 = {}; S.hasR0 = false;
  mainChart.clear();
  mainChart.setSeries("K2400", "#38bdf8");
  $("chartTitle").textContent = "即時監控圖 — 電阻 (Ω)";
  renderChannelGrid();
  $("chartInfo").textContent = "等待量測…";
  $("btnKOutput").textContent = "Output ON";
  $("btnKOutput").classList.remove("danger");
  $("btnKPause").textContent = "暫停記錄";
}

async function keithleySetup(port, baudRate) {
  S.port = port;
  S.writer = port.writable.getWriter();
  resetKeithleySession();
  S.connected = true;
  S.keepReading = true;
  updateConnUI();
  readLoop(); // SCPI 回應經 handleText → kHandleText
  recordEvent("CONNECT", `Keithley 2400（${baudRate} baud, RS-232）`);
  try {
    const idn = await scpiQuery("*IDN?");
    recordEvent("IDN", idn);
    if (!/2400/i.test(idn)) throw new Error("不是 Keithley 2400：" + idn);
    const init = ["*RST", ":OUTP OFF", ":SOUR:FUNC VOLT", ":SOUR:VOLT:MODE FIXED",
      ":SENS:FUNC 'CURR'", `:SENS:CURR:PROT ${S.k.comp}`, ":SENS:CURR:RANG:AUTO ON",
      ":SENS:CURR:NPLC 1", ":FORM:DATA ASC", ":FORM:ELEM VOLT,CURR,STAT", ":SOUR:VOLT 0"];
    for (const c of init) await scpiWrite(c);
    const err = await scpiQuery(":SYST:ERR?");
    if (!/^\s*\+?0[\s,]/.test(err)) throw new Error("儀器設定錯誤：" + err);
    recordEvent("INIT", "SCPI 初始化完成");
    log("Keithley 2400 就緒：設定電壓後按「Output ON」開始量測。");
  } catch (e) {
    log("Keithley 初始化失敗：" + e.message);
    recordEvent("ERROR", e.message);
    await disconnectSerial();
  }
}

// 量測迴圈：Output ON 且未暫停時輪詢 :READ?
async function keithleyLoop() {
  if (S.k.loopRunning) return;
  S.k.loopRunning = true;
  try {
    while (S.keepReading && S.instrument === "keithley" && S.k.outputOn) {
      if (!S.k.paused) {
        try {
          kHandleReading(await scpiQuery(":READ?"));
        } catch (e) {
          if (S.keepReading) log("讀取失敗：" + e.message);
        }
      }
      await new Promise((r) => setTimeout(r, Math.max(400, S.interval * 1000)));
    }
  } finally {
    S.k.loopRunning = false;
  }
}

function kResponses(r, r0) {
  const ok = (x) => Number.isFinite(x) && x > 0;
  if (!(ok(r) && ok(r0))) return [NaN, NaN, NaN, NaN];
  return [r0 / r, r / r0, (r - r0) / r0 * 100, (r - r0) / r * 100];
}
const fmtN = (x, d = 4) => Number.isFinite(x) ? x.toFixed(d) : "";

function kHandleReading(resp) {
  const parts = resp.split(",");
  if (parts.length < 3) { recordEvent("READ_ERROR", "格式異常：" + resp); return; }
  const v = parseFloat(parts[0]);
  const i = parseFloat(parts[1]);
  const stat = parseInt(parseFloat(parts[2]), 10);
  const compliance = Boolean(stat & 8); // bit 3 = compliance
  const valid = Number.isFinite(v) && Number.isFinite(i) && i !== 0 && (v / i) > 0 && !compliance;
  const r = valid ? v / i : NaN;
  const elapsed = Math.round((performance.now() - S.startTime) / 1000);
  const sample = { t: new Date(), elapsed, vSet: S.k.vSet, v, i, r, compliance, valid };
  S.k.samples.push(sample);
  if (compliance) recordEvent("COMPLIANCE", `電流達上限 V_set=${S.k.vSet} V`);

  pushBuf(S.timeBuf, elapsed);
  pushBuf(S.dataBuf["K2400"], r);
  mainChart.push("K2400", elapsed, r);
  mainChart.draw(elapsed, "電阻 (Ω)", null);

  const r0 = S.k.baselines.length ? S.k.baselines[S.k.baselines.length - 1].r0 : NaN;
  const [r0r, rr0, d1, d2] = kResponses(r, r0);
  S.csvRows.push([elapsed, S.k.vSet.toFixed(3),
    Number.isFinite(v) ? v.toFixed(6) : "", Number.isFinite(i) ? i.toExponential(4) : "",
    fmtN(r), fmtN(r0), fmtN(r0r), fmtN(rr0), fmtN(d1), fmtN(d2), compliance ? 1 : 0]);

  kUpdateLive(sample, r0, [r0r, rr0, d1, d2]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  $("chartInfo").textContent =
    `已記錄 ${S.timeBuf.length} 點 · 經過 ${mm}:${ss} · Keithley 2400` + (S.k.paused ? " · 已暫停" : "");
}

function kUpdateLive(s, r0, resp) {
  $("kV").textContent = Number.isFinite(s.v) ? s.v.toFixed(4) : "--";
  $("kI").textContent = Number.isFinite(s.i) ? s.i.toExponential(3) : "--";
  $("kR").textContent = Number.isFinite(s.r) ? s.r.toFixed(2) : "--";
  $("kR0").textContent = Number.isFinite(r0) ? r0.toFixed(2) : "--";
  const ids = ["kResp0", "kResp1", "kResp2", "kResp3"];
  resp.forEach((x, n) => { $(ids[n]).textContent = Number.isFinite(x) ? x.toFixed(4) : "--"; });
  if (s.compliance) $("kR").textContent += " ⚠";
}

/* ---------------- Keithley 控制 ---------------- */
async function kApplyVoltage() {
  const v = parseFloat($("kVolt").value);
  if (!(v >= 0 && v <= 5)) { log("電壓需在 0–5 V 之間。"); return; }
  S.k.vSet = v;
  saveSettings();
  if (S.connected && S.instrument === "keithley") {
    try {
      await scpiWrite(`:SOUR:VOLT ${v}`);
      recordEvent("V_SET", `${v} V`);
    } catch (e) { log("設定電壓失敗：" + e.message); }
  } else {
    log(`V_set 已設為 ${v} V（連接後生效）。`);
  }
}

async function kApplyCompliance() {
  const c = parseFloat($("kComp").value);
  if (!(c > 0 && c <= 1)) { log("Compliance 需在 0–1 A 之間。"); return; }
  S.k.comp = c;
  saveSettings();
  if (S.connected && S.instrument === "keithley") {
    try {
      await scpiWrite(`:SENS:CURR:PROT ${c}`);
      recordEvent("COMPLIANCE_SET", `${c} A`);
    } catch (e) { log("設定 Compliance 失敗：" + e.message); }
  }
}

async function kToggleOutput() {
  if (!S.connected || S.instrument !== "keithley") { log("請先連接 Keithley 2400。"); return; }
  try {
    if (!S.k.outputOn) {
      await scpiWrite(`:SOUR:VOLT ${S.k.vSet}`);
      await scpiWrite(":OUTP ON");
      S.k.outputOn = true;
      S.k.paused = false;
      $("btnKPause").textContent = "暫停記錄";
      S.startTime = performance.now();
      S.segStart = performance.now();
      recordEvent("OUTPUT", `ON（V_set=${S.k.vSet} V）`);
      $("btnKOutput").textContent = "Output OFF";
      $("btnKOutput").classList.add("danger");
      keithleyLoop();
    } else {
      await scpiWrite(":OUTP OFF");
      const st = await scpiQuery(":OUTP?", 2000).catch(() => null);
      S.k.outputOn = false;
      const verified = st && /^\s*\+?0(\.0*)?\s*$/.test(st);
      recordEvent("OUTPUT", "OFF" + (verified ? "" : "（未驗證！）"));
      $("btnKOutput").textContent = "Output ON";
      $("btnKOutput").classList.remove("danger");
      if (!verified) log("警告：無法確認 Output 已關閉，請檢查儀器面板。");
    }
  } catch (e) { log("Output 切換失敗：" + e.message); }
}

function kTogglePause() {
  if (!S.connected || S.instrument !== "keithley") return;
  S.k.paused = !S.k.paused;
  $("btnKPause").textContent = S.k.paused ? "繼續記錄" : "暫停記錄";
  recordEvent(S.k.paused ? "PAUSE" : "RESUME", S.k.paused ? "記錄暫停，Output 保持開啟" : "記錄繼續");
}

function kSetBase() {
  if (!S.k.samples.length) { log("尚無資料，無法設置 Rair。"); return; }
  const n = Math.max(1, parseInt($("kBaseN").value, 10) || 10);
  const trailing = [];
  const expectedV = S.k.samples[S.k.samples.length - 1].vSet;
  for (let idx = S.k.samples.length - 1; idx >= 0; idx--) {
    const s = S.k.samples[idx];
    if (!(s.valid && s.r > 0 && Math.abs(s.vSet - expectedV) < 1e-9)) break;
    trailing.push(s);
    if (trailing.length >= n) break;
  }
  if (trailing.length < n) { log(`R0 被拒：需要 ${n} 個連續有效樣本，僅 ${trailing.length} 個。`); return; }
  const r0 = trailing.reduce((a, s) => a + s.r, 0) / trailing.length;
  S.k.baselines.push({ idx: S.k.samples.length - 1, r0, time: new Date(), count: n, vSet: expectedV });
  recordEvent("BASE", `R0=${r0.toExponential(4)} Ω（N=${n}，V_set=${expectedV} V）`);
  log(`設置 Rair 成功：R0=${r0.toExponential(4)} Ω。`);
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
  if (S.instrument === "keithley") { kHandleText(chunk); return; }
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
    segStart: performance.now(), segFileHandle: null,
  });
  mainChart.clear(); envChart.clear();
  $("chGrid").innerHTML = "";
  $("chartInfo").textContent = "等待資料…";
  if (S.recording) stopRecording(false);
}

/* ---------------- 儀器切換 ---------------- */
const BAUDS = {
  esp32: ["9600", "115200"],
  keithley: ["9600", "19200", "38400", "57600"],
};
function applyInstrumentUI(mode) {
  const sel = $("baudSel");
  sel.innerHTML = "";
  for (const b of BAUDS[mode]) {
    const o = document.createElement("option");
    o.value = b; o.textContent = b;
    sel.appendChild(o);
  }
  sel.value = mode === "keithley" ? "9600" : "115200";
  $("kCard").hidden = mode !== "keithley";
  $("adcCard").hidden = mode === "keithley";
  $("envCard").hidden = mode === "keithley";
  $("measCard").hidden = mode === "keithley";
  $("chartTitle").textContent = mode === "keithley" ? "即時監控圖 — 電阻 (Ω)" : "即時監控圖 — 電阻 (kΩ)";
}
async function setInstrument(mode) {
  if (mode !== "esp32" && mode !== "keithley") return;
  if (S.connected) await disconnectSerial();
  S.instrument = mode;
  applyInstrumentUI(mode);
  const c = store.load();
  const saved = c["baud_" + mode];
  $("baudSel").value = (saved && BAUDS[mode].includes(saved)) ? saved
    : (mode === "keithley" ? "9600" : "115200");
  saveSettings();
  log(mode === "keithley"
    ? "已切換為 Keithley 2400 模式（經 RS-232，預設 9600 baud）。"
    : "已切換為 ESP32 模式（預設 115200 baud）。");
}

/* ---------------- CSV 下載 / 分段存檔 ---------------- */
function csvHeader() {
  if (S.instrument === "keithley") {
    return ["Time(s)", "V_set(V)", "V_meas(V)", "I_meas(A)", "R(Ohm)", "R0(Ohm)",
      "R0/R", "R/R0", "dR_R0(%)", "dR_R(%)", "Compliance"];
  }
  return ["Time(s)", ...S.channels, "TEMP", "HUMD"];
}
function buildCSVText(rows) {
  return "\uFEFF" + [csvHeader(), ...rows].map((r) => r.join(",")).join("\r\n");
}
function downloadCSV(filename, rows) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buildCSVText(rows)], { type: "text/csv;charset=utf-8" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 自動分段：時間到就把 csvRows 追加到同一檔案並清空記憶體
async function flushSegment() {  if (S.segBusy || !S.csvRows.length || !S.hasData) return;
  S.segBusy = true;
  try {
    const n = S.csvRows.length;
    if (S.dirHandle) {
      // 同一場量測共用一個檔：首次分段建檔，之後追加
      if (!S.segFileHandle) {
        S.segFileHandle = await S.dirHandle.getFileHandle(`omx_${stamp()}.csv`, { create: true });
      }
      const f = await S.segFileHandle.getFile();
      const body = S.csvRows.map((r) => r.join(",")).join("\r\n") + "\r\n";
      const text = (f.size === 0 ? "\uFEFF" + csvHeader().join(",") + "\r\n" : "") + body;
      const w = await S.segFileHandle.createWritable({ keepExistingData: true });
      await w.seek(f.size);
      await w.write(text);
      await w.close();
      log(`分段存檔：已追加 ${n} 筆 → 所選資料夾（同一檔案累積）。`);
    } else {
      // 下載模式無法追加，維持每段一個檔
      const filename = `omx_${stamp()}.csv`;
      const text = buildCSVText(S.csvRows);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      log(`分段存檔：${filename}（${n} 筆）→ 已下載。`);
    }
    S.csvRows = [];
    S.segStart = performance.now();
  } catch (e) {
    log(`分段存檔失敗：${e.message}`);
  } finally {
    S.segBusy = false;
  }
}

/* ---------------- Keithley Excel 匯出 ---------------- */
function ensureExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  log("載入 Excel 元件…");
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
    s.onload = res;
    s.onerror = () => rej(new Error("ExcelJS 載入失敗（需網路）"));
    document.head.appendChild(s);
  });
}
function kSampleRows() {
  let bi = 0, r0 = NaN;
  return S.k.samples.map((s, idx) => {
    while (bi < S.k.baselines.length && S.k.baselines[bi].idx <= idx) {
      r0 = S.k.baselines[bi].r0; bi++;
    }
    const rr = kResponses(s.r, r0);
    return [s.elapsed, s.vSet.toFixed(3),
      Number.isFinite(s.v) ? s.v.toFixed(6) : "", Number.isFinite(s.i) ? s.i.toExponential(4) : "",
      fmtN(s.r), fmtN(r0), fmtN(rr[0]), fmtN(rr[1]), fmtN(rr[2]), fmtN(rr[3]), s.compliance ? 1 : 0,
      s.t.toLocaleString("zh-TW", { hour12: false })];
  });
}
async function kExportExcel() {
  if (!S.k.samples.length) { log("無資料可匯出。"); return; }
  try {
    await ensureExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = "OMX Web Serial";
    wb.created = new Date();

    // Report（含圖表）
    const rep = wb.addWorksheet("Report");
    rep.getCell("A1").value = "Gas Sensor Measurement Report";
    rep.getCell("A1").font = { size: 18, bold: true, color: { argb: "FF164B70" } };
    rep.getCell("A2").value = "Keithley 2400（Web Serial / RS-232）";
    rep.getCell("A3").value =
      `Samples: ${S.k.samples.length} | Baselines: ${S.k.baselines.length} | 匯出時間：${new Date().toLocaleString("zh-TW", { hour12: false })}`;
    try {
      const png = $("mainChart").toDataURL("image/png").split(",")[1];
      const imgId = wb.addImage({ base64: png, extension: "png" });
      rep.addImage(imgId, "A5:H28");
    } catch (e) { rep.getCell("A5").value = "圖表擷取失敗：" + e.message; }

    // Data
    const ws = wb.addWorksheet("Data");
    ws.addRow([...csvHeader(), "DateTime"]);
    for (const r of kSampleRows()) ws.addRow(r);

    // Baselines
    const wb2 = wb.addWorksheet("Baselines");
    wb2.addRow(["Segment", "Index", "DateTime", "R0 (Ohm)", "Average N", "V_set (V)"]);
    S.k.baselines.forEach((b, n) => wb2.addRow(
      [n + 1, b.idx, b.time.toLocaleString("zh-TW", { hour12: false }), b.r0, b.count, b.vSet]));

    // Events
    const we = wb.addWorksheet("Events");
    we.addRow(["DateTime", "Type", "Message"]);
    for (const e of S.events) we.addRow(
      [e.t.toLocaleString("zh-TW", { hour12: false }), e.kind, e.msg]);

    // Summary
    const wsum = wb.addWorksheet("Summary");
    const valid = S.k.samples.filter((s) => s.valid).length;
    [["Parameter", "Value"],
     ["Instrument", "Keithley 2400 (RS-232 / Web Serial)"],
     ["Samples", S.k.samples.length],
     ["Valid samples", valid],
     ["Baselines", S.k.baselines.length],
     ["Sample interval (s)", S.interval],
     ["Current compliance (A)", S.k.comp],
     ["Response definitions", "R0/R, R/R0, (R-R0)/R0*100%, (R-R0)/R*100%"],
    ].forEach((r) => wsum.addRow(r));

    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    a.download = `keithley2400_${stamp()}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    recordEvent("EXPORT", "Excel 已匯出（" + S.k.samples.length + " 筆）。");
  } catch (e) {
    log("Excel 匯出失敗：" + e.message);
  }
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
  $("btnForget").onclick = forgetDevice;

  $("instSel").onchange = (e) => setInstrument(e.target.value);

  // Keithley 控制
  $("btnKVolt").onclick = kApplyVoltage;
  $("kVolt").onchange = kApplyVoltage;
  $("kComp").onchange = kApplyCompliance;
  $("btnKOutput").onclick = kToggleOutput;
  $("btnKPause").onclick = kTogglePause;
  $("btnKBase").onclick = kSetBase;
  $("btnKExcel").onclick = kExportExcel;

  // 實體拔線時自動更新連線狀態
  if ("serial" in navigator && navigator.serial.addEventListener) {
    navigator.serial.addEventListener("disconnect", () => {
      if (S.connected) {
        log("裝置已拔除。");
        disconnectSerial();
      }
    });
  }

  // 自動分段存檔：每 5 秒檢查一次是否到段
  setInterval(() => {
    if (S.segMs > 0 && S.connected && S.hasData && S.csvRows.length &&
        performance.now() - S.segStart >= S.segMs) {
      flushSegment();
    }
  }, 5000);

  $("btnPickDir").onclick = async () => {
    if (!("showDirectoryPicker" in window)) {
      log("此瀏覽器不支援選擇資料夾，分段將以自動下載方式保存。");
      return;
    }
    try {
      S.dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      S.segFileHandle = null; // 換資料夾 → 下一場量測建新檔
      $("dirName").textContent = S.dirHandle.name;
      log(`儲存資料夾：${S.dirHandle.name}（此分頁開啟期間有效）。`);
    } catch (e) {
      if (e.name !== "AbortError") log(`選擇資料夾失敗：${e.message}`);
    }
  };
  if (!("showDirectoryPicker" in window)) {
    $("btnPickDir").disabled = true;
    $("segHint").textContent = "此瀏覽器不支援直接寫入資料夾，分段將以自動下載方式保存（檔名含時間戳）。";
  }

  $("segSel").onchange = (e) => {
    S.segMs = parseInt(e.target.value, 10) || 0;
    S.segStart = performance.now();
    saveSettings();
    log(S.segMs ? `自動分段存檔：每 ${e.target.selectedOptions[0].text}存一段。` : "自動分段存檔：關閉。");
  };

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
    // Keithley 安全：盡力關閉 Output（同步寫入，不等待回應）
    if (S.instrument === "keithley" && S.connected && S.k.outputOn) {
      try { S.writer.write(new TextEncoder().encode(":OUTP OFF\n")); } catch {}
    }
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
  const c = store.load();
  c.baud = $("baudSel").value;
  c["baud_" + S.instrument] = $("baudSel").value;
  c.interval = S.interval; c.adc = S.adc; c.rules = S.rules;
  c.segMs = S.segMs; c.instrument = S.instrument; c.kVolt = S.k.vSet; c.kComp = S.k.comp;
  store.save(c);
}
function loadSettings() {
  const c = store.load();
  if (c.instrument === "keithley" || c.instrument === "esp32") {
    // 先套用儀器（會重建鮑率選項），再套用其他設定
    S.instrument = c.instrument;
    $("instSel").value = c.instrument;
    applyInstrumentUI(c.instrument);
  }
  if (c.baud && BAUDS[S.instrument].includes(c.baud)) $("baudSel").value = c.baud;
  const savedBaud = c["baud_" + S.instrument];
  if (savedBaud && BAUDS[S.instrument].includes(savedBaud)) $("baudSel").value = savedBaud;
  if (Number.isFinite(c.kVolt) && c.kVolt >= 0 && c.kVolt <= 5) {
    S.k.vSet = c.kVolt; $("kVolt").value = c.kVolt;
  }
  if (Number.isFinite(c.kComp) && c.kComp > 0 && c.kComp <= 1) {
    S.k.comp = c.kComp; $("kComp").value = c.kComp;
  }
  if (c.interval) { S.interval = c.interval; $("intervalInput").value = c.interval; }
  if (c.segMs) { S.segMs = c.segMs; $("segSel").value = String(c.segMs); }
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

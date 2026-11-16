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
  port: null, reader: null, writer: null, keepReading: false, readGen: 0, failedPort: null,
  connected: false, reconnecting: false, reconnectTimer: null, reconnectBusy: false,
  instrument: "esp32",
  ws: null, kLink: "serial", rpcSeq: 0, rpcWait: {},
  channels: [], hasData: false,
  interval: 1, startTime: 0, lastRecordSec: 0,
  accum: {}, tempAcc: [], humdAcc: [],
  timeBuf: [], dataBuf: {}, sensBuf: {}, sensBufInv: {}, tempBuf: [], humdBuf: [],
  r0: {}, hasR0: false,
  mode: "RESISTANCE", sensRatio: "R/R0",
  legendMode: "end", // 圖例：end＝右側直排標籤（新版），top＝上方橫排圖例（舊版）
  csvRows: [], recording: false, recResRows: [], recSensRows: [], recSensRowsInv: [],
  // M7：下載模式下已觸發過一次下載、但尚未確認寫入成功的分段列，
  // 下次分段會再隨新資料一併下載一次，之後才丟棄。
  prevDownloadRows: [], downloadWarned: false,
  timerSec: 0, timerRunning: false, timerStartMs: 0, timerAccumMs: 0,
  // M2：螢幕 Wake Lock（背景分頁防休眠）；M4：無資料看門狗計時器
  wakeLock: null, noDataTimer: null,
  // M5：自動重連時 VID/PID 無法確認的埠，需等 ESP32 資料驗證通過才算成功
  awaitingReconnectVerify: false, reconnectVerifyTimer: null,
  chPage: 0, chView: "page",
  dirHandle: null, segMs: 0, segStart: 0, segBusy: false, segFileHandle: null,
  events: [],
  k: {
    vSet: 1.0, comp: 0.1, outputOn: false, paused: false, ready: false,
    buf: "", pending: null, loopRunning: false,
    samples: [], baselines: [],
  },
  a: {
    func: "VOLT:DC", range: "AUTO", nplc: "10", ready: false,
    measuring: false, loopRunning: false, samples: [], last: NaN,
  },
  adc: [3.28, 3.27, 3.27, 3.28],
  calDone: [],
  rules: {
    resistance: { enabled: false, min: 0, max: 1000 },
    sensitivity: { enabled: false, min: 0, max: 5 },
  },
  lineBuf: "",
  seq: {}, droppedLines: 0, lastDropWarn: 0,
  sensorTags: {},
};

const MAXP = 3600;
function pushBuf(arr, v) { arr.push(v); if (arr.length > MAXP) arr.shift(); }

// M4：連接後無有效資料行的看門狗逾時（毫秒）；模擬面板可引用此常數。
const NO_DATA_TIMEOUT_MS = 10000;

// M5：常見 ESP32 USB 轉串列晶片的 VID/PID（port.getInfo() 回傳值）
const ESP32_USB_IDS = [
  { usbVendorId: 0x10C4, usbProductId: 0xEA60 }, // CP210x
  { usbVendorId: 0x1A86, usbProductId: 0x7523 }, // CH340
  { usbVendorId: 0x0403, usbProductId: 0x6001 }, // FTDI
];
function isEsp32SerialPort(port) {
  let info = null;
  try { info = port.getInfo(); } catch { return false; }
  if (!info) return false;
  return ESP32_USB_IDS.some((id) =>
    info.usbVendorId === id.usbVendorId && info.usbProductId === id.usbProductId);
}

// M2：連線期間請求螢幕 Wake Lock，避免背景分頁休眠／系統睡眠中斷量測。
// 不支援的瀏覽器直接略過；請求失敗（如剛切走分頁）也屬正常，不報錯。
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { S.wakeLock = await navigator.wakeLock.request("screen"); }
  catch { /* 拿不到鎖屬正常（如分頁剛被隱藏），不斷線 */ }
}
function releaseWakeLock() {
  if (!S.wakeLock) return;
  const wl = S.wakeLock; S.wakeLock = null;
  try {
    const p = wl.release();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

// M4：清除無資料看門狗（連線結束、重設場次、收到第一筆有效資料時呼叫）
function clearNoDataTimer() {
  if (S.noDataTimer) { clearTimeout(S.noDataTimer); S.noDataTimer = null; }
}

/* ---------------- 圖表 ---------------- */
let mainChart;
function initCharts() {
  mainChart = new LineChart($("mainChart"), { windowSec: 600 });
}

/* ---------------- 序列埠 ---------------- */
// 取得已開啟的 port：重用上次的 → 已配對的 → 選擇器
// M5：已授權的埠先依 USB VID/PID 篩出 ESP32 常見轉接器（CP210x / CH340 / FTDI）
// 依序嘗試；沒有任何埠符合時退回舊行為（依序試已授權的埠）。
async function acquirePort(baudRate) {
  if (S.port) {
    try { await S.port.open({ baudRate }); return S.port; }
    catch { S.port = null; } // 裝置可能已拔除
  }
  const ports = await navigator.serial.getPorts();
  const espPorts = ports.filter(isEsp32SerialPort);
  const candidates = espPorts.length ? espPorts : ports;
  for (const port of candidates) {
    try { await port.open({ baudRate }); S.port = port; return port; }
    catch { /* 這個埠開不了就試下一個 */ }
  }
  const port = await navigator.serial.requestPort(); // 使用者取消會丟 NotFoundError
  await port.open({ baudRate });
  S.port = port;
  return port;
}

async function esp32Setup(port, baudRate) {
  S.port = port;
  S.writer = port.writable.getWriter();
  await resetSession();
  S.connected = true;
  S.keepReading = true;
  updateConnUI();
  log(`已連接 COM（${baudRate} baud），等待硬體資料以進行通道自適應偵測…`);
  // M4：無資料看門狗——10 秒內沒收到有效資料行就提示檢查鮑率／COM 埠／供電，不自動斷線
  clearNoDataTimer();
  S.noDataTimer = setTimeout(() => {
    S.noDataTimer = null;
    if (S.connected && !S.hasData) {
      log("仍未收到硬體資料：請檢查鮑率是否為 115200、是否選到正確的 COM 埠，以及 ESP32 是否已上電並持續傳送資料。");
    }
  }, NO_DATA_TIMEOUT_MS);
  requestWakeLock(); // M2：連線期間請求螢幕 Wake Lock
  readLoop();
}

async function connectSerial() {
  stopAutoReconnect(); // 手動連接走新場次流程，不跟自動重連搶埠
  if (S.instrument !== "esp32" && $("connModeSel").value === "gpib") {
    S.kLink = "gpib";
    try { await connectGpib(); }
    catch (e) { log(`連線失敗：${e.message}`); }
    return;
  }
  S.kLink = "serial";
  if (!("serial" in navigator)) {
    log("此瀏覽器不支援 Web Serial，請改用 Chrome / Edge。");
    return;
  }
  const baudRate = parseInt($("baudSel").value, 10);
  try {
    const port = await acquirePort(baudRate);
    if (S.instrument === "keithley") await keithleySetup(port, baudRate);
    else if (S.instrument === "agilent") await agilentSetup(port, baudRate);
    else await esp32Setup(port, baudRate);
  } catch (e) {
    if (e.name !== "NotFoundError") log(`連線失敗：${e.message}`);
  }
}

/* ---------------- 拔線自動重連（僅 ESP32 Web Serial） ----------------
 * 舊版 Python 後端的做法搬到網頁版，但改掉一個關鍵差異：舊程式只重試
 * 原本的 COM 埠號，重插若換了埠號就永遠接不回去。網頁版改為每 3 秒用
 * getPorts() 看目前已授權的埠（重插後出現的是新埠物件），接上就續用
 * 原場次：通道、R0、記錄狀態、資料夾分段檔都不重置，記錄續寫同一檔；
 * ESP32 斷電重啟後校正值會回到韌體預設，所以接回來後把本場次已校好的
 * S.adc 送回裝置。手動按「斷開並換裝置」、切換儀器、手動按連接，都會
 * 停掉自動重連（手動連接走原本的新場次流程）。 */
function stopAutoReconnect() {
  S.reconnecting = false;
  if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
  if (S.reconnectVerifyTimer) { clearTimeout(S.reconnectVerifyTimer); S.reconnectVerifyTimer = null; }
  S.awaitingReconnectVerify = false;
}
// M5：未確認埠收到有效的 ESP32 行（資料行或 SELECT MOD）時才宣告重連成功，
// 並補送本場次校正值；在此之前不算連線成功、不送 y… ADC 指令。
async function confirmReconnectVerified() {
  if (!S.awaitingReconnectVerify) return;
  S.awaitingReconnectVerify = false;
  if (S.reconnectVerifyTimer) { clearTimeout(S.reconnectVerifyTimer); S.reconnectVerifyTimer = null; }
  S.connected = true;
  stopAutoReconnect();
  updateConnUI();
  log("自動重連成功，已驗證 ESP32 資料，恢復數據接收。");
  requestWakeLock();
  if (S.calDone.length) {
    try { await sendAdcValues(S.adc); log("已將本場次校正值送回裝置。"); }
    catch (e) { log(`校正值送回失敗：${e.message}，請手動重跑自動校正。`); }
  }
}
// M5：驗證逾時——該埠在時限內沒回傳 ESP32 資料，關掉它、換下一個埠重試。
async function failReconnectVerify() {
  if (!S.awaitingReconnectVerify) return;
  S.awaitingReconnectVerify = false;
  S.reconnectVerifyTimer = null;
  log("自動重連：該 COM 埠未回傳 ESP32 資料（可能不是 ESP32），關閉並換下一個埠重試…");
  S.readGen++; // 作廢驗證中的 readLoop
  S.keepReading = false;
  try { if (S.reader) await S.reader.cancel(); } catch {}
  try { if (S.writer) S.writer.releaseLock(); } catch {}
  try { if (S.port) await S.port.close(); } catch {}
  S.failedPort = S.port;
  S.reader = null; S.writer = null; S.port = null;
  S.connected = false;
  updateConnUI();
  if (S.reconnecting) S.reconnectTimer = setTimeout(tryAutoReconnect, 3000);
}
async function tryAutoReconnect() {
  if (!S.reconnecting || S.reconnectBusy || S.connected) return;
  S.reconnectBusy = true;
  try {
    const baudRate = parseInt($("baudSel").value, 10);
    const ports = await navigator.serial.getPorts();
    // M5：重插後的新埠通常排在後面，先試；ESP32 常見 VID/PID 的埠優先；
    // 上次讀取失敗的埠放最後（舊埠物件可能還在清單裡，先試它會立刻讀取
    // 失敗又跳回重連中，造成已連線／重連中來回翻）
    const ordered = [...ports].reverse();
    ordered.sort((a, b) =>
      ((a === S.failedPort ? 10 : 0) + (isEsp32SerialPort(a) ? 0 : 1)) -
      ((b === S.failedPort ? 10 : 0) + (isEsp32SerialPort(b) ? 0 : 1)));
    for (const port of ordered) {
      try {
        await port.open({ baudRate });
        S.port = port;
        S.writer = port.writable.getWriter();
        S.keepReading = true;
        S.failedPort = null;
        if (isEsp32SerialPort(port)) {
          // VID/PID 已確認是 ESP32 轉接器：沿用舊行為，立即宣告成功
          S.connected = true;
          stopAutoReconnect();
          updateConnUI();
          log("自動重連成功，恢復數據接收。");
          requestWakeLock();
          if (S.calDone.length) {
            try { await sendAdcValues(S.adc); log("已將本場次校正值送回裝置。"); }
            catch (e) { log(`校正值送回失敗：${e.message}，請手動重跑自動校正。`); }
          }
          readLoop();
          return;
        }
        // M5：VID/PID 無法確認（非 ESP32 轉接器、或抓不到資訊）：先讀資料，
        // 收到有效的 ESP32 行或 SELECT MOD 才宣告成功；逾時則關埠換下一個。
        // 這段期間不算已連線、不送 y… ADC 指令。
        S.awaitingReconnectVerify = true;
        updateConnUI(); // 仍顯示「重連中…」，直到驗證通過
        log("自動重連：已開啟一個未確認的 COM 埠，等待 ESP32 資料驗證…");
        readLoop();
        S.reconnectVerifyTimer = setTimeout(() => { failReconnectVerify(); }, NO_DATA_TIMEOUT_MS);
        return; // 等驗證結果，不再試其他埠
      } catch { /* 這個埠開不了就試下一個 */ }
    }
  } catch { /* 下一輪再試 */ }
  finally { S.reconnectBusy = false; }
  if (S.reconnecting) S.reconnectTimer = setTimeout(tryAutoReconnect, 3000);
}
async function handleUnexpectedDisconnect() {
  if (!S.connected || S.reconnecting) return;
  if (S.instrument !== "esp32" || S.kLink === "gpib") { log("裝置已拔除。"); disconnectSerial(); return; }
  S.reconnecting = true; // 先佔旗標，避免 disconnect 事件與讀取錯誤兩路重複觸發
  S.readGen++; // 作廢舊 readLoop：舊迴圈事後出錯不得再殺掉已接回的好連線
  S.keepReading = false;
  const closeTimeout = new Promise(r => setTimeout(r, 2000)); // close 卡住時不讓重連永遠等不到
  try { if (S.reader) await Promise.race([S.reader.cancel(), closeTimeout]); } catch {}
  try { if (S.writer) S.writer.releaseLock(); } catch {}
  try { if (S.port) await Promise.race([S.port.close(), closeTimeout]); } catch {}
  S.failedPort = S.port; // 下一輪重連先試別的埠，這個放最後
  S.reader = null; S.writer = null; S.port = null;
  S.connected = false;
  clearNoDataTimer(); // M4：連線已斷，看門狗不用再等
  releaseWakeLock(); // M2：斷線即放掉 Wake Lock，重連成功時再重新請求
  updateConnUI();
  log("連線異常，自動重連中（每 3 秒重試；按「斷開並換裝置」可停止）…");
  tryAutoReconnect();
}

async function disconnectSerial() {
  stopAutoReconnect();
  S.keepReading = false;
  clearNoDataTimer(); // M4：已手動斷開，看門狗不用再等
  releaseWakeLock(); // M2：斷開即放掉 Wake Lock
  // M6：斷開前先把未寫出的分段資料寫出（資料夾模式追加寫入／下載模式觸發下載），
  // 避免上一場的段尾資料因斷開而遺失。
  if ((S.csvRows.length || S.prevDownloadRows.length) && S.hasData) {
    try { await flushSegment(); } catch {}
  }
  if (S.instrument === "agilent") S.a.measuring = false;
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
  // GPIB 橋接：送 close 並關 WebSocket（Output 已在上方經 SCPI 關閉）
  if (S.kLink === "gpib" && S.ws) {
    try { await gpibRpc({ type: "close" }, 2000); } catch {}
    try { S.ws.close(); } catch {}
    S.ws = null;
  }
  // 保留 S.port：下次按連接可直接重開，不用再選一次
  S.reader = null; S.writer = null;
  S.connected = false;
  S.calDone = [];
  updateCalIndicators();
  updateConnUI();
  log("已斷開連線。");
}

async function forgetDevice() {
  if (S.kLink === "gpib") { log("GPIB 橋接模式沒有 COM 埠可換。"); return; }
  try {
    const port = S.port || (await navigator.serial.getPorts())[0];
    if (port) { try { await port.forget(); } catch {} }
  } catch {}
  S.port = null;
  log("已忘記裝置，下次連接會重新跳出選擇器。");
}

/* ---------------- Keithley GPIB 橋接（NI GPIB-USB-HS 經本機 bridge.py） ----------------
   Web Serial 看不到 NI-VISA 裝置，所以 GPIB 走 WebSocket → 本機 bridge.py → PyVISA。
   SCPI 層（scpiWrite/scpiQuery/kHandleText）不變，只換傳輸通道。 */
const GPIB_WS_URL = "ws://127.0.0.1:8765";
function gpibOnMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.rpc != null && S.rpcWait[msg.rpc]) {
    const w = S.rpcWait[msg.rpc]; delete S.rpcWait[msg.rpc];
    if (msg.type === "error") w.reject(new Error(msg.message || "橋接錯誤"));
    else w.resolve(msg);
    return;
  }
  if (msg.type === "data" && typeof msg.line === "string") {
    kHandleText(msg.line + "\n"); // 走既有 SCPI 回應配對
  } else if (msg.type === "error") {
    log("GPIB 橋接錯誤：" + (msg.message || ""));
    recordEvent("ERROR", msg.message || "bridge error");
  }
  // ack 無需處理
}
function gpibRpc(msg, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) { reject(new Error("GPIB 橋接未連線")); return; }
    const id = ++S.rpcSeq;
    const timer = setTimeout(() => { delete S.rpcWait[id]; reject(new Error("橋接逾時")); }, timeoutMs);
    S.rpcWait[id] = {
      resolve: (m) => { clearTimeout(timer); delete S.rpcWait[id]; resolve(m); },
      reject: (e) => { clearTimeout(timer); delete S.rpcWait[id]; reject(e); },
    };
    S.ws.send(JSON.stringify({ ...msg, rpc: id }));
  });
}
// 兩種傳輸共用的 SCPI 初始化
async function keithleyInitScpi() {
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
}
async function connectGpib() {
  S.kLink = "gpib";
  const isA = S.instrument === "agilent";
  const name = isA ? "Agilent 34401A" : "Keithley 2400";
  const addr = ($("gpibAddr").value || "").trim() || GPIB_DEFAULTS[S.instrument] || "GPIB0::24::INSTR";
  log("連接 GPIB 橋接（" + addr + "）…");
  const ws = new WebSocket(GPIB_WS_URL);
  S.ws = ws;
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("連不上橋接程式：請先在本機執行 tools/keithley-gpib-bridge/bridge.py")), 4000);
      ws.onopen = () => { clearTimeout(to); resolve(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error("連不上橋接程式：請先在本機執行 tools/keithley-gpib-bridge/bridge.py")); };
    });
    ws.onmessage = gpibOnMessage;
    ws.onclose = () => {
      S.ws = null;
      if (S.connected && S.kLink === "gpib") { S.connected = false; updateConnUI(); log("GPIB 橋接中斷，已斷開。"); }
    };
    await gpibRpc({ type: "open", resource: addr });
  } catch (e) {
    try { ws.close(); } catch {}
    S.ws = null; S.kLink = "serial";
    throw e;
  }
  if (isA) resetAgilentSession(); else resetKeithleySession();
  S.connected = true;
  S.keepReading = true;
  updateConnUI();
  recordEvent("CONNECT", `${name}（GPIB ${addr}，經本機橋接）`);
  try {
    if (isA) {
      await agilentInitScpi();
      S.a.ready = true;
      log("Agilent 34401A 就緒（GPIB）：按「開始量測」開始記錄。");
    } else {
      await keithleyInitScpi();
      S.k.ready = true;
      log("Keithley 2400 就緒（GPIB）：設定電壓後按「Output ON」開始量測。");
    }
  } catch (e) {
    log(name + "初始化失敗：" + e.message);
    recordEvent("ERROR", e.message);
    await disconnectSerial();
  }
}

/* ---------------- Keithley 2400 SCPI ---------------- */
function scpiWrite(cmd) {
  return writeLine(cmd + "\n");
}
function scpiQuery(cmd, timeoutMs) {
  // GPIB 經 bridge（逾時 5 秒），網頁端要給得比它長，避免遲到回應錯配到下一個查詢
  const limit = timeoutMs || (S.kLink === "gpib" ? 6000 : 3000);
  return new Promise((resolve, reject) => {
    if (S.k.pending) { reject(new Error("SCPI 忙碌中")); return; }
    const pending = {
      resolve: (v) => { clearTimeout(timer); if (S.k.pending === pending) S.k.pending = null; resolve(v); },
      reject: (e) => { clearTimeout(timer); if (S.k.pending === pending) S.k.pending = null; reject(e); },
    };
    const timer = setTimeout(() => {
      if (S.k.pending === pending) {
        S.k.pending = null;
        reject(new Error("SCPI 逾時：" + cmd));
      }
    }, limit);
    S.k.pending = pending;
    writeLine(cmd + "\n").catch(pending.reject);
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
    buf: "", pending: null, paused: false, outputOn: false, loopRunning: false, ready: false,
    samples: [], baselines: [],
  });
  S.events = [];
  S.channels = ["K2400"];
  S.hasData = true;
  S.csvRows = [];
  S.startTime = performance.now(); S.lastRecordSec = 0;
  S.segStart = performance.now(); S.segFileHandle = null;
  S.timeBuf = []; S.dataBuf = { K2400: [] }; S.sensBuf = { K2400: [] }; S.sensBufInv = { K2400: [] };
  S.tempBuf = []; S.humdBuf = [];
  S.r0 = {}; S.hasR0 = false;
  mainChart.clear();
  mainChart.setSeries("K2400", "#38bdf8");
  $("chartTitle").textContent = "即時監控圖 — 電阻 (Ω)";
  mainChart.resetVisible(); renderChannelGrid();
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
  recordEvent("CONNECT", `Keithley 2400（${baudRate} baud, RS-232 直連）`);
  try {
    await keithleyInitScpi();
    S.k.ready = true;
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
  if (!S.k.ready) { log("儀器尚未就緒：初始化未完成，請等連線成功（出現「就緒」）後再操作。"); return; }
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

/* ---------------- Agilent 34401A SCPI（純量測 DMM） ----------------
   傳輸與 SCPI 層（scpiWrite/scpiQuery/kHandleText）與 Keithley 共用。
   34401A 無輸出端子，量測流程：CONF 設定 → READ? 輪詢。 */
function aBuildRanges() {
  const sel = $("aRange");
  sel.innerHTML = "";
  for (const r of AGILENT_FUNCS[S.a.func].ranges) {
    const o = document.createElement("option");
    o.value = r; o.textContent = r === "AUTO" ? "AUTO" : r;
    sel.appendChild(o);
  }
  if (!AGILENT_FUNCS[S.a.func].ranges.includes(S.a.range)) S.a.range = "AUTO";
  sel.value = S.a.range;
}
async function agilentApplyConfig() {
  await scpiWrite(`CONF:${S.a.func} ${S.a.range}`);
  await scpiWrite(`${S.a.func}:NPLC ${S.a.nplc}`);
  recordEvent("ACONF", `${AGILENT_FUNCS[S.a.func].label} range=${S.a.range} NPLC=${S.a.nplc}`);
}
// 兩種傳輸共用的 SCPI 初始化
async function agilentInitScpi() {
  const idn = await scpiQuery("*IDN?");
  recordEvent("IDN", idn);
  if (!/34401A/i.test(idn)) throw new Error("不是 Agilent 34401A：" + idn);
  await scpiWrite("*RST");
  await new Promise((r) => setTimeout(r, 600));
  await agilentApplyConfig();
  const err = await scpiQuery(":SYST:ERR?");
  if (!/^\s*\+?0[\s,]/.test(err)) throw new Error("儀器設定錯誤：" + err);
  recordEvent("INIT", "SCPI 初始化完成");
}
function resetAgilentSession() {
  Object.assign(S.a, { measuring: false, loopRunning: false, samples: [], last: NaN, ready: false });
  S.events = [];
  S.channels = ["A34401A"];
  S.hasData = true;
  S.csvRows = [];
  S.startTime = performance.now(); S.lastRecordSec = 0;
  S.segStart = performance.now(); S.segFileHandle = null;
  S.timeBuf = []; S.dataBuf = { A34401A: [] }; S.sensBuf = { A34401A: [] }; S.sensBufInv = { A34401A: [] };
  S.tempBuf = []; S.humdBuf = [];
  mainChart.clear();
  mainChart.setSeries("A34401A", "#a78bfa");
  $("chartTitle").textContent = "即時監控圖 — Agilent 34401A";
  mainChart.resetVisible(); renderChannelGrid();
  $("chartInfo").textContent = "等待量測…";
  $("btnAMeasure").textContent = "開始量測";
  $("btnAMeasure").classList.remove("danger");
  aUpdateLive(NaN);
}
async function agilentSetup(port, baudRate) {
  S.port = port;
  S.writer = port.writable.getWriter();
  resetAgilentSession();
  S.connected = true;
  S.keepReading = true;
  updateConnUI();
  readLoop(); // SCPI 回應經 handleText → kHandleText
  recordEvent("CONNECT", `Agilent 34401A（${baudRate} baud, RS-232 直連）`);
  try {
    await agilentInitScpi();
    S.a.ready = true;
    log("Agilent 34401A 就緒：按「開始量測」開始記錄。");
  } catch (e) {
    log("Agilent 初始化失敗：" + e.message);
    recordEvent("ERROR", e.message);
    await disconnectSerial();
  }
}
// 量測迴圈：measuring 時輪詢 :READ?（逾時給長：NPLC 100 約需 1.7 秒/點）
async function agilentLoop() {
  if (S.a.loopRunning) return;
  S.a.loopRunning = true;
  try {
    while (S.keepReading && S.instrument === "agilent" && S.a.measuring) {
      try {
        aHandleReading(await scpiQuery(":READ?", 10000));
      } catch (e) {
        if (S.keepReading) log("讀取失敗：" + e.message);
      }
      await new Promise((r) => setTimeout(r, Math.max(400, S.interval * 1000)));
    }
  } finally {
    S.a.loopRunning = false;
  }
}
function aHandleReading(resp) {
  const v = parseFloat(resp);
  const info = AGILENT_FUNCS[S.a.func];
  const elapsed = Math.round((performance.now() - S.startTime) / 1000);
  const valid = Number.isFinite(v);
  const sample = { t: new Date(), elapsed, value: v, func: info.label, unit: info.unit, valid };
  S.a.samples.push(sample);
  if (!valid) { recordEvent("READ_ERROR", "格式異常：" + resp); return; }
  S.a.last = v;
  pushBuf(S.timeBuf, elapsed);
  pushBuf(S.dataBuf["A34401A"], v);
  mainChart.push("A34401A", elapsed, v);
  mainChart.draw(elapsed, `${info.label} (${info.unit})`, null);
  S.csvRows.push([elapsed, info.label, v.toExponential(6), info.unit]);
  aUpdateLive(v);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  $("chartInfo").textContent =
    `已記錄 ${S.timeBuf.length} 點 · 經過 ${mm}:${ss} · Agilent 34401A ${info.label}`;
}
function aUpdateLive(v) {
  const info = AGILENT_FUNCS[S.a.func];
  const disp = Number.isFinite(v) ? v.toPrecision(7) : "--";
  $("aVal").textContent = disp;
  $("aUnit").textContent = info.unit;
  $("aFuncLabel").textContent = info.label;
  const el = document.querySelector('[data-ch="A34401A"]');
  if (el) {
    el.querySelector(".ch-val").textContent = disp;
    el.querySelector(".ch-unit").textContent = info.unit;
  }
  refreshSparks();
}
async function aToggleMeasure() {
  if (!S.connected || S.instrument !== "agilent") { log("請先連接 Agilent 34401A。"); return; }
  if (!S.a.ready) { log("儀器尚未就緒：初始化未完成，請等連線成功（出現「就緒」）後再操作。"); return; }
  if (!S.a.measuring) {
    try { await agilentApplyConfig(); }
    catch (e) { log("套用設定失敗：" + e.message); return; }
    S.a.measuring = true;
    S.startTime = performance.now();
    S.segStart = performance.now();
    recordEvent("MEASURE", `開始（${AGILENT_FUNCS[S.a.func].label} range=${S.a.range} NPLC=${S.a.nplc}）`);
    $("btnAMeasure").textContent = "停止量測";
    $("btnAMeasure").classList.add("danger");
    agilentLoop();
  } else {
    S.a.measuring = false;
    recordEvent("MEASURE", "停止");
    $("btnAMeasure").textContent = "開始量測";
    $("btnAMeasure").classList.remove("danger");
  }
}
async function aApplyUi() {
  if (!S.connected || S.instrument !== "agilent") { log("請先連接 Agilent 34401A。"); return; }
  if (!S.a.ready) { log("儀器尚未就緒：初始化未完成，請等連線成功（出現「就緒」）後再操作。"); return; }
  try {
    await agilentApplyConfig();
    log("設定已套用。");
  } catch (e) { log("套用設定失敗：" + e.message); }
}
async function aExportExcel() {
  if (!S.a.samples.length) { log("無資料可匯出。"); return; }
  try {
    await ensureExcelJS();
    const info = AGILENT_FUNCS[S.a.func];
    const wb = new ExcelJS.Workbook();
    wb.creator = "OMX Web Serial";
    wb.created = new Date();
    const rep = wb.addWorksheet("Report");
    rep.getCell("A1").value = "Agilent 34401A Measurement Report";
    rep.getCell("A1").font = { size: 18, bold: true, color: { argb: "FF164B70" } };
    rep.getCell("A2").value = "Agilent 34401A（" + (S.kLink === "gpib" ? "GPIB 橋接" : "RS-232 直連") + "）";
    rep.getCell("A3").value =
      `Samples: ${S.a.samples.length} | Function: ${info.label} | 匯出時間：${new Date().toLocaleString("zh-TW", { hour12: false })}`;
    try {
      const png = $("mainChart").toDataURL("image/png").split(",")[1];
      const imgId = wb.addImage({ base64: png, extension: "png" });
      rep.addImage(imgId, "A5:H28");
    } catch (e) { rep.getCell("A5").value = "圖表擷取失敗：" + e.message; }
    const ws = wb.addWorksheet("Data");
    ws.addRow(["Time(s)", "Function", "Reading", "Unit", "DateTime"]);
    for (const s of S.a.samples) ws.addRow(
      [s.elapsed, s.func, s.valid ? s.value : "", s.unit,
       s.t.toLocaleString("zh-TW", { hour12: false })]);
    const we = wb.addWorksheet("Events");
    we.addRow(["DateTime", "Type", "Message"]);
    for (const e of S.events) we.addRow(
      [e.t.toLocaleString("zh-TW", { hour12: false }), e.kind, e.msg]);
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    a.download = `agilent34401a_${stamp()}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    recordEvent("EXPORT", "Excel 已匯出（" + S.a.samples.length + " 筆）。");
  } catch (e) {
    log("Excel 匯出失敗：" + e.message);
  }
}

async function readLoop() {
  const myGen = ++S.readGen; // 世代戳：重連後舊迴圈的錯誤不得觸發新連線的重連
  const decoder = new TextDecoderStream();
  S.port.readable.pipeTo(decoder.writable).catch(() => {});
  S.reader = decoder.readable.getReader();
  while (S.keepReading && myGen === S.readGen) {
    let res;
    try {
      res = await S.reader.read();
    } catch (e) {
      // 只有串流讀取本身失敗才算斷線、進自動重連
      if (S.keepReading && myGen === S.readGen) {
        if (S.instrument === "esp32" && S.kLink !== "gpib") {
          log(`讀取錯誤：${e.message}，進入自動重連。`);
          handleUnexpectedDisconnect();
        } else log(`讀取中斷：${e.message}`);
      }
      return;
    }
    const { value, done } = res;
    if (done) break;
    if (value) {
      // 資料處理（UI 更新）出錯只記錄，不當成斷線重連
      try { handleText(value); }
      catch (e) { log(`資料處理錯誤：${e.message}`); }
    }
  }
}

async function writeLine(text) {
  if (S.kLink === "gpib") {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) throw new Error("GPIB 橋接未連線");
    S.ws.send(JSON.stringify({ type: "line", cmd: text.trim() }));
    return;
  }
  if (!S.writer) throw new Error("尚未連線");
  await S.writer.write(new TextEncoder().encode(text));
}

function handleText(chunk) {
  // SCPI 儀器（Keithley / Agilent）共用行協定配對
  if (S.instrument === "keithley" || S.instrument === "agilent") { kHandleText(chunk); return; }
  S.lineBuf += chunk;
  let idx;
  while ((idx = S.lineBuf.indexOf("\n")) >= 0) {
    const line = S.lineBuf.slice(0, idx).trim();
    S.lineBuf = S.lineBuf.slice(idx + 1);
    if (line) handleLine(line);
  }
}

// 丟棄行計數：每行不完整資料都計數，日誌至多每 10 秒記一次，避免洗版
function noteDroppedLine() {
  S.droppedLines++;
  const now = Date.now();
  if (now - S.lastDropWarn >= 10000) {
    S.lastDropWarn = now;
    log(`資料行不完整，已累計 ${S.droppedLines} 行。`);
  }
}

/* ---------------- 協定解析 ---------------- */
function handleLine(line) {
  if (line.includes("SELECT MOD")) {
    // 裝置重啟會重印 SELECT MOD：場次中途（已收過有效資料）且本場次已有
    // 校正值時，韌體校正值已回到預設，須把 S.adc 送回；初次連接時
    // S.hasData 仍為 false，不送回（依 2026-11-01 決定，每次開機重新校正）。
    const resendCal = S.hasData && S.calDone.length > 0;
    writeLine("1\n").then(async () => {
      if (!resendCal) return;
      try { await sendAdcValues(S.adc); log("裝置疑似重啟，已將本場次校正值送回裝置。"); }
      catch (e) { log(`校正值送回失敗：${e.message}，請手動重跑自動校正。`); }
    }).catch((e) => log(`回寫 SELECT MOD 失敗：${e.message}`));
    confirmReconnectVerified(); // M5：SELECT MOD 也算 ESP32 驗證通過
    return;
  }
  if (!line.includes("TEMP") || !line.includes("HUMD")) { noteDroppedLine(); return; }

  const clean = line.replace(/TEMP/g, " ").replace(/HUMD/g, " ");
  const matches = [...clean.matchAll(/([-0-9.]+)([a-zA-Z]+)/g)];
  // S4：數值須是嚴格格式才接受（--、-.、1.2.3 這類怪字串不進平均，避免 NaN 污染）
  const isNumStr = (s) => /^-?(?:\d+\.?\d*|\.\d+)$/.test(s);
  if (!matches.length) { noteDroppedLine(); return; }

  if (!S.hasData) {
    const detected = matches.map((m) => m[2]);
    // 首行可能是接上已在串流的裝置時截到的半行：只接受完整連續的
    // 16 通道（A–P）或 32 通道（A–P＋AA–PP），否則不鎖定、繼續等下一行。
    const letters16 = Array.from({ length: 16 }, (_, i) => String.fromCharCode(65 + i));
    const expected32 = [...letters16, ...letters16.map((c) => c + c)];
    // 首行數值也要全部有效，才是真正完整有效的資料行，不只通道名齊全
    const allNumsValid = matches.every((m) => isNumStr(m[1]) && Number.isFinite(parseFloat(m[1])));
    const ok16 = detected.length === 16 && detected.every((c, i) => c === letters16[i]) && allNumsValid;
    const ok32 = detected.length === 32 && detected.every((c, i) => c === expected32[i]) && allNumsValid;
    if (!ok16 && !ok32) {
      noteDroppedLine();
      log(`通道偵測異常：首行僅 ${detected.length} 通道（${detected.join(",")}），非完整 16／32 通道，繼續等待有效首行。`);
      return;
    }
    S.channels = detected;
    S.hasData = true;
    clearNoDataTimer(); // M4：收到第一筆有效資料行，看門狗解除
    for (const ch of S.channels) {
      S.accum[ch] = []; S.dataBuf[ch] = []; S.sensBuf[ch] = []; S.sensBufInv[ch] = []; S.seq[ch] = 0;
      mainChart.setSeries(ch, channelColorOf(ch));
    }
    log(`自動偵測完成：${S.channels.length} 通道（${S.channels.join(",")}）。`);
    mainChart.resetVisible(); renderChannelGrid();
    refreshAutoCalChannels();
  }
  const parsed = {};
  for (const m of matches) {
    const v = parseFloat(m[1]);
    if (isNumStr(m[1]) && Number.isFinite(v)) parsed[m[2]] = v;
  }
  const missing = S.channels.filter((ch) => !(ch in parsed));
  if (missing.length === S.channels.length) { noteDroppedLine(); return; }
  if (missing.length) noteDroppedLine(); // 部分缺值：計數後仍記錄，缺值欄留空
  confirmReconnectVerified(); // M5：完整有效的 ESP32 資料行，驗證通過

  const tm = line.match(/([-0-9.]+)TEMP/);
  const hm = line.match(/([-0-9.]+)HUMD/);
  for (const ch of S.channels) if (ch in parsed) S.accum[ch].push(parsed[ch]);
  if (tm && isNumStr(tm[1])) { const v = parseFloat(tm[1]); if (Number.isFinite(v)) S.tempAcc.push(v); }
  if (hm && isNumStr(hm[1])) { const v = parseFloat(hm[1]); if (Number.isFinite(v)) S.humdAcc.push(v); }

  const elapsed = (performance.now() - S.startTime) / 1000;
  if (elapsed - S.lastRecordSec < S.interval) return;
  S.lastRecordSec = elapsed;
  recordSample(Math.round(elapsed));
}

function recordSample(recordSec) {
  const avg = {};
  const hasSample = {};
  for (const ch of S.channels) {
    const a = S.accum[ch];
    hasSample[ch] = a.length > 0;
    avg[ch] = a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    S.accum[ch] = [];
  }
  const avgT = S.tempAcc.length ? S.tempAcc.reduce((x, y) => x + y, 0) / S.tempAcc.length : 0;
  const avgH = S.humdAcc.length ? S.humdAcc.reduce((x, y) => x + y, 0) / S.humdAcc.length : 0;
  S.tempAcc = []; S.humdAcc = [];

  if (!S.hasR0) { S.r0 = { ...avg }; S.hasR0 = true; log("R0 已自動擷取（首筆平均值）。"); }

  pushBuf(S.timeBuf, recordSec);
  pushBuf(S.tempBuf, avgT); pushBuf(S.humdBuf, avgH);
  const sens = {}, sensInv = {};
  for (const ch of S.channels) {
    pushBuf(S.dataBuf[ch], avg[ch]);
    // S6：只有真的收到該通道資料才計數，缺值區間不增加——自動校正等新樣本時才不會拿到補 0 的假資料
    if (hasSample[ch]) S.seq[ch] = (S.seq[ch] || 0) + 1; // 單調計數，不受 MAXP 截斷影響（H1）
    const r0 = S.r0[ch] || 1;
    const sv = r0 !== 0 ? avg[ch] / r0 : 1;
    const svInv = avg[ch] !== 0 ? r0 / avg[ch] : 1;
    pushBuf(S.sensBuf[ch], sv);
    pushBuf(S.sensBufInv[ch], svInv);
    sens[ch] = sv; sensInv[ch] = svInv;
    mainChart.push(ch, recordSec, S.mode === "SENSITIVITY" ? (S.sensRatio === "R/R0" ? sv : svInv) : avg[ch]);
    // 讀到 R=0 該通道就從主圖隱藏，讀到非 0 即恢復；沒收到樣本不更動狀態
    if (hasSample[ch]) mainChart.setAutoHidden(ch, avg[ch] === 0);
  }

  const timerSec = currentTimerSec();
  const row = [recordSec, timerSec, ...S.channels.map((ch) => (hasSample[ch] ? avg[ch].toFixed(3) : "")), avgT.toFixed(2), avgH.toFixed(2)];
  S.csvRows.push(row);
  if (S.recording) {
    S.recResRows.push(row);
    S.recSensRows.push([recordSec, timerSec, ...S.channels.map((ch) => (hasSample[ch] ? sens[ch].toFixed(4) : "")), avgT.toFixed(2), avgH.toFixed(2)]);
    S.recSensRowsInv.push([recordSec, timerSec, ...S.channels.map((ch) => (hasSample[ch] ? sensInv[ch].toFixed(4) : "")), avgT.toFixed(2), avgH.toFixed(2)]);
  }
  updateLiveUI(avg, S.sensRatio === "R/R0" ? sens : sensInv, avgT, avgH, recordSec);
}

// 依目前模式與靈敏度比值（R/R0 或 R0/R）重建主圖序列
function rebuildMainChart() {
  mainChart.clear();
  for (const ch of S.channels) mainChart.setSeries(ch, channelColorOf(ch));
  const n = S.timeBuf.length;
  for (let i = 0; i < n; i++) {
    const t = S.timeBuf[i];
    for (const ch of S.channels) {
      const buf = S.mode === "SENSITIVITY"
        ? (S.sensRatio === "R/R0" ? S.sensBuf[ch] : S.sensBufInv[ch])
        : S.dataBuf[ch];
      if (buf && buf[i] !== undefined) mainChart.push(ch, t, buf[i]);
    }
  }
  mainChart.redraw(); // M2：重建完立即重畫，不用等下一筆資料才恢復顯示
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

// 16 通道色板：Tableau tab20 挑出的 16 色（深色 10 色在前、淺色 6 色在後，
// 連續通道不同色相；最小色差 ΔE 約 26，舊黃金角取色最小只有約 10）
// 32 通道時循環使用（第 17 通道起與前 16 色重複）。
const CHANNEL_PALETTE = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
  "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#f7b6d2", "#dbdb8d",
];
function channelColorOf(ch) {
  const i = S.channels.indexOf(ch);
  if (i < 0) return "#94a3b8";
  return CHANNEL_PALETTE[i % CHANNEL_PALETTE.length];
}

// 主圖線段色：通道固定色；判定規則啟用且該段為 NO PASS 時變灰
function segmentColor(ch, value) {
  if (activeRule().enabled && judge(value) === "fail") return "#475569";
  return channelColorOf(ch);
}

// 主圖分頁與通道卡共用同一頁（btnChPrev / btnChNext）；btnChAll 切回全部通道
function applyChartPage() {
  if (!S.channels.length || S.chView === "all") { mainChart.pageSet = null; }
  else { const s = S.chPage * 16; mainChart.pageSet = new Set(S.channels.slice(s, s + 16)); }
  renderChartLegend();
  mainChart.redraw();
}

function renderChartLegend() {
  const el = $("chartLegend"); if (!el) return;
  const list = S.channels.length
    ? (S.chView === "all" ? S.channels : S.channels.slice(S.chPage * 16, S.chPage * 16 + 16))
    : [...mainChart.series.keys()];
  el.innerHTML = list.map((ch) => {
    const base = S.channels.includes(ch) ? channelColorOf(ch) : (mainChart.series.get(ch)?.color || "#94a3b8");
    const dim = !mainChart.isEffectivelyVisible(ch);
    return `<span style="color:${dim ? "#64748b" : base}">${dim ? "□" : "■"} ${ch}</span>`;
  }).join("");
}

// 圖例切換：end＝右側直排標籤（新版），top＝上方橫排圖例（舊版）
function applyLegendMode() {
  const isEnd = S.legendMode !== "top";
  $("btnLegend").textContent = isEnd ? "標籤：線尾" : "標籤：圖例";
  $("btnLegend").classList.toggle("on", isEnd);
  const el = $("chartLegend");
  if (el) el.style.display = isEnd ? "none" : "";
  mainChart.setEndLabels(isEnd);
  if (!isEnd) renderChartLegend();
}

function updateLiveUI(avg, sens, avgT, avgH, recordSec) {
  $("modTemp").textContent = avgT.toFixed(2);
  $("modHumd").textContent = avgH.toFixed(2);

  // 通道卡
  const vals = S.mode === "SENSITIVITY" ? sens : avg;
  const unit = S.mode === "SENSITIVITY" ? S.sensRatio : "kΩ";
  for (const ch of S.channels) {
    const el = document.querySelector(`[data-ch="${ch}"]`);
    if (!el) continue;
    const v = vals[ch];
    el.querySelector(".ch-val").textContent = S.mode === "SENSITIVITY" ? v.toFixed(4) : v.toFixed(2);
    el.querySelector(".ch-unit").textContent = unit;
    const j = judge(v);
    el.classList.toggle("pass", j === "pass");
    el.classList.toggle("fail", j === "fail");
    // R=0 自動隱藏時卡片也跟著變暗（與手動關掉同一種 off 狀態）；使用者手動開顯示後就恢復亮
    const off = !mainChart.isEffectivelyVisible(ch);
    el.classList.toggle("off", off);
    el.querySelector(".ch-badge").classList.toggle("off", off);
    el.querySelector(".ch-badge").textContent = j === "pass" ? "PASS" : j === "fail" ? "NO PASS" : ch;
  }
  refreshSparks();
  renderChartLegend(); // 圖例跟著自動隱藏狀態即時更新

  // 主圖：每通道固定色，NO PASS 線段變灰
  const colorFn = (name, v) => segmentColor(name, v);
  mainChart.draw(recordSec, S.mode === "SENSITIVITY" ? `靈敏度 ${S.sensRatio}` : "電阻 kΩ", colorFn);

  const mm = String(Math.floor(recordSec / 60)).padStart(2, "0");
  const ss = String(recordSec % 60).padStart(2, "0");
  const pg = S.channels.length > 16
    ? (S.chView === "all" ? ` · 主圖 (1–${S.channels.length})`
      : ` · 主圖 (${S.chPage * 16 + 1}–${Math.min((S.chPage + 1) * 16, S.channels.length)})`) : "";
  $("chartInfo").textContent =
    `已記錄 ${S.timeBuf.length} 點 · 經過 ${mm}:${ss} · ${S.channels.length} 通道 · ` +
    (S.recording ? "● 記錄中" : "未記錄") + pg;
}

function renderChannelGrid() {
  const grid = $("chGrid");
  grid.innerHTML = "";
  const isAll = S.chView === "all";
  const start = isAll ? 0 : S.chPage * 16;
  const list = isAll ? S.channels : S.channels.slice(start, start + 16);
  $("chPageLabel").textContent = S.channels.length > 16
    ? (isAll ? `(1–${S.channels.length})` : `(${start + 1}–${start + list.length})`) : "";
  for (const ch of list) {
    const d = document.createElement("div");
    d.className = "ch-card"; d.dataset.ch = ch; d.title = "點按開關主圖線顯示";
    d.style.borderLeft = `4px solid ${channelColorOf(ch)}`;
    d.innerHTML = `<span class="ch-badge">${ch}</span><div class="ch-name">CH ${ch}</div>
      <div><span class="ch-val">--</span> <span class="ch-unit"></span></div>
      <canvas class="ch-spark" height="44"></canvas>`;
    // 整張通道卡就是線標開關：點卡片任一處開關該通道在主圖的線，不影響記錄與小趨勢圖；
    // 翻頁重建時狀態以主圖為準，不會把關掉的線偷偷開回來
    const badge = d.querySelector(".ch-badge");
    const off = !mainChart.isEffectivelyVisible(ch);
    d.classList.toggle("off", off); badge.classList.toggle("off", off);
    d.onclick = () => {
      // 以實際有沒有畫出來為準切換：正在顯示就關掉；沒顯示就開顯示——
      // 若是 R=0 被自動隱藏，開顯示會強制顯示（R=0 也畫得出來），直到 R 恢復非 0 才解除強制
      if (mainChart.isEffectivelyVisible(ch)) {
        mainChart.setVisible(ch, false);
      } else {
        mainChart.setVisible(ch, true);
        if (mainChart.isAutoHidden(ch)) mainChart.forceVisible(ch, true);
      }
      const offNow = !mainChart.isEffectivelyVisible(ch);
      d.classList.toggle("off", offNow); badge.classList.toggle("off", offNow);
      mainChart.redraw(); renderChartLegend();
    };
    grid.appendChild(d);
  }
  refreshSparks();
  applyChartPage();
}

/* 通道小趨勢圖：取該通道緩衝區最後一段畫迷你折線 */
function drawSpark(cv, vals, color) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(60, cv.clientWidth || 120), h = 44;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b1220"; ctx.fillRect(0, 0, w, h);
  const data = vals.filter(Number.isFinite);
  if (data.length < 2) return;
  let mn = Infinity, mx = -Infinity;
  for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!(mx > mn)) mx = mn + 1;
  const pad = (mx - mn) * 0.1 || 1; mn -= pad; mx += pad;
  const n = data.length;
  ctx.strokeStyle = color || "#38bdf8"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = 2 + (i / (n - 1)) * (w - 4);
    const y = h - 4 - ((data[i] - mn) / (mx - mn)) * (h - 8);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

function refreshSparks() {
  const sensMode = S.mode === "SENSITIVITY";
  for (const ch of S.channels) {
    const el = document.querySelector(`[data-ch="${ch}"]`);
    if (!el) continue;
    const buf = sensMode ? (S.sensRatio === "R/R0" ? S.sensBuf[ch] : S.sensBufInv[ch]) : S.dataBuf[ch];
    const arr = buf || [];
    const last = arr.length ? arr[arr.length - 1] : NaN;
    const color = segmentColor(ch, last);
    drawSpark(el.querySelector(".ch-spark"), arr.slice(-120), color);
  }
}

/* ---------------- 連線 UI ---------------- */
function updateConnUI() {
  $("btnConnect").disabled = S.connected;
  $("btnDisconnect").disabled = !S.connected && !S.reconnecting; // 重連中也要能手動斷開停止
  $("connStatus").classList.toggle("on", S.connected);
  $("connText").textContent = S.connected ? "已連線" : (S.reconnecting ? "重連中…" : "未連線");
  updateWorkflowUI();
}
// 流程顏色提醒（只提醒，不擋操作）：連上後自動校正亮主色；四組全校完換開始記錄亮主色；記錄中兩者都回復原色
function updateWorkflowUI() {
  const allDone = Array.isArray(S.calDone) && S.calDone.length >= 4;
  const esp = S.connected && S.instrument === "esp32" && !S.recording;
  const autoBtn = $("btnAutoCal");
  if (autoBtn) autoBtn.classList.toggle("primary", esp && !allDone);
  const recBtn = $("btnRecToggle");
  if (recBtn) recBtn.classList.toggle("primary", esp && allDone);
}
function updateCalIndicators() {
  for (let g = 0; g < 4; g++) {
    const el = $(`adcCal${g + 1}`);
    if (el) el.classList.toggle("done", Array.isArray(S.calDone) && S.calDone.includes(g));
  }
}

// M6：新場次開始前，先把上一場未寫出的資料存下來再清空。
// 記錄中的資料一律走 stopRecording(true)（使用者可見的存檔）；分段緩衝先 flush。
// 只有存檔完成（或使用者取消存檔）後才清空，避免手動斷開再連接時整段記錄被靜默丟棄。
async function resetSession() {
  clearNoDataTimer(); // M4：舊場次的看門狗作廢，由 esp32Setup 重新武裝
  if ((S.csvRows.length || S.prevDownloadRows.length) && S.hasData) {
    try { await flushSegment(); } catch {}
  }
  if (S.recording) await stopRecording(true);
  Object.assign(S, {
    channels: [], hasData: false, startTime: performance.now(), lastRecordSec: 0,
    accum: {}, tempAcc: [], humdAcc: [],
    timeBuf: [], dataBuf: {}, sensBuf: {}, sensBufInv: {}, tempBuf: [], humdBuf: [],
    r0: {}, hasR0: false, csvRows: [], prevDownloadRows: [], lineBuf: "",
    seq: {}, droppedLines: 0, lastDropWarn: 0,
    segStart: performance.now(), segFileHandle: null, calDone: [],
  });
  mainChart.clear(); mainChart.resetVisible();
  $("chGrid").innerHTML = "";
  $("chartInfo").textContent = "等待資料…";
  updateCalIndicators(); updateWorkflowUI();
}

/* ---------------- 儀器切換 ---------------- */
const BAUDS = {
  esp32: ["9600", "115200"],
  keithley: ["9600", "19200", "38400", "57600"],
  agilent: ["9600", "19200"],
};
// GPIB 位址預設（Keithley 2400 出廠 24；Agilent 34401A 出廠 22）
const GPIB_DEFAULTS = { keithley: "GPIB0::24::INSTR", agilent: "GPIB0::22::INSTR" };
// Agilent 34401A 量測功能與檔位
const AGILENT_FUNCS = {
  "VOLT:DC": { label: "DCV", unit: "V", ranges: ["AUTO", "0.1", "1", "10", "100", "1000"] },
  "CURR:DC": { label: "DCI", unit: "A", ranges: ["AUTO", "0.01", "0.1", "1", "3"] },
  "RES":     { label: "2WΩ", unit: "Ω", ranges: ["AUTO", "100", "1e3", "1e4", "1e5", "1e6", "1e7", "1e8"] },
  "FRES":    { label: "4WΩ", unit: "Ω", ranges: ["AUTO", "100", "1e3", "1e4", "1e5", "1e6", "1e7", "1e8"] },
};
function applyInstrumentUI(mode) {
  const sel = $("baudSel");
  sel.innerHTML = "";
  for (const b of BAUDS[mode]) {
    const o = document.createElement("option");
    o.value = b; o.textContent = b;
    sel.appendChild(o);
  }
  sel.value = mode === "esp32" ? "115200" : "9600";
  const isScpi = mode !== "esp32";
  $("connModeRow").hidden = !isScpi;
  updateConnModeUI();
  $("kCard").hidden = mode !== "keithley";
  $("aCard").hidden = mode !== "agilent";
  $("adcCard").hidden = isScpi;
  $("chartEnv").hidden = isScpi;
  $("measCard").hidden = isScpi;
  $("recRow").hidden = isScpi;
  $("chartTitle").textContent =
    mode === "keithley" ? "即時監控圖 — 電阻 (Ω)" :
    mode === "agilent" ? "即時監控圖 — Agilent 34401A" : "即時監控圖 — 電阻 (kΩ)";
  // GPIB 位址依儀器帶入（各自保存，否則用出廠預設）
  const c = store.load();
  // 一次性遷移：舊版只有全域 gpibAddr，那只能是 Keithley 的
  if (c.gpibAddr && !c["gpibAddr_keithley"] && !c["gpibAddr_agilent"]) {
    c["gpibAddr_keithley"] = c.gpibAddr;
    store.save(c);
  }
  $("gpibAddr").value = c["gpibAddr_" + mode] || GPIB_DEFAULTS[mode] || "";
}
// 依連接方式顯示／隱藏 GPIB 位址列、鮑率列，並更新提示文字
// ESP32 不走 SCPI 連接方式：無論之前存的是什麼模式，連接方式列與
// GPIB 位址列都要強制隱藏，避免讓人以為 ESP32 還需要這些設定。
function updateConnModeUI() {
  const isScpi = S.instrument !== "esp32";
  const gpib = isScpi && $("connModeSel").value === "gpib";
  $("connModeRow").hidden = !isScpi;
  $("gpibRow").hidden = !gpib;
  $("baudRow").hidden = gpib;
  $("btnConnect").textContent = !isScpi ? "連接 COM" : (gpib ? "連接 GPIB" : "連接");
}
async function setInstrument(mode) {
  if (mode !== "esp32" && mode !== "keithley" && mode !== "agilent") return;
  if (S.connected) await disconnectSerial();
  S.instrument = mode;
  applyInstrumentUI(mode);
  const c = store.load();
  const saved = c["baud_" + mode];
  $("baudSel").value = (saved && BAUDS[mode].includes(saved)) ? saved
    : (mode === "esp32" ? "115200" : "9600");
  if (mode === "agilent") aBuildRanges();
  saveSettings();
  log(mode === "keithley"
    ? "已切換為 Keithley 2400 模式（連接方式：RS-232 直連／GPIB 橋接）。"
    : mode === "agilent"
    ? "已切換為 Agilent 34401A 模式（連接方式：RS-232 直連／GPIB 橋接）。"
    : "已切換為 ESP32 模式（預設 115200 baud）。");
}

/* ---------------- CSV 下載 / 分段存檔 ---------------- */
function csvHeader() {
  if (S.instrument === "keithley") {
    return ["Time(s)", "V_set(V)", "V_meas(V)", "I_meas(A)", "R(Ohm)", "R0(Ohm)",
      "R0/R", "R/R0", "dR_R0(%)", "dR_R(%)", "Compliance"];
  }
  if (S.instrument === "agilent") {
    return ["Time(s)", "Function", "Reading", "Unit"];
  }
  return ["Time(s)", "Timer(s)", ...S.channels, "TEMP", "HUMD"];
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
// M7：下載模式無法確認瀏覽器是否真的存下檔案，所以下載觸發後不直接丟棄
// 本段資料——先移到 prevDownloadRows，下次分段再隨新資料一併下載一次，
// 之後才丟棄（每段至少被提供下載兩次）；只有資料夾寫入成功才立即清空。
async function flushSegment() {
  if (S.segBusy || (!S.csvRows.length && !S.prevDownloadRows.length) || !S.hasData) return;
  S.segBusy = true;
  // S1：先把本批從 S.csvRows 切出來，寫入期間（await）新到的資料留在 S.csvRows，不會被寫完後的清空一起丟掉
  const prevN = S.prevDownloadRows.length;
  const batch = S.csvRows.splice(0);
  const rows = [...S.prevDownloadRows, ...batch];
  try {
    if (S.dirHandle) {
      // 同一場量測共用一個檔：首次分段建檔，之後追加
      if (!S.segFileHandle) {
        S.segFileHandle = await S.dirHandle.getFileHandle(`omx_${stamp()}.csv`, { create: true });
      }
      const f = await S.segFileHandle.getFile();
      const body = rows.map((r) => r.join(",")).join("\r\n") + "\r\n";
      const text = (f.size === 0 ? "\uFEFF" + csvHeader().join(",") + "\r\n" : "") + body;
      const w = await S.segFileHandle.createWritable({ keepExistingData: true });
      await w.seek(f.size);
      await w.write(text);
      await w.close();
      log(`分段存檔：已追加 ${rows.length} 筆 → 所選資料夾（同一檔案累積）。`);
      S.prevDownloadRows = []; // 本批已寫入；寫入期間新到的資料仍在 S.csvRows，不清空
    } else {
      // 下載模式無法追加，維持每段一個檔
      if (!S.downloadWarned) {
        S.downloadWarned = true;
        log("提醒：下載模式下瀏覽器可能阻擋多次自動下載，請在網址列允許本站自動下載多個檔案，否則分段檔可能無法儲存。");
      }
      const filename = `omx_${stamp()}.csv`;
      const text = buildCSVText(rows);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      log(`分段存檔：${filename}（${rows.length} 筆${prevN ? `，含上段未確認的 ${prevN} 筆` : ""}）→ 已下載（下載模式無法確認是否成功，本段將於下次分段再下載一次）。`);
      S.prevDownloadRows = batch; // 下次再提供一次（沿用每段至少兩次的備援）
    }
    S.segStart = performance.now();
  } catch (e) {
    S.csvRows.unshift(...batch); // 寫入失敗：本批放回佇列，下次再試
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
    rep.getCell("A2").value = "Keithley 2400（" + (S.kLink === "gpib" ? "GPIB 橋接" : "Web Serial / RS-232") + "）";
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
     ["Instrument", "Keithley 2400 (" + (S.kLink === "gpib" ? "GPIB bridge" : "RS-232 / Web Serial") + ")"],
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

function updateRecUI() {
  const btn = $("btnRecToggle"), st = $("recState");
  if (!btn) return;
  btn.textContent = S.recording ? "停止記錄" : "開始記錄";
  btn.classList.toggle("recording", S.recording);
  if (st) { const t = $("recText"); if (t) t.textContent = S.recording ? "紀錄中" : "未記錄"; st.classList.toggle("rec-on", S.recording); }
  updateWorkflowUI();
}
async function writeTextToDir(dir, filename, text) {
  const h = await dir.getFileHandle(filename, { create: true });
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
}
// 儲存已記錄的三份資料（資料夾寫入優先，否則下載）；回傳是否已處置
// （存檔成功或已觸發下載）。使用者取消時回傳 false，資料保留不清空。
async function saveRecordedRows() {
  if (!S.recResRows.length) return true;
  const n = S.recResRows.length;
  const st = stamp();
  const resName = `gas_resistance_${st}.csv`;
  const sensName = `gas_sensitivity_R_R0_${st}.csv`;
  const sensInvName = `gas_sensitivity_R0_R_${st}.csv`;
  // 三檔只問一次位置：已選過分段資料夾就直接寫入該夾，否則彈一次
  // 資料夾選擇、三檔都寫進去；資料夾寫入不可用或被取消時，才退回
  // 原本的多次自動下載，避免資料沒存到。
  let saved = false, cancelled = false;
  const tryDir = async (dir) => {
    await writeTextToDir(dir, resName, buildCSVText(S.recResRows));
    await writeTextToDir(dir, sensName, buildCSVText(S.recSensRows));
    await writeTextToDir(dir, sensInvName, buildCSVText(S.recSensRowsInv));
    log(`記錄停止，已寫入 ${dir.name}：${resName}、${sensName}、${sensInvName}（${n} 筆）。`);
  };
  if ("showDirectoryPicker" in window) {
    try {
      if (S.dirHandle) { await tryDir(S.dirHandle); saved = true; }
    } catch (e) { log(`寫入已選資料夾失敗：${e.message}，改請選擇資料夾。`); }
    if (!saved) {
      try {
        const dir = await window.showDirectoryPicker({ mode: "readwrite" });
        await tryDir(dir); saved = true;
      } catch (e) {
        if (e.name === "AbortError") { cancelled = true; log("儲存已取消，記錄資料未寫出。"); }
        else log(`寫入資料夾失敗，改用下載：${e.message}`);
      }
    }
  }
  if (!saved && !cancelled) {
    downloadCSV(resName, S.recResRows);
    downloadCSV(sensName, S.recSensRows);
    downloadCSV(sensInvName, S.recSensRowsInv);
    log(`記錄停止，已下載 ${n} 筆。`);
    saved = true;
  }
  return saved;
}

// S2：只有存檔成功（或已觸發下載）才清空；使用者取消儲存時保留資料，
// 再按開始記錄會先重試儲存，不會被新記錄靜默蓋掉。
async function stopRecording(download = true) {
  if (!S.recording) return;
  S.recording = false;
  updateRecUI();
  const saved = download ? await saveRecordedRows() : true;
  if (saved) {
    S.recResRows = []; S.recSensRows = []; S.recSensRowsInv = [];
  } else {
    log("記錄資料仍保留，再按開始記錄會先重試儲存。");
  }
}

/* ---------------- ADC 校正 ---------------- */
function fmtAdc(v) { return String(parseFloat(Number(v).toFixed(4))); }
function fmtR(v) { return Number.isFinite(v) ? Number(v).toPrecision(4) : ""; }
/* ---------------- ADC 自動校正 ----------------
 * 原理（不依賴韌體內部分壓公式）：
 * 網頁只收到 ESP32 已換算好的電阻值（kΩ，見 S.dataBuf），不知道
 * 原始 ADC 計數與負載電阻，所以不用公式一次反推參考電壓，改用
 * 閉迴路試探：先以 +0.02 V 試探，量出「參考電壓每變 1 V、讀值變
 * 多少 kΩ」的斜率與方向，再依誤差逐步調整、每步不超過 0.10 V，
 * 直到讀值落在目標 ±1% 內。失敗時把原值送回，板子不留壞值。
 * 注意：校正的是整組 ADC，ADC1=A–D、ADC2=E–H、ADC3=I–L、
 * ADC4=M–P，同一組的 4 個通道會一起受影響。 */
function adcGroupForChannel(ch) {
  if (!ch) return -1;
  if (/^[A-P]$/.test(ch)) return Math.floor((ch.charCodeAt(0) - 65) / 4);
  // 32 通道時只有 4 組校正值，後 16 通道以 16 為週期循環對應
  const idx = S.channels.indexOf(ch);
  return idx >= 0 ? Math.floor((idx % 16) / 4) : -1;
}
function adcGroupChannels(group) {
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];
  return letters.slice(group * 4, group * 4 + 4).join("、");
}
function medianOf(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForFreshSamples(ch, fromSeq, need, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // 以單調計數 S.seq 判斷新樣本，不用 buffer 長度（buffer 滿 3600 後長度不再前進）
    if ((S.seq[ch] || 0) >= fromSeq + need) return (S.dataBuf[ch] || []).slice(-need);
    if (!S.connected) throw new Error("連線已中斷");
    await sleepMs(200);
  }
  throw new Error("等不到新的量測資料（逾時）");
}
async function readChannelMedian(ch) {
  // 每筆平均值約 S.interval 秒一筆，留 2 筆的緩衝再加 5 秒給韌體反應
  const timeoutMs = Math.max(15000, (2 + 2) * (S.interval || 1) * 1000 + 5000);
  const samples = await waitForFreshSamples(ch, S.seq[ch] || 0, 2, timeoutMs);
  return medianOf(samples);
}
async function sendAdcValues(vs) {
  await writeLine("y" + vs.map(fmtAdc).join(" ") + "\n");
}
// 自動校正通道選單：按 ADC 組分 4 色，4 個通道一色，
// 後 16 通道以 16 為週期循環對應，故顏色也跟著循環。
// 淺色底＋深色字，展開的選單與收起的選單都看得清楚。
const AUTO_CAL_GROUP_COLORS = ["#dbeafe", "#dcfce7", "#fef3c7", "#fce7f3"];
function autoCalGroupColor(ch) {
  const g = adcGroupForChannel(ch);
  return g >= 0 ? AUTO_CAL_GROUP_COLORS[g] : "";
}
function refreshAutoCalChannels() {
  const sel = $("autoCalCh");
  if (!sel || !S.channels.length) return;
  const cur = sel.value;
  sel.innerHTML = "";
  for (const ch of S.channels) {
    const o = document.createElement("option");
    o.value = ch; o.textContent = ch;
    o.style.backgroundColor = autoCalGroupColor(ch);
    o.style.color = "#111827";
    sel.appendChild(o);
  }
  if (S.channels.includes(cur)) sel.value = cur;
  // 收起的選單跟著目前選到的通道換色
  sel.style.backgroundColor = autoCalGroupColor(sel.value);
  sel.style.color = "#111827";
  sel.onchange = () => {
    sel.style.backgroundColor = autoCalGroupColor(sel.value);
    sel.style.color = "#111827";
  };
}
let autoCalRunning = false;
async function autoCalibrate() {
  if (autoCalRunning) return;
  const ch = $("autoCalCh") ? $("autoCalCh").value : "";
  const target = $("autoCalR") ? parseFloat($("autoCalR").value) : NaN;
  if (!ch) { log("自動校正失敗：請先選擇通道。"); return; }
  if (!Number.isFinite(target) || target <= 0) {
    log("自動校正失敗：校正電阻需為大於 0 的數字（kΩ）。"); return;
  }
  if (!S.connected || S.instrument !== "esp32") {
    log("自動校正失敗：需先連接 ESP32。"); return;
  }
  if (!S.hasData || !S.channels.includes(ch)) {
    log(`自動校正失敗：尚未收到通道 ${ch} 的資料，請先連線並等首筆資料。`); return;
  }
  const group = adcGroupForChannel(ch);
  if (group < 0 || group > 3) {
    log(`自動校正失敗：通道 ${ch} 無法對應到 ADC1–ADC4。`); return;
  }
  const orig = [...S.adc];
  const origV = orig[group];
  const tol = target * 0.01;
  // 最佳值追蹤：最終留誤差最小的一組，而非最後一組；±1% 只是可接受門檻，不是停損點
  let bestV = origV, bestVs = [...orig], bestMeasured = NaN, bestErr = Infinity, origErr = Infinity;
  const noteBest = (v, vs, m) => {
    const e = Math.abs(m - target);
    if (e < bestErr) { bestErr = e; bestV = v; bestVs = [...vs]; bestMeasured = m; }
    return e;
  };
  autoCalRunning = true;
  $("btnAutoCal").disabled = true;
  $("autoCalState").textContent = "校正中…";
  try {
    log(`自動校正開始：通道 ${ch}（${adcGroupChannels(group)}，ADC${group + 1}）目標 ${target} kΩ，現值 ADC${group + 1}=${fmtAdc(origV)} V；請確認該通道已接上標準電阻。`);
    let measured = await readChannelMedian(ch);
    origErr = noteBest(origV, orig, measured);
    log(`自動校正：通道 ${ch} 目前讀值 ${fmtR(measured)} kΩ（目標 ${target} kΩ，容許 ±1%）`);
    // 試探一步，量出方向與斜率
    if (origV >= 6) throw new Error("參考電壓已在 6 V 上限，無法再向上試探");
    let sent = [...orig];
    const probeV = Math.min(6, origV + 0.02);
    sent[group] = probeV;
    await sendAdcValues(sent);
    const measuredProbe = await readChannelMedian(ch);
    noteBest(probeV, sent, measuredProbe);
    let slope = (measuredProbe - measured) / (probeV - origV); // kΩ / V
    log(`自動校正：試探 ADC${group + 1} ${fmtAdc(origV)}→${fmtAdc(probeV)} V，讀值 ${fmtR(measured)}→${fmtR(measuredProbe)} kΩ`);
    if (!Number.isFinite(slope) || Math.abs(slope) < 0.5) {
      throw new Error("試探變化太小，無法判斷調整方向（讀值不穩或該組 ADC 不影響此通道）");
    }
    let curV = probeV, curMeasured = measuredProbe;
    let noImprove = 0;
    for (let i = 0; i < 10; i++) {
      if (bestErr <= target * 0.001) break;
      if (noImprove >= 2) break;
      let dv = (target - curMeasured) / slope * 0.8;
      dv = Math.max(-0.10, Math.min(0.10, dv));
      if (Math.abs(dv) < 0.001) dv = Math.sign(dv || 1) * 0.001;
      const nextV = Math.max(0.1, Math.min(6, curV + dv));
      if (nextV === curV) break;
      const prevV = curV, prevMeasured = curMeasured;
      sent = [...sent]; sent[group] = nextV;
      await sendAdcValues(sent);
      curMeasured = await readChannelMedian(ch);
      curV = nextV;
      if (Math.abs(nextV - prevV) > 0.0005 && Math.abs(curMeasured - prevMeasured) > 0.05) {
        const ns = (curMeasured - prevMeasured) / (nextV - prevV);
        if (Number.isFinite(ns) && Math.abs(ns) >= 0.5) slope = ns;
      }
      const prevBest = bestErr;
      noteBest(curV, sent, curMeasured);
      if (bestErr < prevBest) noImprove = 0; else noImprove++;
      log(`自動校正：第 ${i + 1} 次調整 ADC${group + 1}=${fmtAdc(curV)} V，讀值 ${fmtR(curMeasured)} kΩ`);
    }
    // 回到最佳值（若板子目前不在最佳值上，先送回）
    if (curV !== bestV) { await sendAdcValues(bestVs); }
    S.adc = bestVs; saveSettings();
    if (bestErr <= tol) {
      if (!S.calDone.includes(group)) S.calDone.push(group);
      updateCalIndicators(); updateWorkflowUI();
      $("autoCalState").textContent = `已校正：ADC${group + 1} ${fmtAdc(origV)}→${fmtAdc(bestV)} V（${fmtR(bestMeasured)} kΩ）`;
      log(`自動校正完成：通道 ${ch} ${fmtR(bestMeasured)} kΩ，ADC${group + 1} 由 ${fmtAdc(origV)} V 改為 ${fmtAdc(bestV)} V（y${bestVs.map(fmtAdc).join(" ")}）。`);
    } else if (bestV !== origV) {
      $("autoCalState").textContent = `未達 ±1%，已保留最佳值：ADC${group + 1} ${fmtAdc(bestV)} V（${fmtR(bestMeasured)} kΩ）`;
      log(`自動校正未達 ±1%（最佳 ${fmtR(bestMeasured)} kΩ），已保留最佳值 ADC${group + 1}=${fmtAdc(bestV)} V。`);
    } else {
      try { await sendAdcValues(orig); } catch { /* 還原失敗也如實記錄 */ }
      S.adc = orig;
      $("autoCalState").textContent = "失敗，已還原原值";
      log(`自動校正失敗：10 次調整後仍未進入 ±1%（目前 ${fmtR(curMeasured)} kΩ）；已還原 ADC${group + 1}=${fmtAdc(origV)} V。`);
    }
  } catch (e) {
    // 失敗時留最佳值（若有進步），否則還原原值
    const keepBest = bestV !== origV && bestErr < origErr;
    const restoreVs = keepBest ? bestVs : orig;
    try { await sendAdcValues(restoreVs); } catch { /* 還原失敗也如實記錄 */ }
    S.adc = restoreVs;
    if (keepBest) {
      $("autoCalState").textContent = `未達目標，已保留最佳值：ADC${group + 1} ${fmtAdc(bestV)} V（${fmtR(bestMeasured)} kΩ）`;
      log(`自動校正失敗：${e.message}；已保留最佳值 ADC${group + 1}=${fmtAdc(bestV)} V。`);
    } else {
      $("autoCalState").textContent = "失敗，已還原原值";
      log(`自動校正失敗：${e.message}；已還原 ADC${group + 1}=${fmtAdc(origV)} V。`);
    }
  } finally {
    autoCalRunning = false;
    $("btnAutoCal").disabled = false;
  }
}

/* ---------------- 事件綁定 ---------------- */
function bindEvents() {
  $("btnConnect").onclick = connectSerial;
  $("btnDisconnect").onclick = async () => { await disconnectSerial(); await forgetDevice(); };

  $("instSel").onchange = (e) => setInstrument(e.target.value);

  // Keithley 控制
  $("btnKVolt").onclick = kApplyVoltage;
  $("kVolt").onchange = kApplyVoltage;
  $("kComp").onchange = kApplyCompliance;
  $("btnKOutput").onclick = kToggleOutput;
  $("btnKPause").onclick = kTogglePause;
  $("btnKBase").onclick = kSetBase;
  $("btnKExcel").onclick = kExportExcel;

  // Agilent 34401A 控制
  $("aFunc").onchange = async (e) => {
    S.a.func = e.target.value;
    aBuildRanges();
    saveSettings();
    aUpdateLive(S.a.last);
    if (S.connected && S.instrument === "agilent" && S.a.ready) {
      try { await agilentApplyConfig(); } catch (err) { log("套用設定失敗：" + err.message); }
    }
  };
  $("aRange").onchange = async (e) => {
    S.a.range = e.target.value;
    saveSettings();
    if (S.connected && S.instrument === "agilent" && S.a.ready) {
      try { await agilentApplyConfig(); } catch (err) { log("套用設定失敗：" + err.message); }
    }
  };
  $("aNplc").onchange = async (e) => {
    S.a.nplc = e.target.value;
    saveSettings();
    if (S.connected && S.instrument === "agilent" && S.a.ready) {
      try { await agilentApplyConfig(); } catch (err) { log("套用設定失敗：" + err.message); }
    }
  };
  $("btnAApply").onclick = aApplyUi;
  $("btnAMeasure").onclick = aToggleMeasure;
  $("btnAExcel").onclick = aExportExcel;

  // 實體拔線時進自動重連（不斷場次、不重置記錄）；重插出現新埠時立刻重試
  if ("serial" in navigator && navigator.serial.addEventListener) {
    navigator.serial.addEventListener("disconnect", (e) => {
      // 只認目前正在用的埠：舊埠物件的遲到事件不得殺掉已接回的好連線
      if (S.connected && e.target === S.port) handleUnexpectedDisconnect();
    });
    navigator.serial.addEventListener("connect", () => {
      if (S.reconnecting) tryAutoReconnect();
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
  $("connModeSel").onchange = () => { updateConnModeUI(); saveSettings(); };
  $("gpibAddr").onchange = saveSettings;
  $("btnGpibLaunch").onclick = () => {
    window.location.href = "keithley-bridge://start";
    log("已嘗試啟動本機橋接程式（需先執行過 install_protocol.bat 註冊協定；Chrome 首次會要求確認）。");
  };

  $("btnAutoCal").onclick = autoCalibrate;

  $("btnMode").onclick = () => {
    S.mode = S.mode === "RESISTANCE" ? "SENSITIVITY" : "RESISTANCE";
    const isSens = S.mode === "SENSITIVITY";
    $("btnMode").textContent = isSens ? "靈敏度模式" : "電阻模式";
    $("btnMode").classList.toggle("on", isSens);
    $("chartTitle").textContent = isSens ? `即時監控圖 — 靈敏度 (${S.sensRatio})` : "即時監控圖 — 電阻 (kΩ)";
    $("btnSensRatio").style.display = isSens ? "" : "none";
    rebuildMainChart();
    log(`切換為${isSens ? "靈敏度" : "電阻"}模式。`);
  };

  $("btnSensRatio").onclick = () => {
    S.sensRatio = S.sensRatio === "R/R0" ? "R0/R" : "R/R0";
    $("btnSensRatio").textContent = S.sensRatio;
    $("chartTitle").textContent = `即時監控圖 — 靈敏度 (${S.sensRatio})`;
    rebuildMainChart();
    log(`靈敏度切換為 ${S.sensRatio}。`);
  };

  $("btnLegend").onclick = () => {
    S.legendMode = S.legendMode === "top" ? "end" : "top";
    applyLegendMode();
    saveSettings();
    log(`圖例切換為${S.legendMode === "top" ? "上方橫排圖例" : "右側直排標籤"}。`);
  };

  $("btnR0").onclick = () => {
    if (!S.hasData || !S.timeBuf.length) { log("尚無資料，無法設置 Rair。"); return; }
    for (const ch of S.channels) {
      const b = S.dataBuf[ch];
      if (b.length) S.r0[ch] = b[b.length - 1];
    }
    // 靈敏度緩衝需重算（R/R0 與 R0/R 兩種都算）
    for (const ch of S.channels) {
      S.sensBuf[ch] = S.dataBuf[ch].map((v) => (S.r0[ch] ? v / S.r0[ch] : 1));
      S.sensBufInv[ch] = S.dataBuf[ch].map((v) => (v ? S.r0[ch] / v : 1));
    }
    log("設置 Rair 成功（以目前最新值為基準）。");
  };

  $("btnRecToggle").onclick = async () => {
    if (S.recording) { stopRecording(true); return; }
    // 上次停止時取消儲存、資料仍保留：先重試儲存，存好再開始新記錄
    if (S.recResRows.length) {
      const saved = await saveRecordedRows();
      if (!saved) { log("尚有未儲存的記錄資料，請先完成儲存再開始新記錄。"); return; }
      S.recResRows = []; S.recSensRows = []; S.recSensRowsInv = [];
    }
    if (!S.hasData) { log("尚未收到通道資料，無法開始記錄。"); return; }
    S.recording = true; S.recResRows = []; S.recSensRows = []; S.recSensRowsInv = [];
    updateRecUI();
    log("開始手動記錄。");
  };

  // M2：碼表改以 performance.now() 時間戳計時，不再數 setInterval tick，
  // 背景分頁計時器被節流也不會落後——回來時由時間戳直接算出正確秒數。
  // 開始／歸零同一按鈕：沒跑按「計時開始」起跑，跑著按「歸零」停止並歸零（不記分圈）。
  const syncTimerBtn = () => { $("btnTimerToggle").textContent = S.timerRunning ? "歸零" : "計時開始"; };
  $("btnTimerToggle").onclick = () => {
    if (S.timerRunning) {
      S.timerRunning = false; S.timerStartMs = 0; S.timerAccumMs = 0; S.timerSec = 0; drawTimer();
    } else {
      S.timerRunning = true; S.timerStartMs = performance.now();
    }
    syncTimerBtn();
  };
  setInterval(() => {
    if (S.timerRunning) {
      S.timerSec = Math.floor((S.timerAccumMs + performance.now() - S.timerStartMs) / 1000);
      drawTimer();
    }
  }, 1000);

  $("btnChPrev").onclick = () => { S.chView = "page"; if (S.chPage > 0) S.chPage--; renderChannelGrid(); };
  $("btnChNext").onclick = () => {
    S.chView = "page";
    if ((S.chPage + 1) * 16 < S.channels.length) S.chPage++;
    renderChannelGrid();
  };
  $("btnChAll").onclick = () => { S.chView = "all"; renderChannelGrid(); };

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

  // M2：分頁隱藏時盡力先把當前分段寫出（背景計時器會被節流到約 1 分鐘一次，
  // 不能只靠它）；回到可見時 Wake Lock 已被瀏覽器自動釋放，需重新請求。
  // 下載模式跳過隱藏寫出：沒選資料夾時每次切分頁都會觸發一次下載跳窗；
  // 只在資料夾模式才寫出（無聲寫入）。下載模式仍靠分段計時與關頁下載。
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (S.recording && S.csvRows.length && S.dirHandle) flushSegment().catch(() => {});
    } else if (S.connected) {
      requestWakeLock();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    // Keithley 安全：盡力關閉 Output（不等待回應；GPIB 經 WebSocket 同步送出）
    if (S.instrument === "keithley" && S.connected && S.k.outputOn) {
      try { writeLine(":OUTP OFF\n").catch(() => {}); } catch {}
    }
    if (S.recording && S.recResRows.length) {
      downloadCSV(`gas_resistance_${stamp()}.csv`, S.recResRows);
    }
    // M6：記錄中或仍有未寫出的分段資料時，跳出離開確認，避免整段資料靜默遺失。
    // 下載嘗試仍保留（見上方），警告只是多一道防線。
    if (S.recording || S.csvRows.length || S.prevDownloadRows.length || S.recResRows.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function fmtHMS(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function currentTimerSec() {
  return S.timerRunning ? Math.floor((S.timerAccumMs + performance.now() - S.timerStartMs) / 1000) : S.timerSec;
}
function drawTimer() {
  $("timerDisplay").textContent = fmtHMS(S.timerSec);
}

/* ---------------- Sensor 標籤 ---------------- */
// 通道對應的氣體標籤，僅供對照看，不影響量測。16 通道 A–P：A=CO、B=NO2、C=H2S、D 無 sensor、
// E=CH4、F=EtOH、G=CH2-4、H=H2、I=VOCs、J=NH3、K–P 無 sensor；可在 textbox 直接改，改動隨設定存 localStorage。
// 注意：標籤 input 只能用 data-sensor-ch，不可用 data-ch——通道卡也用 data-ch，
// updateLiveUI／refreshSparks 是用 querySelector('[data-ch="..."]') 找通道卡，
// 若標籤 input 也叫 data-ch 且在左側邊欄先出現，就會被誤認成通道卡，
// 再對 input 取 .ch-val（null）的 textContent 會丟錯，readLoop 會誤判為讀取失敗而重連。
const SENSOR_CHS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];
const SENSOR_DEFAULTS = { A: "CO", B: "NO2", C: "H2S", D: "", E: "CH4", F: "EtOH", G: "CH2-4", H: "H2", I: "VOCs", J: "NH3", K: "", L: "", M: "", N: "", O: "", P: "" };
const SUB_DIGITS = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉" };
function sensorSub(s) { return String(s).replace(/\d/g, d => SUB_DIGITS[d] || d); }
function sensorTags() {
  const t = {};
  for (const ch of SENSOR_CHS) {
    const v = S.sensorTags && S.sensorTags[ch];
    t[ch] = typeof v === "string" ? v : (SENSOR_DEFAULTS[ch] || "");
  }
  return t;
}
function renderSensorBox() {
  const grid = $("sensorGrid");
  if (!grid) return;
  if (!S.sensorTags || typeof S.sensorTags !== "object") S.sensorTags = {};
  const tags = sensorTags();
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  grid.innerHTML = "";
  for (const ch of SENSOR_CHS) {
    const d = document.createElement("div");
    d.className = "sensor-tag" + (tags[ch] ? "" : " empty");
    d.innerHTML = `<span class="sensor-ch">${ch}</span>` +
      `<input type="text" class="sensor-input" data-sensor-ch="${ch}" value="${esc(tags[ch])}" placeholder="無 sensor" spellcheck="false" autocomplete="off">`;
    grid.appendChild(d);
  }
  grid.querySelectorAll(".sensor-input").forEach(inp => {
    inp.addEventListener("input", () => {
      S.sensorTags[inp.dataset.sensorCh] = inp.value;
      inp.closest(".sensor-tag").classList.toggle("empty", !inp.value.trim());
      saveSettings();
    });
    inp.addEventListener("blur", () => {
      const v = sensorSub(inp.value.trim());
      inp.value = v;
      S.sensorTags[inp.dataset.sensorCh] = v;
      inp.closest(".sensor-tag").classList.toggle("empty", !v);
      saveSettings();
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
  });
  const btn = $("btnSensorReset");
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.onclick = () => {
      S.sensorTags = { ...SENSOR_DEFAULTS };
      saveSettings();
      renderSensorBox();
    };
  }
}

/* ---------------- 設定存取 ---------------- */
function saveSettings() {
  const c = store.load();
  c.baud = $("baudSel").value;
  c["baud_" + S.instrument] = $("baudSel").value;
  c.interval = S.interval; c.adc = S.adc; c.rules = S.rules; c.sensorTags = S.sensorTags;
  c.segMs = S.segMs; c.instrument = S.instrument; c.kVolt = S.k.vSet; c.kComp = S.k.comp;
  c.legendMode = S.legendMode;
  c.kLink = $("connModeSel").value; c.gpibAddr = $("gpibAddr").value;
  c["gpibAddr_" + S.instrument] = $("gpibAddr").value;
  c.aFunc = S.a.func; c.aRange = S.a.range; c.aNplc = S.a.nplc;
  store.save(c);
}
function loadSettings() {
  const c = store.load();
  if (c.instrument === "keithley" || c.instrument === "esp32" || c.instrument === "agilent") {
    // 先套用儀器（會重建鮑率選項），再套用其他設定
    S.instrument = c.instrument;
    $("instSel").value = c.instrument;
    applyInstrumentUI(c.instrument);
  }
  if (c.baud && BAUDS[S.instrument].includes(c.baud)) $("baudSel").value = c.baud;
  const savedBaud = c["baud_" + S.instrument];
  if (savedBaud && BAUDS[S.instrument].includes(savedBaud)) $("baudSel").value = savedBaud;
  if (c.kLink === "gpib" || c.kLink === "serial") $("connModeSel").value = c.kLink;
  updateConnModeUI();
  if (c.aFunc && AGILENT_FUNCS[c.aFunc]) { S.a.func = c.aFunc; $("aFunc").value = c.aFunc; }
  aBuildRanges();
  if (c.aRange && AGILENT_FUNCS[S.a.func].ranges.includes(c.aRange)) {
    S.a.range = c.aRange; $("aRange").value = c.aRange;
  }
  if (c.aNplc) { S.a.nplc = c.aNplc; $("aNplc").value = c.aNplc; }
  if (S.instrument === "agilent") aUpdateLive(NaN);
  if (Number.isFinite(c.kVolt) && c.kVolt >= 0 && c.kVolt <= 5) {
    S.k.vSet = c.kVolt; $("kVolt").value = c.kVolt;
  }
  if (Number.isFinite(c.kComp) && c.kComp > 0 && c.kComp <= 1) {
    S.k.comp = c.kComp; $("kComp").value = c.kComp;
  }
  if (c.interval) { S.interval = c.interval; $("intervalInput").value = c.interval; }
  if (c.segMs) {
    // 1 小時選項已移除：舊設定自動遷移為 30 分鐘
    S.segMs = c.segMs === 3600000 ? 1800000 : c.segMs;
    $("segSel").value = String(S.segMs);
    if ($("segSel").value !== String(S.segMs)) { S.segMs = 0; $("segSel").value = "0"; }
  }
  if (Array.isArray(c.adc) && c.adc.length === 4) {
    S.adc = c.adc;
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
  if (c.sensorTags && typeof c.sensorTags === "object") {
    for (const ch of SENSOR_CHS) {
      if (typeof c.sensorTags[ch] === "string") S.sensorTags[ch] = c.sensorTags[ch];
    }
  }
  if (c.legendMode === "top" || c.legendMode === "end") S.legendMode = c.legendMode;
  renderSensorBox();
}

/* ---------------- 啟動 ---------------- */
initCharts();
loadSettings();
bindEvents();
applyLegendMode();
drawTimer();
if (!("serial" in navigator)) {
  log("提醒：此瀏覽器不支援 Web Serial API，請使用 Chrome / Edge 開啟本頁。");
} else {
  const instName = S.instrument === "keithley" ? "Keithley 2400"
    : S.instrument === "agilent" ? "Agilent 34401A" : "ESP32";
  log(`就緒。目前儀器為 ${instName}，按下「${$("btnConnect").textContent}」即可開始量測。`);
}

/* Canvas 圖表渲染：即時跟隨、滾輪縮放 X／Y 軸、拖曳平移、多通道、每通道固定色＋NO PASS 變灰 */
"use strict";

class LineChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.defaultWindowSec = opts.windowSec || 600; // 預設 X 視窗：10 分鐘
    this.windowSec = this.defaultWindowSec;      // 目前 X 視窗長度（滾輪可縮放 60 秒–4 小時）
    this.retentionSec = 14400;                   // 資料保留 4 小時，供 X 縮放／平移回看
    this.tEnd = null;                            // X 右緣：null＝跟隨即時，否則為凍結的絕對時間
    this._nowT = 0;                              // 最近一次 draw 的即時時間（供平移夾制用）
    this.padL = 56; this.padR = 12; this.padT = 12; this.padB = 26;
    this.series = new Map();                     // name -> {color, values: [[t,v],...]}
    this.pageSet = null;                          // 主圖分頁：null＝全部，否則只畫集合內的通道
    this.yZoom = null;                           // 手動 Y 軸範圍 {min, max}，null＝自動
    this.hidden = new Set();                     // 主圖隱藏的通道（通道卡徽章關掉的）
    this.drag = null;                            // 拖曳平移起點（X＋Y 一起移）
    this._auto = null;                           // 上次自動算出的顯示範圍（含 padding）
    this._last = null;                           // 上次 draw 參數，供縮放重繪用
    this.cv.style.touchAction = "none";
    this.bindEvents();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // 游標所在區：y＝左側 Y 軸條、x＝下方 X 軸條、plot＝圖面、null＝其他邊角
  zone(x, y) {
    const pw = this.w - this.padL - this.padR, ph = this.h - this.padT - this.padB;
    if (pw <= 0 || ph <= 0) return null;
    const inPlotX = x >= this.padL && x <= this.padL + pw;
    const inPlotY = y >= this.padT && y <= this.padT + ph;
    if (inPlotX && inPlotY) return "plot";
    if (x < this.padL && inPlotY) return "y";
    if (y > this.padT + ph && inPlotX) return "x";
    return null;
  }

  zoomY(fy, factor) {
    let vMin, vMax;
    if (this.yZoom) { vMin = this.yZoom.min; vMax = this.yZoom.max; }
    else if (this._auto) { vMin = this._auto.min; vMax = this._auto.max; }
    else return;
    const anchorV = vMin + fy * (vMax - vMin);
    const autoRange = this._auto ? (this._auto.max - this._auto.min) : (vMax - vMin);
    let range = (vMax - vMin) * factor;
    range = Math.min(Math.max(range, autoRange * 0.01), autoRange * 100);
    this.yZoom = { min: anchorV - fy * range, max: anchorV + (1 - fy) * range };
  }

  zoomX(fx, factor) {
    const newView = Math.min(Math.max(this.windowSec * factor, 60), this.retentionSec);
    if (this.tEnd !== null) {
      const anchorT = (this.tEnd - this.windowSec) + fx * this.windowSec;
      this.tEnd = anchorT + (1 - fx) * newView;
      if (this.tEnd > this._nowT) this.tEnd = this._nowT; // 不得看到未來
    }
    this.windowSec = newView;
  }

  bindEvents() {
    const cv = this.cv;
    // 滾輪縮放只在軸條上：Y 軸條→Y、X 軸條→X；圖面與邊角不管，頁面照常捲動
    // 以游標處為錨點，往上滾放大、往下滾縮小；跟隨即時時 X 只改視窗長度
    cv.addEventListener("wheel", e => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - (r.left || 0), y = e.clientY - (r.top || 0);
      const z = this.zone(x, y);
      if (z !== "x" && z !== "y") return;
      e.preventDefault();
      const pw = this.w - this.padL - this.padR, ph = this.h - this.padT - this.padB;
      const fx = Math.min(Math.max((x - this.padL) / pw, 0), 1);
      const fy = Math.min(Math.max((this.padT + ph - y) / ph, 0), 1);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      if (z === "y") this.zoomY(fy, factor);
      if (z === "x") this.zoomX(fx, factor);
      this.redraw();
    }, { passive: false });
    // 雙擊：Y 回到自動刻度、X 回到即時跟隨＋預設視窗
    cv.addEventListener("dblclick", () => {
      this.yZoom = null; this.tEnd = null; this.windowSec = this.defaultWindowSec;
      this.redraw();
    });
    // 拖曳平移只在軸條上：Y 軸條上下移 Y、X 軸條左右移時間（第一次水平拖就脫離即時跟隨）；
    // 圖面本身不做移動（圖面上按住拖曳無效）
    cv.addEventListener("pointerdown", e => {
      if (!this._last) return; // 尚未有資料時間，不啟動拖曳
      const r = cv.getBoundingClientRect();
      const x = e.clientX - (r.left || 0), y = e.clientY - (r.top || 0);
      const z = this.zone(x, y);
      if (z !== "x" && z !== "y") return;
      const base = this.yZoom || this._auto;
      this.drag = { axis: z, startX: x, startY: y,
        tEnd0: this.tEnd !== null ? this.tEnd : this._nowT,
        yMin: base ? base.min : 0, yMax: base ? base.max : 1 };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      cv.style.cursor = "grabbing";
    });
    cv.addEventListener("pointermove", e => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - (r.left || 0), y = e.clientY - (r.top || 0);
      if (!this.drag) {
        // 未拖曳時以游標形狀提示軸條可操作
        const z = this.zone(x, y);
        cv.style.cursor = z === "y" ? "ns-resize" : (z === "x" ? "ew-resize" : "");
        return;
      }
      const pw = this.w - this.padL - this.padR, ph = this.h - this.padT - this.padB;
      if (pw <= 0 || ph <= 0) return;
      if (this.drag.axis === "x") {
        const dx = x - this.drag.startX;
        if (dx !== 0) {
          this.tEnd = this.drag.tEnd0 - (dx / pw) * this.windowSec;
          if (this.tEnd > this._nowT) this.tEnd = this._nowT; // 不得看到未來
        }
      } else {
        const dy = y - this.drag.startY;
        const shift = dy / ph * (this.drag.yMax - this.drag.yMin);
        this.yZoom = { min: this.drag.yMin + shift, max: this.drag.yMax + shift };
      }
      this.redraw();
    });
    const endDrag = () => { if (this.drag) { this.drag = null; cv.style.cursor = ""; } };
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
  }

  redraw() {
    if (!this._last) { this.draw(); return; }
    this.draw(this._last.nowT, this._last.yLabel, this._last.colorFn);
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, r.width); this.h = Math.max(50, r.height || 300);
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  setSeries(name, color) {
    if (!this.series.has(name)) this.series.set(name, { color, values: [] });
    else this.series.get(name).color = color;
  }

  // 線標磚開關：關掉只隱藏主圖的線，不影響記錄與通道卡
  setVisible(name, on) { if (on) this.hidden.delete(name); else this.hidden.add(name); }
  isVisible(name) { return !this.hidden.has(name); }
  resetVisible() { this.hidden.clear(); }

  push(name, t, v) {
    const s = this.series.get(name);
    if (!s) return;
    s.values.push([t, v]);
    const cutoff = t - this.retentionSec; // 保留 4 小時，不以目前視窗長度修剪
    while (s.values.length && s.values[0][0] < cutoff) s.values.shift();
    if (s.values.length > 15000) s.values.splice(0, s.values.length - 15000);
  }

  clear() {
    this.series.clear();
    this.yZoom = null; this.tEnd = null; this.windowSec = this.defaultWindowSec;
    this.draw();
  }

  /* value -> 顏色：光譜（藍→紅），超出範圍回傳 null（畫灰色） */
  static spectrumColor(v, min, max) {
    if (!(v >= min && v <= max) || max <= min) return null;
    const r = (v - min) / (max - min);
    // 藍(240°) -> 紅(0°)
    const hue = Math.round(240 * (1 - r));
    return `hsl(${hue}, 85%, 55%)`;
  }

  draw(nowT, yLabel, colorFn) {
    const ctx = this.ctx, W = this.w, H = this.h;
    ctx.clearRect(0, 0, W, H);
    // 整塊畫布先填深底，避免透明底被瀏覽器/外掛亂解讀
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, W, H);
    const pw = W - this.padL - this.padR, ph = H - this.padT - this.padB;
    if (pw <= 0 || ph <= 0) return;

    if (Number.isFinite(nowT)) { this._last = { nowT, yLabel, colorFn }; this._nowT = nowT; }
    else if (this._last) { nowT = this._last.nowT; yLabel = this._last.yLabel; colorFn = this._last.colorFn; }

    // 收集可見範圍與 Y 極值（跟隨即時時右緣＝現在，拖曳／縮放脫離後右緣凍結；隱藏的通道不參與）
    let tMax = this.tEnd !== null ? this.tEnd : (nowT || 0), vMin = Infinity, vMax = -Infinity, hasData = false;
    for (const [name, s] of this.series) {
      if (this.hidden.has(name)) continue;
      if (this.pageSet && !this.pageSet.has(name)) continue;
      for (const [t, v] of s.values) {
        if (t < tMax - this.windowSec) continue;
        hasData = true;
        if (Number.isFinite(v)) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); }
      }
    }
    const tMin = tMax - this.windowSec;

    // 背景與格線
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(this.padL, this.padT, pw, ph);
    ctx.strokeStyle = "#1e293b"; ctx.lineWidth = 1;
    ctx.fillStyle = "#64748b"; ctx.font = "11px Consolas, monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";

    const anyVisible = [...this.series.keys()].some(n => !this.hidden.has(n) && (!this.pageSet || this.pageSet.has(n)));
    if (!hasData && (this.series.size === 0 || anyVisible)) {
      ctx.textAlign = "center";
      ctx.fillText("等待資料…", this.padL + pw / 2, this.padT + ph / 2);
      return;
    }
    if (!hasData) { vMin = 0; vMax = 1; } // 全部通道都關掉時畫空圖區，不顯示等待資料
    if (!(vMax > vMin)) { vMax = vMin + 1; }
    const pad = (vMax - vMin) * 0.08 || 1;
    vMin -= pad; vMax += pad;
    this._auto = { min: vMin, max: vMax };
    // 手動 Y 軸縮放時用手動範圍取代自動範圍
    if (this.yZoom && this.yZoom.max > this.yZoom.min) { vMin = this.yZoom.min; vMax = this.yZoom.max; }

    const X = t => this.padL + ((t - tMin) / this.windowSec) * pw;
    const Y = v => this.padT + ph - ((v - vMin) / (vMax - vMin)) * ph;

    // Y 格線 + 標籤
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(this.padL, y); ctx.lineTo(this.padL + pw, y); ctx.stroke();
      ctx.fillText(v >= 100 ? v.toFixed(0) : v.toFixed(2), this.padL - 6, y);
    }
    // X 時間標籤（間隔隨視窗長度自適應，約 6–8 個標籤）
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const step = [10, 30, 60, 120, 300, 600, 1800, 3600].find(s => this.windowSec / s <= 8) || 3600;
    const firstTick = Math.ceil(tMin / step) * step;
    for (let t = firstTick; t <= tMax; t += step) {
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      ctx.fillText(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`, X(t), this.padT + ph + 6);
    }
    if (yLabel) { ctx.textAlign = "left"; ctx.fillText(yLabel, this.padL, 6); }

    // 曲線（每通道固定色，判定 NO PASS 的線段變灰；手動縮放時超出範圍的線段裁在圖區內）
    ctx.save();
    ctx.beginPath(); ctx.rect(this.padL, this.padT, pw, ph); ctx.clip();
    ctx.lineWidth = 1.6;
    for (const [name, s] of this.series) {
      if (this.hidden.has(name)) continue;
      if (this.pageSet && !this.pageSet.has(name)) continue;
      const pts = s.values.filter(([t]) => t >= tMin);
      for (let i = 1; i < pts.length; i++) {
        const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
        let c = s.color;
        if (colorFn) c = colorFn(name, (v0 + v1) / 2) || "#64748b";
        ctx.strokeStyle = c;
        ctx.beginPath(); ctx.moveTo(X(t0), Y(v0)); ctx.lineTo(X(t1), Y(v1)); ctx.stroke();
      }
    }
    ctx.restore();
    // 脫離即時跟隨時提示（雙擊回到即時）
    if (this.tEnd !== null) {
      ctx.textAlign = "right"; ctx.textBaseline = "top";
      ctx.fillStyle = "#fbbf24"; ctx.font = "11px Consolas, monospace";
      ctx.fillText("已脫離即時跟隨，雙擊回到即時", this.padL + pw - 4, this.padT + 4);
    }
  }
}

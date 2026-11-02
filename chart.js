/* Canvas 圖表渲染：可互動（懸停數值、滾輪縮放、拖曳平移、回到即時）、多通道、PASS 光譜著色 */
"use strict";

class LineChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.windowSec = opts.windowSec || 600;      // 預設 10 分鐘（即時跟隨時的視窗）
    this.padL = 56; this.padR = 12; this.padT = 12; this.padB = 26;
    this.series = new Map();                     // name -> {color, values: [[t,v],...]}
    // 互動狀態：follow=true 時右緣跟著最新資料；平移／縮放後脫離跟隨要靠回到即時鈕或雙擊
    this.follow = true;
    this.viewSec = this.windowSec;
    this.tEnd = null;                            // 非跟隨時的視窗右緣
    this.retentionSec = 14400;                   // 資料保留 4 小時，縮放才看得到更早的資料
    this.hover = null;                           // {x, y} CSS px
    this.drag = null;                            // {startX, startTEnd}
    this.liveBtn = opts.liveBtn || null;
    this._last = null;                           // 上次 draw 參數，供懸停重繪用
    this.cv.style.cursor = "crosshair";
    this.cv.style.touchAction = "none";
    this.bindEvents();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  bindEvents() {
    const cv = this.cv;
    cv.addEventListener("pointerdown", e => {
      const r = cv.getBoundingClientRect();
      this.drag = { startX: e.clientX - (r.left || 0), startTEnd: this.tEnd };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      cv.style.cursor = "grabbing";
    });
    cv.addEventListener("pointermove", e => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - (r.left || 0), y = e.clientY - (r.top || 0);
      if (this.drag) {
        const pw = this.w - this.padL - this.padR;
        if (pw > 0 && this.lastT() > 0) {
          // 拖曳即脫離即時跟隨；右緣不超過最新資料
          const dt = (this.drag.startX - x) / pw * this.viewSec;
          this.follow = false;
          this.tEnd = Math.min(this.drag.startTEnd + dt, this.lastT());
          this.updateLiveBtn();
        }
      } else {
        this.hover = { x, y };
      }
      this.redraw();
    });
    const endDrag = e => {
      if (this.drag) { this.drag = null; this.cv.style.cursor = "crosshair"; }
      if (e.type === "pointerleave") { this.hover = null; this.redraw(); }
    };
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    cv.addEventListener("pointerleave", endDrag);
    cv.addEventListener("dblclick", () => this.backToLive());
    cv.addEventListener("wheel", e => {
      e.preventDefault();
      const pw = this.w - this.padL - this.padR;
      if (pw <= 0) return;
      const f = Math.min(Math.max((this.hover ? this.hover.x : pw / 2) - this.padL, 0), pw) / pw;
      const newSec = Math.min(Math.max(this.viewSec * (e.deltaY > 0 ? 1.25 : 0.8), 60), this.retentionSec);
      if (this.follow) {
        // 即時跟隨時只改視窗寬度，右緣仍跟著最新資料
        this.viewSec = newSec;
      } else {
        // 非跟隨時以游標處時間為錨點縮放
        const tStart = this.tEnd - this.viewSec;
        const anchorT = tStart + f * this.viewSec;
        this.viewSec = newSec;
        this.tEnd = Math.min(anchorT + (1 - f) * newSec, this.lastT());
      }
      this.redraw();
    }, { passive: false });
  }

  lastT() {
    let m = 0;
    for (const [, s] of this.series) {
      const v = s.values;
      if (v.length && v[v.length - 1][0] > m) m = v[v.length - 1][0];
    }
    return m;
  }

  updateLiveBtn() { if (this.liveBtn) this.liveBtn.hidden = this.follow; }

  backToLive() {
    this.follow = true;
    this.viewSec = this.windowSec;
    this.hover = null;
    this.updateLiveBtn();
    this.redraw();
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

  push(name, t, v) {
    const s = this.series.get(name);
    if (!s) return;
    s.values.push([t, v]);
    const cutoff = t - this.retentionSec;
    while (s.values.length && s.values[0][0] < cutoff) s.values.shift();
    if (s.values.length > this.retentionSec) s.values.splice(0, s.values.length - this.retentionSec);
  }

  clear() {
    this.series.clear();
    this.follow = true; this.viewSec = this.windowSec; this.tEnd = null; this.hover = null;
    this.updateLiveBtn();
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

    if (Number.isFinite(nowT)) this._last = { nowT, yLabel, colorFn };
    else if (this._last) { nowT = this._last.nowT; yLabel = this._last.yLabel; colorFn = this._last.colorFn; }
    // 視窗：跟隨時右緣＝最新時間，否則用平移／縮放後的位置
    const tEnd = this.follow ? (Number.isFinite(nowT) ? nowT : (this.tEnd ?? this.lastT())) : (this.tEnd ?? (Number.isFinite(nowT) ? nowT : this.lastT()));
    this.tEnd = tEnd;
    const tStart = tEnd - this.viewSec;
    this.updateLiveBtn();

    // 收集可見範圍與 Y 極值
    let vMin = Infinity, vMax = -Infinity, hasData = false;
    for (const [, s] of this.series) {
      for (const [t, v] of s.values) {
        if (t < tStart || t > tEnd) continue;
        hasData = true;
        if (Number.isFinite(v)) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); }
      }
    }

    // 背景與格線
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(this.padL, this.padT, pw, ph);
    ctx.strokeStyle = "#1e293b"; ctx.lineWidth = 1;
    ctx.fillStyle = "#64748b"; ctx.font = "11px Consolas, monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";

    if (!hasData) {
      ctx.textAlign = "center";
      ctx.fillText("等待資料…", this.padL + pw / 2, this.padT + ph / 2);
      return;
    }
    if (!(vMax > vMin)) { vMax = vMin + 1; }
    const pad = (vMax - vMin) * 0.08 || 1;
    vMin -= pad; vMax += pad;

    const X = t => this.padL + ((t - tStart) / this.viewSec) * pw;
    const Y = v => this.padT + ph - ((v - vMin) / (vMax - vMin)) * ph;

    // Y 格線 + 標籤
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(this.padL, y); ctx.lineTo(this.padL + pw, y); ctx.stroke();
      ctx.fillText(v >= 100 ? v.toFixed(0) : v.toFixed(2), this.padL - 6, y);
    }
    // X 時間標籤：依視窗寬度選間隔，標籤間距約 70px 以上
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const step = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find(s => s / this.viewSec * pw >= 70) || 3600;
    const firstTick = Math.ceil(tStart / step) * step;
    for (let t = firstTick; t <= tEnd; t += step) {
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      ctx.fillText(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`, X(t), this.padT + ph + 6);
    }
    if (yLabel) { ctx.textAlign = "left"; ctx.fillText(yLabel, this.padL, 6); }

    // 曲線（逐段著色，null -> 灰色）
    ctx.lineWidth = 1.6;
    for (const [, s] of this.series) {
      const pts = s.values.filter(([t]) => t >= tStart && t <= tEnd);
      for (let i = 1; i < pts.length; i++) {
        const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
        let c = s.color;
        if (colorFn) c = colorFn((v0 + v1) / 2) || "#64748b";
        ctx.strokeStyle = c;
        ctx.beginPath(); ctx.moveTo(X(t0), Y(v0)); ctx.lineTo(X(t1), Y(v1)); ctx.stroke();
      }
    }

    // 懸停十字線＋數值
    if (this.hover) this.drawHover(tStart, X, Y, pw, ph, colorFn);
  }

  fmtT(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`; }
  fmtV(v) { const a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(2) : v.toFixed(3); }

  nearest(pts, t) { // pts 依時間遞增，二分搜最接近者
    if (!pts.length) return null;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid + 1; else hi = mid; }
    let best = pts[lo];
    if (lo > 0 && Math.abs(pts[lo - 1][0] - t) < Math.abs(best[0] - t)) best = pts[lo - 1];
    return best;
  }

  drawHover(tStart, X, Y, pw, ph, colorFn) {
    const ctx = this.ctx, h = this.hover;
    if (h.x < this.padL || h.x > this.padL + pw || h.y < this.padT || h.y > this.padT + ph) return;
    const hoverT = tStart + (h.x - this.padL) / pw * this.viewSec;
    ctx.save();
    ctx.strokeStyle = "#475569"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(h.x, this.padT); ctx.lineTo(h.x, this.padT + ph); ctx.stroke();
    ctx.setLineDash([]);
    const lines = [[this.fmtT(hoverT), "#e2e8f0"]];
    for (const [name, s] of this.series) {
      const pts = s.values.filter(([t]) => t >= tStart && t <= this.tEnd);
      const p = this.nearest(pts, hoverT);
      if (!p) continue;
      const c = colorFn ? (colorFn(p[1]) || "#64748b") : s.color;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 3.5, 0, Math.PI * 2); ctx.fill();
      lines.push([`${name} ${this.fmtV(p[1])}`, c]);
    }
    // 提示框：跟著游標，靠右緣時翻到左邊
    ctx.font = "11px Consolas, monospace";
    const tw = Math.max(...lines.map(([txt]) => ctx.measureText(txt).width)) + 14;
    const th = lines.length * 15 + 10;
    let bx = h.x + 12, by = this.padT + 8;
    if (bx + tw > this.padL + pw) bx = h.x - tw - 12;
    if (by + th > this.padT + ph) by = this.padT + ph - th;
    ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
    ctx.fillRect(bx, by, tw, th);
    ctx.strokeStyle = "#334155"; ctx.strokeRect(bx, by, tw, th);
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    lines.forEach(([txt, c], i) => { ctx.fillStyle = c; ctx.fillText(txt, bx + 7, by + 10 + i * 15); });
    ctx.restore();
  }
}

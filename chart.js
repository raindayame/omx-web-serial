/* Canvas 圖表渲染：10 分鐘滑動視窗、多通道、PASS 光譜著色 */
"use strict";

class LineChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.windowSec = opts.windowSec || 600;      // 10 分鐘
    this.padL = 56; this.padR = 12; this.padT = 12; this.padB = 26;
    this.series = new Map();                     // name -> {color, values: [[t,v],...]}
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, r.width); this.h = Math.max(50, r.height || 300);
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  setSeries(name, color) {
    if (!this.series.has(name)) this.series.set(name, { color, values: [] });
    else this.series.get(name).color = color;
  }

  push(name, t, v) {
    const s = this.series.get(name);
    if (!s) return;
    s.values.push([t, v]);
    const cutoff = t - this.windowSec;
    while (s.values.length && s.values[0][0] < cutoff) s.values.shift();
    if (s.values.length > 3600) s.values.splice(0, s.values.length - 3600);
  }

  clear() { this.series.clear(); this.draw(); }

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
    const pw = W - this.padL - this.padR, ph = H - this.padT - this.padB;
    if (pw <= 0 || ph <= 0) return;

    // 收集可見範圍與 Y 極值
    let tMax = nowT || 0, vMin = Infinity, vMax = -Infinity, hasData = false;
    for (const [, s] of this.series) {
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

    if (!hasData) {
      ctx.textAlign = "center";
      ctx.fillText("等待資料…", this.padL + pw / 2, this.padT + ph / 2);
      return;
    }
    if (!(vMax > vMin)) { vMax = vMin + 1; }
    const pad = (vMax - vMin) * 0.08 || 1;
    vMin -= pad; vMax += pad;

    const X = t => this.padL + ((t - tMin) / this.windowSec) * pw;
    const Y = v => this.padT + ph - ((v - vMin) / (vMax - vMin)) * ph;

    // Y 格線 + 標籤
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(this.padL, y); ctx.lineTo(this.padL + pw, y); ctx.stroke();
      ctx.fillText(v >= 100 ? v.toFixed(0) : v.toFixed(2), this.padL - 6, y);
    }
    // X 時間標籤（每 2 分鐘）
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const step = 120;
    const firstTick = Math.ceil(tMin / step) * step;
    for (let t = firstTick; t <= tMax; t += step) {
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      ctx.fillText(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`, X(t), this.padT + ph + 6);
    }
    if (yLabel) { ctx.textAlign = "left"; ctx.fillText(yLabel, this.padL, 6); }

    // 曲線（逐段著色，null -> 灰色）
    ctx.lineWidth = 1.6;
    for (const [, s] of this.series) {
      const pts = s.values.filter(([t]) => t >= tMin);
      for (let i = 1; i < pts.length; i++) {
        const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
        let c = s.color;
        if (colorFn) c = colorFn((v0 + v1) / 2) || "#64748b";
        ctx.strokeStyle = c;
        ctx.beginPath(); ctx.moveTo(X(t0), Y(v0)); ctx.lineTo(X(t1), Y(v1)); ctx.stroke();
      }
    }
  }
}

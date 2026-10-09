# OMX Web Serial

純前端氣體感測量測網頁 — 用 Web Serial API 直接在瀏覽器裡開 COM port 讀 ESP32，
免安裝、免後端，靜態檔案丟上 Cloudflare Pages 就能用。

## 檔案

- `index.html` — 主介面（繁體中文）
- `styles.css` — 深色儀表板風格
- `app.js` — Web Serial 連線、ESP32 協定解析、量測邏輯
- `chart.js` — Canvas 即時圖表（10 分鐘滑動視窗）
- `tools/` — 獨立資料分析工具（各為自包含單一頁面，功能互不混雜）
  - `tools/log-response-ln/` — log_response_ln 電壓－濃度統計分析
  - `tools/gas-wave-analyzer/` — Gas Wave Analyzer（R0 / Rgas / Multi-Voltage）
  - `tools/ethanol-prediction/` — 乙醇感測多電壓濃度預測

## 功能

- Web Serial 連接 COM（鮑率可選，預設 115200）
- ESP32 協定：`SELECT MOD` 自動回 `1\n`；資料行 `值+通道名 … TEMP HUMD`
- 首行自動偵測通道（16 / 32 通道：A–P、AA–PP）
- 每秒平均（平均秒數可調）、R0 自動擷取＋手動「設置 Rair」
- 電阻 / 靈敏度（R/R0）模式切換
- 通道 PASS / NO PASS 判定（電阻、靈敏度範圍可設，圖表光譜著色）
- ADC 四組校正值送出（`y{v1} {v2} {v3} {v4}\n`）
- 模組溫濕度顯示＋迷你趨勢圖
- CSV 記錄下載（自動＋手動記錄：電阻 / 靈敏度雙檔）
- 計時器、設定 localStorage 持久化

## 使用需求

- Chrome / Edge（Web Serial API），Safari / Firefox 不支援
- 頁面須經 HTTPS（或 localhost）開啟 — Cloudflare Pages 符合

## 本機測試

```bash
cd omx-web-serial
python3 -m http.server 8901
# 瀏覽器開 http://127.0.0.1:8901/
```

## 部署到 Cloudflare Pages

```bash
npx wrangler pages deploy . --project-name omx-web-serial
```

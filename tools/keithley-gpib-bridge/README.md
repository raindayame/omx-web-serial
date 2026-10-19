# Keithley 2400 GPIB 橋接

## 為什麼需要它

瀏覽器的 Web Serial API 只能看到 COM 埠。NI GPIB-USB-HS 是 NI-VISA 裝置，
不會變成 COM 埠，所以網頁無法直接跟它說話。

這支 `bridge.py` 跑在你的電腦上：經 PyVISA＋NI-VISA 驅動 GPIB，
再用 WebSocket（`ws://127.0.0.1:8765`）把 SCPI 指令／回應轉給網頁。
網頁 Keithley 模式選「GPIB 橋接」後，所有操作（Output ON/OFF、讀值、
CSV 匯出等）都跟 RS-232 直連時一模一樣。

## 安裝（只需做一次）

1. NI-VISA 驅動程式：已經裝了（原本 Qt 版就是用它走 GPIB）。
2. Python 3.9+（https://www.python.org/downloads/，安裝時勾選 Add to PATH）。
3. `pip install pyvisa websockets`

## 使用（每次量測前）

```
python bridge.py
```

看到 `[bridge] 監聽 ws://127.0.0.1:8765` 就表示好了。
開著這個視窗不要關，再到網頁按「連接 GPIB」。

## 找 GPIB 位址

- 預設 `GPIB0::24::INSTR`（Keithley 2400 出廠預設位址 24）。
- 若改過儀器位址，用 NI MAX 查，或在網頁連接前先確認。
- 也可用 `python -c "import pyvisa; print(pyvisa.ResourceManager().list_resources())"` 列出。

## 疑難排解

- 網頁顯示「連不上橋接程式」：確認 `bridge.py` 有在跑、port 8765 沒被佔用。
- `VisaIOError` / timeout：確認儀器開機、GPIB 線接好、位址正確。
- 量測中斷：先按網頁「斷開」（會安全關閉 Output），再重連即可。

@echo off
chcp 65001 >nul
:: Keithley GPIB Bridge 自訂協定註冊
:: 把這個 bat 跟 bridge.py 放同一個資料夾，執行一次即可。
:: 不需管理員權限（寫入 HKCU）。之後網頁上的「啟動橋接」按鈕就能叫起 bridge.py。
set "BRIDGE=%~dp0bridge.py"
if not exist "%BRIDGE%" (
  echo 找不到 bridge.py，請把這個 bat 跟 bridge.py 放同一個資料夾再執行。
  pause
  exit /b 1
)
where pythonw >nul 2>nul
if errorlevel 1 (
  echo 找不到 pythonw，請確認 Python 已安裝並加入 PATH。
  pause
  exit /b 1
)
for /f "delims=" %%p in ('where pythonw') do set "PYW=%%p"
reg add "HKCU\Software\Classes\keithley-bridge" /ve /d "Keithley GPIB Bridge" /f >nul
reg add "HKCU\Software\Classes\keithley-bridge" /v "URL Protocol" /f >nul
reg add "HKCU\Software\Classes\keithley-bridge\shell\open\command" /ve /d "\"%PYW%\" \"%BRIDGE%\"" /f >nul
echo.
echo 註冊完成！網頁 Keithley GPIB 模式的「啟動橋接」按鈕現在可以用了。
echo Chrome 第一次會跳出確認，勾選「一律允許」即可。
pause

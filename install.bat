@echo off
rem esp-emu-peris installer: fetches the esp-emulator browser (wasm) build
rem from https://github.com/espressif/esp-emulator/releases into vendor\.
rem Requires Python 3. Behind a firewall set the proxy env first, e.g.
rem   set https_proxy=http://127.0.0.1:10809
rem   install.bat
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
    python tools\fetch_esp_emu.py %*
    exit /b %errorlevel%
)
where python3 >nul 2>nul
if %errorlevel%==0 (
    python3 tools\fetch_esp_emu.py %*
    exit /b %errorlevel%
)
echo error: Python 3 is required (python or python3 on PATH) 1>&2
exit /b 1

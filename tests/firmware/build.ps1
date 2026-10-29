# Build helper for esp-emu-peris test firmware.
# Usage: powershell -ExecutionPolicy Bypass -NoProfile -File build.ps1 [app-dir]
# Loads the same Espressif environment as C:\Users\A\Desktop\quick\idfm.bat
# (C:\Espressif\tools\Microsoft.master.PowerShell_profile.ps1), then runs
# idf.py set-target esp32c3 + idf.py build in the app directory.
param(
    [string]$AppDir = "$PSScriptRoot\peris_probe",
    [string]$Target = "esp32c3"
)

. 'C:\Espressif\tools\Microsoft.master.PowerShell_profile.ps1' | Out-Null
$env:MSYSTEM = $null

Set-Location $AppDir
if (-not (Test-Path "sdkconfig") -or -not (Test-Path "build")) {
    idf.py set-target $Target
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
idf.py build
exit $LASTEXITCODE

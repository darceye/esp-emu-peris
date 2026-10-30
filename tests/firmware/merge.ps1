# One-off: produce the merged firmware image (bootloader + partition table
# + app) the emulator must be loaded with. Run from tests/firmware/.
# Plain `idf.py merge-bin` picks offsets and flash settings from the build.
. 'C:\Espressif\tools\Microsoft.master.PowerShell_profile.ps1' | Out-Null
$env:MSYSTEM = $null
Set-Location "$PSScriptRoot\peris_probe"
# idf.py runs esptool inside the build dir, so -o is relative to build/
idf.py merge-bin -o merged-binary.bin
exit $LASTEXITCODE

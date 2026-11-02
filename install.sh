#!/bin/sh
# esp-emu-peris installer: fetches the esp-emulator browser (wasm) build
# from https://github.com/espressif/esp-emulator/releases into vendor/.
# Requires Python 3. Behind a firewall set the usual proxy env first, e.g.
#   https_proxy=http://127.0.0.1:10809 ./install.sh
set -e
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi
exec "$PY" tools/fetch_esp_emu.py "$@"

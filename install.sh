#!/bin/sh
# esp-emu-peris installer: fetches the esp-emulator browser (wasm) build
# from https://github.com/espressif/esp-emulator/releases into vendor/.
# Requires Python 3. Behind a firewall set the usual proxy env first, e.g.
#   https_proxy=http://127.0.0.1:10809 ./install.sh
set -e
cd "$(dirname "$0")"
# "python3" may exist as a non-working Windows Store stub, so verify each
# candidate actually runs before using it.
for PY in python3 python; do
    if command -v "$PY" >/dev/null 2>&1 \
       && "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
        exec "$PY" tools/fetch_esp_emu.py "$@"
    fi
done
echo "error: Python 3.8+ is required (python3 or python on PATH)" 1>&2
exit 1

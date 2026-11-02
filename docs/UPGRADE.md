**English** | [简体中文](UPGRADE.zh-cn.md)

# Tracking upstream esp-emulator / esp-emu-browser upgrades

## Pinned baseline

Current baseline: **esp-emulator v0.51.0** (`vendor/esp-emu-browser/www/pkg`,
fetched from the GitHub release by `tools/fetch_esp_emu.py`, wasm-bindgen
`--target web`).

## Upgrade steps

1. Fetch the new wasm package:
   `python tools/fetch_esp_emu.py --version <ver>` — downloads
   `esp-emu-<ver>-wasm.tar.gz` from the espressif/esp-emulator GitHub
   release and unpacks its `www/` into `vendor/esp-emu-browser/www`
   (honours `https_proxy`; bump `DEFAULT_VERSION` in the script afterwards).
   Alternatively point `ESP_EMU_WWW=/path/to/new/www` at any unpacked copy.
2. **Run the M0 probe first**: `node tests/m0_probe.mjs <firmware path
   unchanged; run straight against the pkg>`. The probe imports the new
   `pkg/esp_emu.js` directly; if any of the six conclusions
   (Q1a/Q1b/Q2a/Q2b/Q3a/Q3b) changed, update `docs/FEASIBILITY.md` and the
   `peris/mmio/` address tables before touching other code.
3. **Diff the official worker.js**:
   `diff <new_www>/worker.js peris/worker.js`
   All our changes to that file carry `peris:` comments; port the new
   upstream logic block by block:
   - new/changed message types → sync into the worker and the page's message
     routing switch
   - run-loop changes (run_batch/throttle/restart) → keep the
     `peris.onBatchEnd()` hook after every batch
4. **Diff the official app.js / index.html**: port page features
   (terminal/chart/register/memory panels) into our UI modules and
   `esp-emu-peris.html` as needed (our files are superset replicas of
   theirs).
5. If the `WasmEmulator` API changed (new GPIO/PWM/RMT interfaces!), prefer
   the official API to simplify device implementations — that is exactly
   what the roadmap has been waiting for.
6. Manual GUI pass (firmware load, LED/button, config import/export),
   commit.

## Upstream capabilities to watch (see ROADMAP.md)

- Peripheral APIs beyond GPIO (i2c/spi device models, rmt callbacks, touch,
  adc)
- An event-callback mechanism (today it is polling only)
- UART1 / snapshot saving in the browser package

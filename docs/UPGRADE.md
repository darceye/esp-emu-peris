**English** | [简体中文](UPGRADE.zh-cn.md)

# Tracking upstream esp-emulator / esp-emu-browser upgrades

## Pinned baseline

Current baseline: **esp-emulator v0.51.0** (`_tools/esp-emu-browser/www/pkg`,
wasm-bindgen `--target web`).

## Upgrade steps

1. Download the new wasm package (e.g. `esp-emu-<ver>-wasm.tar.gz`) and
   unpack the new `www/` (`_tools` already has
   `update_esp_emu_browser.bat`, currently empty — fill it following this
   procedure).
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

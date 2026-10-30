**English** | [简体中文](README.zh-cn.md)

# esp-emu-peris

**Simulated peripherals** for the browser (wasm) build of Espressif's
[esp-emulator](https://github.com/espressif/esp-emulator): LEDs, push buttons,
touch buttons, toggle switches… — added as plugins, without touching any stock
file in the official `www/`.

```
esp-emu-peris.html      entry page (UART0 console | peripherals rows | Debug — three panes at once)
src/                    TypeScript sources (npm run build → build/)
  core/                 worker-side framework: version/types/protocol/chips/mmio/sigbus/registry/runtime/worker
  ui/                   page-side modules: app/worker-client/terminal/chart/debug-panels/peris-panel/config-editor
build/                  compiler output (tsc, not in git; core/ + ui/)
peris/
  devices/              peripheral plugins (plain JS, drop-in, each with its own version): led/button/touch-button/toggle-switch
  vendor/ peris.css     vendored xterm + panel styles
examples/               wiring-config examples (JSON, directly importable)
tests/unit/             unit tests (node:test)
tests/m1_smoke.mjs      integration smoke test (real wasm + firmware, full chain)
tests/m0_probe.mjs      emulator capability probe (run first on upstream upgrades)
tests/firmware/         ESP-IDF test firmware
docs/                   ARCHITECTURE / EMU-API / FEASIBILITY / DEVICE-API / CHANGELOG / UPGRADE / ROADMAP
AGENT.md                environment/architecture/gotchas (read before contributing)
```

Architecture, data flow, state ownership and extension points:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**; versioning rules:
**[docs/CHANGELOG.md](docs/CHANGELOG.md)** (project version synced in three
places; devices carry their own versions).

## Quick start

```bash
# one-time: npm deps (typescript installs from the npmmirror registry)
npm install

# dev loop: edit src/ → build → test → merged dev server
npm run build
npm test
npm run serve               # http://127.0.0.1:8080/esp-emu-peris.html

# open the URL above in a browser, pick a chip, drop a merged flash image (.bin)
# NOTE: it must be a full image produced by idf.py merge-bin — a bare app bin
# will not boot

# peripherals pane (right of the console): the + icon adds LEDs/buttons/etc.
# Each device is one row — the row icon is interactive (LED click changes
# colour / button press), name, GPIO box and V/G pull badge edit on click,
# ▸ expands details & advanced config, ⠿ drags to reorder. Panel head:
# project-name input + save/open icons (export/import the wiring config JSON,
# autosaved to localStorage and remembering the chip, auto-selected next time)
```

**Publish** the peripherals panel into the official www directory (add-only,
never modifies; build first):

```bash
npm run sync                 # copies the entry html + peris/ (incl. build output) + examples/
```

## Capabilities & limits (measured; details in docs/FEASIBILITY.md)

| Peripheral | Status | Approach |
|---|---|---|
| LEDs, any colour | ✅ M1 | polls the GPIO output registers |
| Push button / touch button (GPIO semantics) / toggle switch | ✅ M1 | drives pin input; firmware reads it and gets interrupts |
| PWM dimmed LED / RGB | 🔜 M2 | reads LEDC duty registers (pin-level PWM is invisible) |
| WS2812 addressable LEDs | 🔜 M3 | decodes from RMT channel RAM (pin-level waveform invisible) |
| Bit-banged I2C/SPI devices, IR | 🔜 M4 | high-rate pin sampling (requires bit-banged firmware) |
| Hardware I2C/SPI devices, displays, ADC, real touch, I2S, SD | ⏸ M5 | waiting for esp-emulator upstream APIs |

Note: the touch **peripheral** itself is not emulated — the touch button
appears as a GPIO input that firmware reads as plain GPIO
(`tests/firmware/peris_probe` has an example: GPIO3 input + falling-edge ISR).

## Adding a new peripheral

1. Drop a module into `peris/devices/` exporting `Device` and `View`
   (interface: docs/DEVICE-API.md);
2. Add one line to `peris/devices/manifest.json`. Done — page and worker pick
   it up automatically.

```js
// peris/devices/my-dev.js
export class Device {
    static typeId = 'my-dev'; static title = 'My Device'; static category = 'misc';
    static defaultConfig = { name: 'My', pin: 6 };
    static configSchema = [{ key: 'pin', label: 'GPIO pin', type: 'pin' }];
    static pins(cfg) { return [cfg.pin]; }
    constructor(ctx, cfg) { this.ctx = ctx; ctx.subscribe([cfg.pin]); }
    onPinState(pin, s) { this.on = s.oe && s.out; this.ctx.markDirty(); }
    getState() { return { on: this.on }; }
    destroy() { this.ctx.unsubscribe(); }
}
export class View {
    constructor(el, sendCmd) { el.textContent = 'hello'; }
    render(state) { }
}
```

## Test firmware & tests

```powershell
# build the firmware (IDF env from C:\Users\A\Desktop\quick\idfm.bat)
powershell -ExecutionPolicy Bypass -NoProfile -File tests\firmware\build.ps1
# merged image for loading:
#    tests/firmware/peris_probe/build/merged-binary.bin
```

```bash
npm test                     # unit + integration smoke (test layering in docs/ARCHITECTURE.md)
npm run test:m0              # emulator capability probe (run first on upstream upgrades)
```

The firmware runs a three-phase loop: GPIO8 blink / GPIO9 LEDC breathing /
GPIO4 RMT-WS2812 frames, plus GPIO3 input-interrupt counting, for end-to-end
verification.

Note: the page itself has no CDN dependency — xterm/xterm-addon-fit are
vendored into `peris/vendor/` (unminified npm builds), so it works offline.

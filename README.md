**English** | [简体中文](README.zh-cn.md)

# esp-emu-peris

**Simulated peripherals** for the browser (wasm) build of Espressif's
[esp-emulator](https://github.com/espressif/esp-emulator): LEDs, push buttons,
touch buttons, toggle switches, PWM/RGB LEDs… — added as plugins, without
touching any stock file in the official `www/`.

```
esp-emu-peris.html      entry page (UART0 console | peripherals rows | Debug — three panes at once)
src/                    TypeScript sources (npm run build → build/)
  core/                 worker-side framework: version/types/protocol/chips/mmio/sigbus/registry/runtime/worker
  ui/                   page-side modules: app/worker-client/terminal/chart/debug-panels/peris-panel/config-editor
build/                  compiler output (tsc, not in git; core/ + ui/)
peris/
  devices/              peripheral plugins (plain JS, drop-in, each with its own version):
                        led/button/touch-button/toggle-switch + pwm-led/rgb-led (register-level,
                        shared helpers in ledc-lib.js) + ws2812 (RMT channel RAM, ws2812-lib.js)
                        + bitbang-i2c-slave (24C02/BME280, i2c-lib.js) + ir-nec (NEC receiver,
                        nec-lib.js; both ride the M4 fine-batch sampling scheduler)
  vendor/ peris.css     vendored xterm + panel styles
examples/               wiring-config examples (JSON, directly importable;
                        esp32c3-probe.json wires all 11 devices to the probe
                        firmware pins — import it to test every peripheral)
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
| PWM dimmed LED / RGB LED | ✅ M2 | reads LEDC duty registers; channel→pin wiring auto-discovered from the GPIO matrix (pin-level PWM is invisible); canvas brightness interpolation for breathing effects |
| WS2812 addressable LEDs | ✅ M3 | decodes from RMT channel RAM (pin-level waveform invisible); strip/ring/matrix Views. Long strips recover only their tail — the 48-word channel RAM keeps the last 46 bits of a frame (same as real C3 hardware) |
| Bit-bang I2C slave (24C02 EEPROM, BME280) | ✅ M4 | level-driven protocol engine on two bit-banged GPIOs (SCL/SDA); answers via the SDA input path (open-drain idiom); several slaves may share one bus (wired-AND arbitration); BME280 compensation mirrored bit-exactly |
| IR NEC receiver | ✅ M4 | captures firmware codes from a bit-banged GPIO (fine-batch edge sampling) or an RMT TX channel (channel RAM); ratio-based decode (the guest clock is not wall-accurate); repeat frames included |
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
# merged image for loading (-o is relative to the build dir!):
powershell -ExecutionPolicy Bypass -NoProfile -File tests\firmware\merge.ps1
#    tests/firmware/peris_probe/build/merged-binary.bin
```

```bash
npm test                     # unit + integration smoke (test layering in docs/ARCHITECTURE.md)
npm run test:m0              # emulator capability probe (run first on upstream upgrades)
```

The firmware runs a five-phase loop: GPIO8 blink / digital-in sampling
(`###P1b`: toggle-switch level on GPIO0, touch pad on GPIO18, button level on
GPIO3, one line per 125 ms, LED mirrors the switch, touch edges counted) /
LEDC breathing on GPIO9+GPIO6+GPIO7 (ch0 ramps, ch1 mirrors down, ch2 holds
half duty) / GPIO4 RMT-WS2812 frames / a ~20 kHz soft-I2C master on
SCL=GPIO1+SDA=GPIO2 (24C02 + BME280 transactions, BME compensation
cross-checked bit-exactly) plus NEC IR codes bit-banged on GPIO5 and sent via
RMT ch1 on GPIO10 — plus GPIO3 input-interrupt counting, for end-to-end
verification. Import `examples/esp32c3-probe.json` (wires all 11 devices to
those pins) after loading the merged image to exercise every peripheral.

Note: the page itself has no CDN dependency — xterm/xterm-addon-fit are
vendored into `peris/vendor/` (unminified npm builds), so it works offline.

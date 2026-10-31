**English** | [简体中文](CHANGELOG.zh-cn.md)

# Changelog

The project version is synced in three places: `src/core/version.ts`,
`package.json`, and this file (kept in both languages — CHANGELOG.md /
CHANGELOG.zh-cn.md).
Rules: major = breaking protocol/architecture change; minor = new capability;
patch = fixes and small changes.

## peris 0.8.0 (M4)

- **Fine-grained sampling scheduler** (`src/core/scheduler.ts`): run_batch
  sizes are leased per device. An **arm lease** holds a standing ~1000
  instruction batch while a device watches an idle bus (cheap enough to
  keep, fine enough to resolve a START on buses down to ~20 kHz); a **fine
  lease** (~300 instructions) engages while a transfer is in flight so
  every CPU-driven edge survives between samples — leases expire on their
  cycle deadline or when the emulator fast-forwards through a CPU sleep
  window (nothing is sampleable there, M0). The worker's run loop and the
  smoke test both call `runtime.batchSize()`; there is no second execution
  path. New `DeviceCtx` members: `armSampling` / `fineSampling` /
  `releaseSampling` and `cyclesPerUs`.
- **Bit-bang I2C slave** (`bitbang-i2c-slave.js` v1.0.0, logic in
  `i2c-lib.js`): emulates a **24C02 EEPROM** (256 B, byte-accurate writes,
  pointer wrap, non-volatile across emulator reloads, UI preload/erase) or
  a **BME280** (chip id, factory calibration block, ctrl registers, forced
  measurements with a counter-driven fake signal, full Bosch integer
  compensation mirrored bit-exactly in JS) behind two firmware bit-banged
  GPIOs. The engine is level-driven (open-drain model: drive-low =
  out0∧oe; the slave answers on the SDA *input* path, which the master
  sees while it releases the pad — the standard soft-I2C idiom). Clock
  stretching is not modelled; push-pull masters that never release SDA
  cannot be answered (documented).
- **IR NEC receiver** (`ir-nec.js` v1.0.0, logic in `nec-lib.js`): captures
  firmware NEC codes both ways — **bit-banged 38 kHz carrier** on a GPIO
  (edges → burst envelope during fine-batch windows) and **carrier-less
  RMT symbols** (a 34-word frame fits the post-transmission 48-word
  channel RAM, so it decodes from MMIO exactly like the M3 ws2812; the
  emulator leaves `CHnSTATUS.APB_MEM_WADDR` at 0, so mid-transmission RAM
  stitching is impossible — M4 probe). The decoder is **fully
  ratio-based** (leader dominance, leader-gap 1/2 vs 1/4, bit gap/burst ≈1
  vs ≈3) because the guest clock is not wall-accurate on this emulator
  build. `source: auto` picks RMT when the pin routes to an RMT TX
  channel, gpio otherwise.
- **Shared buses**: `static sharedBus = true` devices may share pins with
  each other (two I2C slaves on one SCL/SDA pair is legal wiring). The
  runtime resolves shared-pad input drives as a **wired-AND** (any pull-low
  wins) — without it, two slave engines clobber each other's ACKs (a real
  M4 bug: the ignored-address slave released SDA over the addressed
  slave's ACK). Non-shared devices still conflict per the v1 rule; the
  page's pin-option builder is candidate-aware.
- **Test firmware P4**: a ~20 kHz soft-I2C master (open-drain idiom) runs
  EEPROM write/read-back/pointer-wrap, BME280 id/calibration/forced-measure
  loops, and NEC codes go out twice (bit-bang GPIO5 incl. a repeat frame;
  RMT ch1 on GPIO10 at 1 MHz). The firmware prints raw adc values **and**
  its C-side Bosch compensation; the smoke test asserts bit-exact parity
  with the JS model — which caught two real bugs: `dig_P1` must be
  **uint16** (36477 silently wraps negative in int16) and the NEC inverse
  byte needs `& 0xFF`.
- Tests: `tests/unit/protocol.test.mjs` (26 cases — scheduler policy,
  engine state machine against a synthetic open-drain master, register
  models, compensation pins, NEC decode incl. carrier envelopes and RMT
  words, device-level fake-MMIO paths, sharedBus rule); smoke S10/S11 on
  real firmware. All loops are now **marker-bounded** (armed batches
  fast-forward ~680k cycles each, so batch-count windows overshoot whole
  rounds) and state sampling uses forced flushes (no wall-clock jitter).
- Docs: FEASIBILITY gained the M4 measurements (guest-clock distortion,
  fast-forward rates, input-pulse cadence, WADDR=0); DEVICE-API documents
  the sampling leases and sharedBus; ROADMAP M4 → shipped.

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |

## peris 0.7.0 (M3)

- **WS2812 Strip** (`ws2812.js` v1.0.0): an addressable LED strip on one RMT
  TX channel. Frames are decoded from the RMT channel RAM after every batch
  (the M0 Q3b path; the pad-level waveform never reaches the GPIO registers).
  The M3 probe pinned the RAM layout the decoder builds on: the copy encoder
  emits **one RMT word per WS2812 bit**, words wrap every 48, and after a
  transmission the RAM holds the reset symbol, an all-zero transmit
  terminator and **only the last 46 bits of the frame** — so for strips
  longer than ~2 LEDs only the tail LEDs are recoverable (the same limit as
  real C3 hardware; the View draws unrecoverable LEDs as hollow placeholders
  and the caption shows `visible/total`). Frame boundaries resync on the
  reset symbol (low ≥ 30 µs) and the LED byte grid is realigned by
  prepending the lost leading bits (measured: 2 for 8-LED frames).
- **Auto/manual RMT channel binding**: the channel is discovered from the
  GPIO-matrix routing (`RMT_SIG_OUT0/1` = 51/52 on C3; ch2/3 are RX-only and
  not offered) and followed across firmware rewirings, or picked manually —
  same semantics as the M2 LEDC devices, reusing `ledc-lib`'s
  `parseChannel`/rescan cadence.
- **TX-busy gate**: `CHnSTATUS` bits[11:9] (RMT state machine, 1 = sending)
  is readable in the emulator; while a transmission is in flight the device
  skips decoding, so half-overwritten RAM windows are never latched (on an
  emulator without STATUS it degrades to latest-snapshot-wins).
- **Strip / ring / matrix Views** with GRB/RGB order, brightness cap and
  gamma configurable; frame transitions interpolate on canvas like the M2
  bulbs (the `ledc-lib` animator drives the details canvas and the row icon
  through one paint path). Shared decode/geometry/painting logic lives in
  `peris/devices/ws2812-lib.js` (outside the manifest, imported by the
  plugin and the unit tests).
- C3 MMIO table: the RMT section gained `ch(n)` (channel RAM + STATUS
  addresses), channel counts and the `rmtCh1` signal id; the unused
  `ch0conf0`/`ch1conf0` fields were dropped.
- Test firmware: P3 gained a trailing non-uniform "grad" burst (all red,
  n-2 green, n-1 blue) that pins per-LED tail alignment — a decoder that
  realigns correctly must read the last LED pure blue and the second-to-last
  green with G=0x3f (its two high G bits are lost to the RAM wrap).
- Tests: unit tests against synthetic channel RAM built with the measured
  write model (single-LED full decode, 8-LED 46-bit tail, grad alignment,
  no-reset/terminator guards, STATUS busy gate, auto/manual binding, count
  trim, layouts, cap/gamma math); integration smoke S9 on real firmware
  (auto-binding ch0→GPIO4, the colour walk, the grad alignment). All six M0
  conclusions re-verified after the firmware change.
- Docs: ROADMAP M3 → shipped; FEASIBILITY gained the measured RMT RAM/STATUS
  details; DEVICE-API examples list the new plugin/lib; README capability
  table updated.

## peris 0.6.0 (M2)

- **PWM LED** (`pwm-led.js` v1.0.0): an LED dimmed by one LEDC channel. The
  duty is read from the LEDC `DUTY_R` register after every batch — exact
  values, no aliasing (the M0 Q2b path; pad-level PWM never reaches the
  GPIO registers). The channel is auto-discovered from the GPIO-matrix
  routing (`GPIO_FUNCn_OUT_SEL_CFG`) and followed across firmware
  rewirings, or picked manually; the caption shows the live
  `LEDC ch → GPIO` wiring.
- **RGB LED** (`rgb-led.js` v1.0.0): three diodes on three LEDC channels.
  Auto mode maps the lowest routed channels to R/G/B in order (typical
  firmware wiring ch0/ch1/ch2); manually set colours are excluded from the
  auto assignment. The View mixes the three channels additively on a
  canvas, like real diodes.
- **Smooth breathing rendering**: state pushes arrive at only ~30fps, so
  both new Views interpolate brightness on a canvas — one rAF animator per
  plugin repaints the details bulb **and** the row icon through a single
  `_apply` path (AGENT §3.8), easing with an exponential time constant.
- **Device API v1 additions** (backwards compatible): optional
  `Device.onBatch()` tick after every `run_batch` (the hook for
  MMIO-polling devices — their signals never appear as pin changes), and
  `ctx.mmio` (the chip's register address tables resolved via
  `mmioFor(chip)`, or null when the chip has no table yet). The C3 table
  gained the LEDC timer config addresses and the complete LEDC ch0–5
  GPIO-matrix signal ids (45–50). Shared device-side logic lives in
  `peris/devices/ledc-lib.js` (wiring scan, duty decode, canvas/animator
  helpers) — imported relatively by both plugins and by the unit tests;
  not listed in the manifest, so it never loads as a device.
- Test firmware: the P2 phase now drives LEDC ch1 (GPIO 6, mirrored
  ramp) and ch2 (GPIO 7, constant half duty) alongside ch0; the `###P2`
  markers still describe ch0 only, so the m0 probe is unchanged (all six
  M0 conclusions re-verified). New `tests/firmware/merge.ps1` — `idf.py
  merge-bin`'s `-o` is relative to the build dir (the obvious path writes
  to `build/build/`).
- Tests: unit tests against fake MMIO (DUTY_R decode across resolutions
  and timer routing, matrix scan, auto/rebind semantics, render math);
  integration smoke S7/S8 (auto-binding on real firmware, duty tracking
  including the mirrored r+g sum). Docs: ROADMAP M2 → shipped; DEVICE-API
  `onBatch`/`ctx.mmio` + shared-lib pattern; README capability table.

## peris 0.5.1

- **Bilingual documentation**: every document now has an English version under
  the default filename and a Chinese version as `*.zh-cn.md` (README, AGENT,
  docs/*); the two cross-link in their first line for one-click switching, and
  in-document links stay within the same language. AGENT.md §7 records the
  keep-both-languages-in-sync rule.

## peris 0.5.0

- **Chip auto-selected when the cached wiring loads**: the localStorage config
  now carries `chip`; on page load the Target chip select and machine info are
  synced automatically (GPIO grid, register table and pin options follow), so
  the user does not have to pick the chip again. Unknown chip names are
  safely ignored.
- **Panel head merged**: the project-name (export file name) input moved next
  to the `PERIPHERALS` title, followed by save/open icon buttons (saves one
  toolbar row); the toolbar now holds only the add select + an icon-only Add
  button.
- Implementation notes: the PerisPanel is constructed before the GPIO
  defaults are initialised so the restored chip feeds the initial grid;
  `PerisPanelDeps` gained `selectChip(chip)`.

## peris 0.4.0

- **Configurable export file name**: a file-name input in the peripherals
  toolbar; exports use it (illegal characters stripped, a single .json suffix
  appended); empty falls back to the auto name `peris-{chip}-{date}.json`.
  The input is remembered in localStorage (`peris.exportName.v1`). Naming
  lives in the pure function `exportFileName()` (unit-tested).
- **Firmware provenance in exports**: exported JSON gains an informational
  `firmware {name, size, path?}` field (the `chip` field already existed).
  Limited by the browser security model, the full disk path is usually
  unavailable: `path` is filled only when the host exposes the non-standard
  `File.path`/`filePath` property; regular browsers get name and size only.
  Import ignores the field and never auto-loads firmware.
- Toolbar split into two rows (add row + import/export row).

## peris 0.3.1

- **Fix**: the LED row-icon colour did not follow the config (disagreed with
  the details bulb). Two root causes: the panel called `setConfig` before
  `rowIcon` (the icon element did not exist yet when the colour was applied),
  and the plugin styled the two visuals separately. The led plugin now has a
  single `setColour()` applied to both bulb and row icon, and the panel
  fixed the order: **`rowIcon` first, then `setConfig`**.
- **Fix**: after loading firmware for another chip, the details editor's GPIO
  options stayed on the old chip (the row chip was always correct). Pin-option
  building was extracted into `fillPinOptions()` as the single implementation
  (shared by the details editor and the row chip);
  `PerisPanel.refreshForChip()` detects chip changes after firmware
  load/reset-reload and rebuilds the details editors.
- **AGENT.md gained iron rule §3.8**: "same-semantic code must be reused" —
  both bugs above came from copying code and changing one copy; two bug
  records added (§4).
- `npm test`/`npm run test:unit` now pass the explicit .test.mjs file list
  (the Windows/Git Bash directory-resolution pitfall recorded in AGENT.md §1;
  the directory form fails outright with MODULE_NOT_FOUND on this machine).

## peris 0.3.0

- **Three-pane layout**: the peripherals pane became its own column between
  the UART console and Debug, the same width as Debug (360px, narrowing/
  stacking on small screens); the Peripherals/Debug tab switch was removed —
  all three panes are visible at once. The peripherals pane scrolls
  internally (toolbar stays visible); the Debug pane gained a title bar.
- **Row-based peripherals list** (photoshop-layers style): each device is one
  row — on the left the interactive icon, the name (click to rename in
  place), the GPIO-number box (click for a picker) and the V/G idle-pull
  badge (click to flip; V = pull-up to VCC, G = pull-down to GND); on the
  right the expand button, remove button and drag-sort grip. The expanded
  details (blender-style property groups) show the device widget body + the
  full config editor (one property per line); advanced features that do not
  fit the row live there.
- **View API extension** (optional, backwards compatible): `View.rowIcon(el)`
  customises the row icon; the View constructor gained a third argument
  `host.updateConfig(patch)` so Views can request config changes (e.g. the
  LED row icon's colour picker); configSchema gained `chip:'pull'` /
  `pullWhenChecked` to declare the V/G badge. Type contracts in
  `build/core/types.d.ts`.
- **Drag sorting**: dragging is armed only while the grip is held (no
  accidental drags); on release the DOM order is written back to the config
  and persisted (device set unchanged → no worker rebuild). File-drop import
  and row sorting do not interfere (distinguished by dataTransfer type).
- New unit tests: rowIcon presence on built-in plugins, `rowChips()` pin/V·G
  badge derivation (including GPIO0 and a `pullWhenChecked:'low'` case).

## peris 0.2.0

- **Architecture refactor**: framework layer moved to TypeScript
  (`src/core` + `src/ui`, tsc per-file compilation to `build/`, no bundling);
  the 1000-line app.js split into 7 UI modules; peris styles extracted into
  `peris/peris.css`; chips/MMIO/protocol constants single-sourced; build
  output centralised in `build/` (gitignored).
- **Test pyramid**: unit tests (node:test, 14 cases) + integration smoke +
  M0 probe wired into npm scripts.
- **Fix**: silently dropped last state inside the throttle window (trailing
  flush).
- **Versioning**: project version (`version.ts`/`package.json`/CHANGELOG)
  and device versions (`Device.version`, shown in the row header, validated
  by the registry).
- **Docs**: ARCHITECTURE.md (layering/data flow/state ownership), EMU-API.md
  (closed-source wasm capability summary), AGENT.md (environment pitfalls and
  conventions).
- xterm vendored locally (no CDN dependency).

## peris 0.1.0

- M0 feasibility verification (GPIO polling/input interrupts ✅; pin-level
  PWM/RMT invisible; LEDC registers and RMT RAM readable) → docs/FEASIBILITY.
- M1 peripherals framework: entry page (Peripherals/Debug tabs at the time),
  own worker (upstream replica + sampling hooks), device plugin API v1
  (manifest registration), LED/button/touch button/toggle switch, config
  import/export + localStorage, serve.py/sync_www.py, IDF test firmware and
  probes.

## Device plugin versions

| typeId | version | change |
|---|---|---|
| ws2812 | 1.0.0 | initial (M3): RMT channel-RAM frame decode with reset resync + leading-zero realignment, auto/manual channel binding, TX-busy gate, strip/ring/matrix Views with cap/gamma |
| pwm-led | 1.0.0 | initial (M2): LEDC DUTY_R duty, auto/manual channel binding, canvas brightness interpolation |
| rgb-led | 1.0.0 | initial (M2): three LEDC channels mixed additively, lowest-channel auto assignment |
| led | 1.1.1 | fix: row-icon colour disagreed with config — one `setColour` for bulb + row icon |
| button | 1.1.0 | row press icon (press/release); activeLow declared as the V/G badge |
| touch-button | 1.1.0 | row touch icon (inherits button's badge declaration) |
| toggle-switch | 1.1.0 | mini row switch (click to toggle); activeLow declared as the V/G badge |

History: led/button/touch-button/toggle-switch 1.0.0 initial versions (see the
peris 0.1.0/0.2.0 entries).

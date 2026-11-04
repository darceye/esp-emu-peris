**English** | [简体中文](CHANGELOG.zh-cn.md)

# Changelog

The project version is synced in three places: `src/core/version.ts`,
`package.json`, and this file (kept in both languages — CHANGELOG.md /
CHANGELOG.zh-cn.md).
Rules: major = breaking protocol/architecture change; minor = new capability;
patch = fixes and small changes.

## peris 0.14.2

- **seg7 canvas clipped the 8th digit** (`max7219-lib.js`): the canvas
  width formula used a per-digit stride of dw+gap while the painter
  advances dw+gap+0.2·dw (dp overhang) — the 8th digit started at x≈217
  on a 217 px canvas. `displayGeometry('seg7')` now solves
  w = 9·gap + 8·1.2·dw (unit-tested at several maxW).
- **hwspi DMA dedupe dropped re-shown content** (`max7219.js` v1.3.1):
  the GDMA content-signature check kept a global Set, so a frame whose
  content had EVER been shown before was silently dropped — duel_of_8's
  7-segment display went stale whenever the game re-showed an earlier
  screen (same score digit, the standby screen after settle). Now only
  the immediately previous chain's signature is deduped (a descriptor
  the hal left readable between polls); returning to earlier content is
  a real transaction and latches again.
- Tests: geometry fit +1 (`protocol.test.mjs`), dedupe-return +1
  (`spi.test.mjs`), and smoke S17b — a FULL duel_of_8 game on the wasm
  emulator: rounds 1..5 with the countdown ticking 10→00, the '-'
  settle screen, and the return to the standby screen (the exact
  return-to-earlier-content case), zero dropped frames over 55k+.

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |
| max7219 | 1.3.1 |
| ili9341 | 1.0.0 |
| bitbang-i2s-audio | 1.0.0 |
| logic-analyzer | 1.1.0 |

## peris 0.14.1

- **MAX7219 view decode override** (`max7219.js` v1.3.0): new config
  `segDecode` — Auto (the decode-mode register, the hardware rule, the
  default), Always Code B, or Never decode (raw segment bits). The view
  interpretation is the user's call, independent of the emulated decode
  register: firmware sending BCD codes with no-decode set (or raw glyphs
  with decode set) can still be read in the 7-segment view. One shared
  helper (`decodeDigitByte` in `max7219-lib.js`) serves the model's own
  `digitSegments` and the render path (`displayFromSnapshot` takes the
  choice; AGENT.md §3.8 — no second styling path).
- Test: `tests/unit/protocol.test.mjs` +1 (override beats the register in
  both directions, DP stays independent, 'auto' unchanged).

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |
| max7219 | 1.3.0 |
| ili9341 | 1.0.0 |
| bitbang-i2s-audio | 1.0.0 |
| logic-analyzer | 1.1.0 |

## peris 0.14.0

- **ESP32-S3 register-level support** (`src/core/mmio/s3.ts`, new table):
  every register-level device (PWM LED, WS2812/RMT, hwspi MAX7219,
  ILI9341) now has addresses for S3, not only C3. Addresses from ESP-IDF
  soc headers and verified live against the running wasm emulator
  (wiring auto-discovery, LEDC duty decode path, SPI2 + GDMA) with the
  duel_of_8 0.3.0 release — smoke S17. S3 differences encoded in the
  table: LEDC DUTY fields at bits [18:0] (dutyShift 0), RMT RMT_STATE at
  bits [24:22] (new `rmt.stateShift`, consumed by `rmtTxBusy`), 4 RMT TX
  channels, RMTMEM at base+0x800, 5 GDMA channels with OUT_LINK at
  base+0x80+0xC0·n, FSPI matrix signals 101..105/110..115. The SPI
  wiring scan's OUT_SEL mask unified to 0x1ff (9-bit S3 field; C3's
  8-bit values never collide) — same mask as the LEDC/RMT scans.
- **MAX7219 hwspi DMA capture** (`max7219.js` v1.2.0): firmware that
  initializes SPI2 with `SPI_DMA_CH_AUTO` (the spi_master default
  request, e.g. duel_of_8) never touches W0..W15 — its payload rides the
  GDMA out-descriptor chain. The device now polls the chain every armed
  batch, gates chains by MAX7219 frame shape (1..8 whole 16-bit words
  with register bytes 0x01..0x0F — other devices' DMA on the same
  channels is ignored silently) and feeds the same latch model as the
  no-DMA W window. Identical repeat frames are content-deduped (the
  latch state would not change); `dmaFeeds` counts accepted chains and
  the caption shows them. This is what made duel_of_8's 7-segment
  display (blank before) render.
- Tests: `tests/unit/spi.test.mjs` (+3: S3 wiring scan with the 9-bit
  plain-GPIO value, per-chip RMT state shift, the DMA feed/dedupe/shape
  gate) and smoke S17 (machine-local, duel_of_8 0.3.0 on S3: wiring
  MOSI 21/SCLK 13 discovered, DMA init decoded, heal frames zero-drop).

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |
| max7219 | 1.2.0 |
| ili9341 | 1.0.0 |
| bitbang-i2s-audio | 1.0.0 |
| logic-analyzer | 1.1.0 |

## peris 0.13.0

- **Bit-bang I2S audio codec** (M6 — see the evidence chain in
  docs/FEASIBILITY.md): the wasm models **no I2S peripheral at all** (zero
  `i2s` strings in the binary, no periph module, zero references to the C3
  I2S register block 0x6002D000 in any encoding — sleb128 immediates,
  LE-u32 data, hex strings; block reads return 0), so the esp_i2s driver
  cannot work. The audio path rides what IS observable: a firmware
  bit-banged soft-I2S master on four GPIOs, exactly like the M4 I2C slave.
- **`bitbang-i2s-audio.js` v1.0.0** (new): microphone + speaker codec on
  configurable BCLK/WS/DOUT/DIN pins (defaults 4/5/6/7). Decodes the
  firmware's DOUT stream (Philips framing, 16/24/32-bit slots, mono or
  stereo, MSB-first, WS-phase-aligned slot pairing; slots with lost edges
  are dropped and decoding resynchronises on the next WS edge) into PCM
  chunks carried by the throttled state channel; the View plays them
  through Web Audio (AudioBuffer scheduling at the detected rate, bounded
  backlog with drop-oldest — emulator time is compressed relative to wall
  time). The browser microphone flows the other way: getUserMedia +
  ScriptProcessor capture, linear resample to 8/16/48 kHz, Int16 chunks
  via `onCommand('mic')`; the engine answers bit-by-bit on the DIN input
  path (data changes on the falling BCLK edge — the M4 answer cadence),
  silence on underrun, drop-oldest queue cap. A 440 Hz test tone feeds
  the same path where no microphone is available. Frame rate is estimated
  from the median WS period in emulator cycles (ratio-based, M4 rule).
  `sharedBus` device — the logic analyzer may probe the wires.
- **Probe firmware P7 phase**: soft-I2S master reference (BCLK=4, WS=5,
  DOUT=6, DIN=7; paced bit loop — every edge lands in its own fine
  batch). Round 0 streams a sine table, later rounds echo the previous
  round's DIN capture (browser mic → firmware → speaker, the full loop).
- Tests: `tests/unit/i2s.test.mjs` (17 cases: engine framing/robustness/
  inject, helpers, plugin end-to-end) + smoke S16 (mic injection arrives
  in the firmware's `###P7 rx` sum/peak; the echo decodes back through
  DOUT).

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |
| max7219 | 1.1.0 |
| ili9341 | 1.0.0 |
| bitbang-i2s-audio | 1.0.0 |
| logic-analyzer | 1.1.0 |

## peris 0.12.0

- **Hardware-SPI devices** (M5, the "impossible" milestone revisited — see
  docs/SPI-M5.md): GP-SPI2 is modelled by the emulator and its TX stream is
  observable at the register level, so two device capabilities ride it.
- **MAX7219 on hardware SPI** (`max7219.js` v1.1.0): the new `bus: 'hwspi'`
  config decodes the driver's transfers straight from the SPI2 W0..W15
  staging window (one `spi_device_transmit` = one LOAD frame — the same
  register model and daisy-chain semantics as the bit-bang bus, fed through
  the same handler). Claims no pads and discovers the wiring itself
  (FSPICLK=63 / FSPID=65 / FSPICS0..5=68..73 in the GPIO-matrix scan);
  `bus: 'bitbang'` stays the default and behaves exactly as before.
- **ILI9341 SPI display** (`ili9341.js` v1.0.0, new): renders the esp_lcd /
  Arduino-style ILI9341 command stream (CASET/RASET window, RAMWR RGB565 /
  RGB666 pixels, COLMOD, MADCTL, sleep/display flags) as a canvas.
  Resolution configurable (1..480 per axis, default 320×240). Commands and
  small params come from the W window (DMA-less drivers) or the GDMA
  descriptor chain (esp_lcd, where DMA bypasses W — the D/C pad, a plain
  CPU GPIO, classifies and brackets every transaction); large pixel bursts
  are assembled from caught descriptor segments ordered by their guest
  buffer addresses, with a frame-buffer snapshot fallback. Known
  limitation, documented: pixel values can carry a one-chunk offset when a
  chunk's descriptor load completes inside a single batch (SPI-M5.md).
- **Framework**: `peris/devices/spi-lib.js` (shared: FSPI wiring discovery,
  the W-window engine with MS_DLEN lengths + teardown timeout, the GDMA
  chain walk with cached-head gap recovery); the C3 MMIO table gains a
  `spi` section (registers + GDMA outlinks). The ili9341 is a `passive`
  listener (claims no pads, like the logic analyzer).
- Firmware: P6 phase (MAX7219 register writes over hardware SPI without
  DMA + an ILI9341 command stream with a chunked 320×240 RGB565 burst over
  DMA, D/C=GPIO15). Tests: `tests/unit/spi.test.mjs` (18 cases: discovery,
  window engine, GDMA walk, ILI9341 model, the hwspi plugin end-to-end) +
  smoke S14/S15.

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |
| max7219 | 1.1.0 |
| ili9341 | 1.0.0 |
| logic-analyzer | 1.1.0 |

## peris 0.11.0

- **Logic analyzer probes anything** (`logic-analyzer.js` v1.1.0): the new
  `static passive = true` device metadata marks a pure listener — it never
  drives an input and claims no pad, so it may clamp onto ANY GPIO,
  including pads other devices own (an LED, an I2C pair, a MAX7219 bus)
  and other analyzers. The runtime's conflict check skips passive pads,
  they stay out of the wired-AND arbitration, and other devices' pin
  pickers no longer show them as "in use"; the analyzer's channel grid
  never disables a GPIO (pads owned elsewhere get a dashed "shared" hint).
- **Trigger on any GPIO** (not only analysed channels): `trigCh` (channel
  index) becomes `trigPin` (GPIO number) — the trigger pad gets its own
  subscription and need not be a channel; the window dropdown lists every
  valid GPIO. Visibility caveat, surfaced in the tooltip: a trigger fires
  only when the FIRMWARE drives the pad (gpio_state shows CPU GPIO
  writes) — pure-input pads driven by our button devices never toggle.
- **Window cap lifted**: 1 s → **1 h** of guest time (was a conservative
  guard). Dense signals still freeze earlier at the 20 000-edge buffer
  with the `buffer full` note — that is the natural limit (Saleae streams
  into host RAM, we capture into a fixed buffer); quiet signals can now
  record for minutes.
- Tests: passive sharing at the runtime level (probe onto an LED pad +
  I2C pair + second probe, no conflicts), off-channel trigger (edge lands
  in no lane, channel levels still snapshot), 1 h clamp, migrated
  trigger cases. GUI: shared chip clickable, 23 trigger options
  (Immediate + all 22 C3 GPIOs), 5000 ms window accepted.

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |
| max7219 | 1.0.0 |
| logic-analyzer | 1.1.0 |

## peris 0.10.3

- **`python serve.py` self-bootstraps**: when the default
  `vendor/esp-emu-browser/www/pkg` is missing, serve.py runs
  `tools/fetch_esp_emu.py` itself (same interpreter, honours `https_proxy`)
  and then starts serving — no separate install step. A custom `--www`
  target is never auto-fetched into; it still errors with a pointer to
  the fetch script. All "run npm run build first" hints were removed from
  error messages (misleading in the release package, which has no npm);
  `python tools/fetch_esp_emu.py` is the single canonical instruction.

## peris 0.10.2

- **Fresh-clone `npm test` no longer crashes**: the m1 smoke test (and the
  M0 probe) now skip with a clear explanation when the gitignored ESP-IDF
  firmware artifact is absent instead of dumping an ENOENT stack trace;
  an explicitly passed firmware path still hard-fails when missing.
- **Release package is runtime-only** (`tools/package_release.py`
  allowlist): exactly what `python serve.py` serves plus the installer —
  entry html, compiled `build/`, `peris/`, `examples/`, `serve.py`,
  `install.sh`/`install.bat` + `tools/fetch_esp_emu.py`, LICENSE, READMEs.
  Sources/tests/docs stay in the git repo (122 → ~60 files).
- `npm run serve` now fetches the esp-emulator browser build first
  (`preserve` hook), so it works straight after `git clone` + `npm install`.

## peris 0.10.1

- **No more machine-local absolute paths**: the esp-emulator browser (wasm)
  build is fetched on demand from the `espressif/esp-emulator` GitHub
  release into `vendor/esp-emu-browser/` by the new
  `tools/fetch_esp_emu.py` — `npm run build` / `npm test` trigger it
  automatically on first run. Proxy-aware (`https_proxy`), sha256-verified
  against the release `SHA256SUMS`, cached in `vendor/downloads/`,
  idempotent; `--version <ver>` switches the baseline (see UPGRADE.md).
  `serve.py` / `sync_www.py` / the tests default to the vendored copy
  (override with `--www` / `ESP_EMU_WWW`).
- **Release packaging**: `npm run package` (`tools/package_release.py`)
  builds `esp-emu-peris-<ver>.zip` / `.tar.gz` for the GitHub release page;
  the archives ship the UI pre-compiled plus `install.sh` / `install.bat`,
  which fetch the esp-emulator browser build — a release user needs only
  Python 3, no npm/node.

## peris 0.10.0

- **Logic analyzer** (`logic-analyzer.js` v1.0.0, logic in `la-lib.js`):
  multi-channel GPIO waveform capture for firmware-driven signals — up to
  8 arbitrary GPIOs, one trigger (channel + rising/falling/any edge, or
  Immediate), a 1–1000 ms guest-time capture window and an optional auto
  re-arm. Levels are 1/0 while driven and **Z** when the guest releases the
  pad (oe drops); times are guest µs from the cycle counter (the guest clock
  is not wall-accurate, M4). Sampling rides the M4 scheduler exactly like
  the other bit-bang devices: an `arm` lease (1000) while waiting for the
  trigger, a fine lease renewed per edge while recording (`resolution`
  preset: fine 20 = the scheduler floor / normal 100 / coarse 300); two
  flips inside one batch merge — the preset picks how fine that is. A
  probe never drives: `sharedBus` lets it tap pads other bus devices own
  (the I2C pair, a MAX7219 bus, other analyzers), and the 20 000-edge
  buffer freezes with an `overflow` flag instead of garbling.
- **Floating analyzer window**: the waveform UI is big, so it lives in a
  draggable, resizable, **non-modal** popup (`la-lib.makeFloatingWindow`,
  fixed-position, no backdrop — the page underneath keeps every pointer
  event; geometry clamped to the viewport and persisted to localStorage).
  The row icon and the expanded details show a live mini-preview of the
  same painter (`drawWaveform` — one paint path for all three sizes);
  clicking either opens the window. Channels are picked from a GPIO chip
  grid (occupied pins disabled via the new `host.pinInfo()`), trigger /
  window / resolution / label live in the config editor and the window
  toolbar.
- **Saleae-style plot interactions** (0.10.0, same release): **wheel zoom**
  anchored at the cursor (zoom floor 1 ns, clamped to the capture extent),
  **left/middle-drag pan**, **double-click / F / ⤢ zoom-to-fit**; a fresh
  capture re-fits the view and drops the cursors (`capId` in the state).
  **Hover measurement** shades the pulse under the cursor and reads out
  level · pulse width · period · frequency · **PWM duty** (cycle =
  rise→rise; computed from the visible channel, live in the measurement
  bar); the lane gutter shows each channel's level at the view's right
  edge. **A/B measurement cursors**: click twice to drop them, drag the
  lines to move, read Δt and 1/Δt frequency; ✕ clears. **Edge jumping**:
  click a lane label to select the channel, then ‹/› buttons or ←/→ keys
  pan view-centre onto the previous/next edge (zoom preserved).
- **Device API v1 additions** (backwards compatible): `ctx.pinLevel(pin)`
  — current driven level straight from `gpio_state()` (null when released;
  the LA snapshots channel levels at capture start); `ViewHost.pinInfo()`
  — valid + used pins for Views building their own multi-pin picker;
  `View.destroy()` — teardown when the row is removed or the list is
  rebuilt, so Views owning DOM outside their row (floating windows) clean
  it up; the panel calls it on remove and on `renderAll`.
- Tests: unit cases for the readout math (parsePins, levelAt, axis ticks,
  fmt, fit span, pixel transform), the full capture state machine through
  a fake ctx (immediate/triggered starts, direction filtering, Z edges,
  window end, stop/clear/auto — incl. the auto+Immediate warning — buffer
  overflow, onEmuReady reset) and `sigbus.pinLevel` against a fake
  emulator; smoke S13 arms the analyzer on the P4 soft-I2C bus (SCL 1950 /
  SDA 352 alternating edges in a 40 ms window, frozen afterwards);
  `examples/esp32c3-probe.json` now wires 12 devices.

## peris 0.9.0

- **MAX7219 Display** (`max7219.js` v1.0.0, logic in `max7219-lib.js`): the
  8-digit LED driver behind a firmware **bit-banged DIN/CLK/LOAD bus**.
  Hardware SPI wiring stays invisible to `gpio_state()` (M0), so the device
  targets soft-SPI code — from delay-paced bit-bang down to back-to-back
  `gpio_set_level` pulses. A level-driven shift engine samples DIN on the
  CLK rising edge, assembles MSB-first 16-bit words and latches a frame on
  the LOAD rising edge; misaligned frames (edges lost to sampling) are
  dropped and counted in `dropped` instead of garbling the display. The
  register model follows the datasheet: Code B decode (D3–D0, D7 = DP
  independent), intensity PWM (16 steps, (I+1)/32 duty), scan limit,
  shutdown / display test, power-on defaults (shutdown, scan 1 digit,
  minimum intensity). Views: 8×8 matrix (digit = row, D7..D0 = columns) or
  7-segment digits, auto-selected from the decode-mode register; daisy
  chains legally share the three pads (`sharedBus`) and each part latches
  the word that ended in its chain position (`chain` + `pos` config).
  Lease sizing measured against the tightest real firmware (gun 0.1.0:
  delay-free pulses, edges ~20 instructions apart, LOAD fall → first CLK
  rise ~80): fine batches at the scheduler floor (**20**), arm at **60**.
- **Smoke S12** (machine-local, skips with a notice when absent): the gun
  0.1.0 release (ESP32-S3, DIN=21/CLK=13/LOAD=14; later gun releases moved
  to hardware SPI, invisible by M0) boots in a second emulator instance —
  `display_init()`'s 14 register words decode with **zero** misalignment
  drops and the control task's value pushes follow. New example
  `examples/esp32s3-gun.json` wires the display for that firmware.

| device | version |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |
| max7219 | 1.0.0 |
| logic-analyzer | 1.0.0 |

## peris 0.8.1

- **Test firmware P1b** (digital-in sampling): every round now samples the
  toggle-switch level (GPIO0), the button level (GPIO3) and the touch pad
  (GPIO18, active-low) via `gpio_get_level()` for 2 s — one `###P1b` line
  every 125 ms — mirrors the switch on the blink LED and counts touch press
  edges. The toggle-switch and touch-button devices (plain GPIO drivers; the
  touch peripheral itself is not emulated) are now exercised by the probe
  firmware too.
- **`examples/esp32c3-probe.json` now covers every device**: the importable
  wiring config grew from 4 to 11 devices matching the firmware pins (LED,
  button, switch, touch pad, PWM LED, RGB LED, WS2812 strip, 24C02 + BME280
  on the shared I2C bus, IR NEC gpio + RMT capture). Load
  `tests/firmware/peris_probe/build/merged-binary.bin`, import the example
  and each firmware phase exercises its peripherals.
- Smoke: new S4b checks (switch level reaches the guest, touch presses
  counted, LED mirrors the switch) bounded by the `###P1b` markers; the
  smoke config carries 11 devices.

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

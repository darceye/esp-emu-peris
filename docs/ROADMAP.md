**English** | [简体中文](ROADMAP.zh-cn.md)

# Roadmap

## Logic analyzer — shipped in peris 0.10.0

- ✅ `logic-analyzer.js`: multi-channel GPIO waveform capture (up to 8
  pads, one trigger: channel + edge or Immediate, guest-time window,
  auto re-arm). Driven levels 1/0, released pads Z, times in guest µs.
  Rides the M4 scheduler (arm 1000 watch, fine lease per `resolution`
  preset: 20/100/300); 20 000-edge buffer freezes with an `overflow`
  flag. Shared logic in `peris/devices/la-lib.js`; `sharedBus` makes it a
  pure tap on other bus devices' pads.
- ✅ Floating analyzer window: draggable, resizable, non-modal popup
  (fixed position, no backdrop — the page underneath keeps working);
  geometry persisted. One `drawWaveform` painter feeds the popup, the
  details mini-preview and the row icon; channels picked from a GPIO grid
  (`host.pinInfo()` disables occupied pins). Framework: `ctx.pinLevel`,
  `ViewHost.pinInfo`, `View.destroy` (row removal/rebuild teardown).
- ✅ Saleae-style plot interactions: wheel zoom anchored at the cursor,
  drag pan, double-click/F fit; hover measurement shades the pulse and
  reads level · width · period · frequency · PWM duty; A/B cursors with
  Δt + 1/Δt; lane selection + ‹/›/←/→ edge jumping; lane gutter shows the
  right-edge level per channel.
- Tests: readout math + capture state machine units, `sigbus.pinLevel`,
  smoke S13 (P4 soft-I2C bus capture). Ideas not in v1: pre-trigger
  buffer, incremental edge streaming during a run, protocol decoders on
  top of a capture (I2C/NEC annotations) — the frozen buffer already
  carries everything a decoder needs.

## MAX7219 display — shipped in peris 0.9.0

- ✅ `max7219.js`: the 8-digit LED driver on a firmware bit-banged
  DIN/CLK/LOAD bus (hardware SPI stays invisible — M0). Level-driven shift
  engine (MSB-first, words latched on the LOAD rising edge, misaligned
  frames dropped and counted, never garbled) + datasheet register model
  (Code B decode with independent DP, intensity PWM, scan limit,
  shutdown / display test, power-on defaults). 8×8 matrix and 7-segment
  Views auto-selected from the decode-mode register; daisy chains share
  the three pads. Shared logic in `peris/devices/max7219-lib.js`.
- ✅ Real-firmware integration: smoke S12 boots the gun 0.1.0 release
  (ESP32-S3, delay-free bit-bang — edges ~20 instructions apart, the
  tightest pulses the M4 scheduler resolves: fine lease at the floor 20,
  arm 60) and decodes its `display_init()` with zero drops;
  `examples/esp32s3-gun.json` wires the display for the browser.

## M4 · Bit-bang protocol devices + IR — shipped in peris 0.8.0

- ✅ `bitbang-i2c-slave.js`: 24C02 EEPROM and BME280 models behind two
  firmware bit-banged GPIOs (SCL/SDA). Level-driven engine (open-drain
  model); the slave answers on the SDA input path, which the master sees
  while it releases the pad. Shared logic in `peris/devices/i2c-lib.js`
  (engine, register models, bit-exact Bosch compensation). Constraint
  documented: hardware I2C/SPI buses cannot be tapped (M0) and push-pull
  masters that never release SDA cannot be answered; clock stretching not
  modelled.
- ✅ `ir-nec.js`: NEC codes captured from firmware **bit-bang** transmissions
  (fine-batch edge sampling → burst envelope) and from **RMT** channels
  (a 34-word frame fits the post-TX channel RAM; the emulator leaves
  `APB_MEM_WADDR` at 0, so mid-TX stitching is out — M4 probe). Decoder is
  fully ratio-based: the guest clock runs ~50% of nominal through
  `esp_rom_delay_us` (measured), so absolute-µs windows would misjudge.
  Shared logic in `peris/devices/nec-lib.js`.
- ✅ High-rate sampling scheduler (`src/core/scheduler.ts`): per-device
  leases — a standing arm batch (~1000 instr) while the bus is idle, fine
  batches (~300 instr) while a transfer is in flight; leases expire on
  deadline or CPU-sleep fast-forward. Worker and tests share
  `runtime.batchSize()`.
- ✅ Framework: `sharedBus` device metadata (I2C slaves legally share
  SCL/SDA) with wired-AND input arbitration; `cyclesPerUs` on the device
  ctx.
- Test firmware P4 (soft-I2C master at ~20 kHz, forced BME280 measurements
  with C-side compensation cross-checked bit-exactly by the smoke test,
  NEC via both paths) + unit tests `tests/unit/protocol.test.mjs` +
  smoke S10/S11.

## M3 · WS2812 addressable LEDs — shipped in peris 0.7.0

- ✅ `ws2812.js`: polls the RMT channel RAM (M0 verified Q3b PASS),
  symbols → bitstream → GRB frames; reset-symbol resync + leading-zero
  alignment (the M3 probe refined the model: one RMT word per WS2812 bit,
  48-word wrap, a zero transmit terminator after the reset — details in
  FEASIBILITY.md). Shared logic in `peris/devices/ws2812-lib.js`.
- ✅ Strip / ring / matrix Views; GRB/RGB order, brightness cap and gamma
  configurable; smooth frame interpolation like the M2 PWM bulbs
  (reusing the `ledc-lib.js` animator).
- ✅ Known limitation, documented and surfaced in the UI: the 48-word
  channel RAM keeps only the **last 46 bits** of a frame, so strips longer
  than ~2 LEDs show only their tail (same as real C3 hardware); the View
  draws unrecoverable LEDs hollow. `CHnSTATUS` gates decoding while a
  transmission is in flight.
- Performance: JS decoding measures far below any budget (one 192-byte
  read + a 48-word compare per batch); the wasm-helper escape hatch was
  not needed. Lifting the 46-bit limit would need the M4 fine-batch
  scheduler (sampling the RAM repeatedly *during* a transmission), not
  faster decoding.

## M2 · PWM dimmed LED — shipped in peris 0.6.0

- ✅ `pwm-led.js` + `rgb-led.js`: each LEDC channel's `DUTY_R` register is
  read every batch for the exact duty cycle, no aliasing (approach verified
  in M0: Q2b PASS).
- ✅ Channel→pin mapping: `GPIO_FUNCn_OUT_SEL_CFG` (LEDC ch0–5 = 45–50)
  implements auto-discovered wiring that follows firmware rewiring; manual
  channel selection also allowed.
- ✅ Breathing effect with smooth rendering: canvas brightness
  interpolation (one rAF animator per plugin repaints bulb + row icon).
- Shared logic in `peris/devices/ledc-lib.js`; framework hooks
  `Device.onBatch()` + `ctx.mmio` (see DEVICE-API.md).

## M5 · Upstream capability tracking (not under our control)

These need APIs the wasm does not expose today; progress depends on new
esp-emulator releases (upgrade procedure in UPGRADE.md):

| capability | required upstream interface | status |
|---|---|---|
| hardware I2C device models | i2c slave/device bridge API (CLI-only `--i2c-dev`, dumb registers only) | ❌ |
| hardware SPI peripherals (SD card etc.) | spi device bridge | ❌ |
| SPI/RGB565 displays | spi/lcd_cam (the peripheral itself is not emulated) | ❌ |
| real touch peripheral | touch peripheral emulation | ❌ (touch button stands in with GPIO semantics) |
| ADC (potentiometers etc.) | adc emulation | ❌ |
| I2S audio | i2s emulation | ❌ |
| UART1 peripheral | wasm-exposed uart1 (CLI has `--uart1-tcp`) | ❌ |
| state snapshot save/restore | save/load API | ❌ |

## Maintenance items

- ~~`update_esp_emu_browser.bat`~~ — solved differently: `tools/fetch_esp_emu.py`
  downloads/unpacks any esp-emulator release (`--version <ver>`), see
  UPGRADE.md.
- `src/core/mmio/`: add the C5/C6/H2/P4/S3 address tables (extracted from each
  chip's IDF soc headers, same method as M0).

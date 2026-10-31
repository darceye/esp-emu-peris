**English** | [简体中文](ROADMAP.zh-cn.md)

# Roadmap

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

- `update_esp_emu_browser.bat` (in `_tools`, currently empty): script the
  UPGRADE.md procedure.
- `src/core/mmio/`: add the C5/C6/H2/P4/S3 address tables (extracted from each
  chip's IDF soc headers, same method as M0).

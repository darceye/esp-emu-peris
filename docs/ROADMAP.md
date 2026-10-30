**English** | [简体中文](ROADMAP.zh-cn.md)

# Roadmap

## M2 · PWM dimmed LED (next)

- `pwm-led.js` + `rgb-led.js`: read each LEDC channel's `DUTY_R` register
  (address tables in `peris/mmio/`) for exact duty cycles, no aliasing
  (approach verified in M0: Q2b PASS).
- Channel→pin mapping: read `GPIO_FUNCn_OUT_SEL_CFG` (M0 measured LEDC0 =
  0x2d, RMT0 = 0x33) to implement "auto-discovered wiring" assistance;
  manual channel/pin selection also allowed.
- Breathing effect with smooth rendering (canvas brightness interpolation).

## M3 · WS2812 addressable LEDs

- `ws2812.js`: poll the RMT channel RAM (M0 verified Q3b PASS),
  symbols → bitstream → GRB frames; ping-pong grouping + reset-symbol
  resync + leading-zero alignment (details in FEASIBILITY.md).
- Strip / ring / matrix Views; GRB/RGB order, brightness cap and gamma
  configurable.
- Performance strategy: JS decoding first; if measurements show it is not
  enough, compile the hot "sample + decode" path into a separate wasm helper
  module (C/C++) invoked from the worker (the emulator's closed-source wasm
  stays untouched, the device JS interface unchanged).

## M4 · Bit-bang protocol devices + IR

- `bitbang-i2c-slave.js` (emulating 24Cxx/BME280 etc. on SCL/SDA) and
  `ir-nec.js` (capturing firmware RMT/bit-bang transmissions).
- Prerequisite: firmware uses GPIO bit-banging (hardware I2C/SPI buses
  cannot be tapped from outside — confirmed in M0). Needs accompanying test
  firmware and documentation of this constraint.
- High-rate sampling scheduler (sigbus extension: temporary fine-batch
  windows, effective while the CPU is active).

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
- `peris/mmio/`: add the C5/C6/H2/P4/S3 address tables (extracted from each
  chip's IDF soc headers, same method as M0).

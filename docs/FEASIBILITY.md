**English** | [简体中文](FEASIBILITY.zh-cn.md)

# M0 feasibility report (esp-emu-peris)

Date: 2026-10-29 · Environment: esp-emulator browser wasm v0.51.0
(`_tools/esp-emu-browser/www/pkg`)
Firmware: ESP-IDF master (`C:\esp\master\esp-idf`, env via
`C:\Users\A\Desktop\quick\idfm.bat`)
Reproduce: `node tests/m0_probe.mjs` (the probe) + `tests/firmware/peris_probe`
(test firmware; `idf.py build && idf.py merge-bin`, then load
`build/merged-binary.bin`)

## Summary of conclusions

| # | question | result | evidence |
|---|---|---|---|
| Q1a | can firmware GPIO output be observed by polling `gpio_state()` | **PASS** | all 8 toggles visible (sampling granularity 50k instructions/batch) |
| Q1b | can `gpio_set_input()` on a pin raise the firmware's GPIO interrupt | **PASS** | probe drove 6 falling edges; firmware ISR counted 6/6 |
| Q2a | do LEDC PWM waveforms show up in the GPIO output registers (pad-level duty-cycle polling) | **FAIL** | pin oe=1 but out constantly 0; estimates stuck at 0 during duty=50%/100% |
| Q2b | can LEDC duty registers be read via `read_memory()` and do they track the setpoint | **PASS** | 53/53 samples tracked; `half(4096)→DUTY_R=0x10000=4096×16`, `max(8191)→0x1fff0` |
| Q3a | can RMT/WS2812 waveforms be sampled at pin level with small `run_batch(40)` calls | **FAIL** | out4 constant 0 across 2472 sampled batches, no level change at all |
| Q3b | can RMT channel RAM be read via `read_memory()` and decoded into WS2812 frames | **PASS** | 46 frames decoded from 93 snapshots, colours matching the firmware log 0x111111/0x222222/0x333333 |

## Decisive impact on the peripheral plans

- **LED / push button / touch button (GPIO semantics)**: directly viable —
  Q1a + Q1b fully pass.
- **PWM dimmed LED**: take the **MMIO register path** (Q2b), not pin sampling
  (Q2a proven unviable). Reading `LEDC_CHn_DUTY_R` gives the exact duty cycle
  — no aliasing, no overhead.
- **WS2812**: take the **RMT channel RAM path** (Q3b), not pin sampling (Q3a
  proven unviable). Symbols remain in RAM after transmission and can be
  decoded afterwards.
- **Bit-banged I2C/SPI/IR**: still viable — Q1a shows CPU-driven GPIO_OUT
  flips are visible; the CPU does not sleep while flipping, so the
  "time fast-forward" issue below does not apply. High-rate sampling only
  works inside CPU-active windows.

## Key technical details

### ESP32-C3 register addresses (from IDF soc headers)

| register | address | notes |
|---|---|---|
| GPIO_OUT / GPIO_ENABLE | 0x60004004 / 0x60004020 | `gpio_state()` mirrors exactly these words |
| GPIO_FUNCn_OUT_SEL_CFG | 0x60004000+0x554+4n | low 9 bits = GPIO-matrix output signal select |
| IO_MUX_GPIO0..11_REG | 0x60009000+0x04+4n | bits 10..12 MCU_SEL and other pad config |
| LEDC_CHn_(CONF0/HPOINT/DUTY/CONF1/DUTY_R) | 0x60019000+0x14n(+0/4/8/C/10) | C3 uses the LSCHn naming |
| RMT_CHnCONF0 / channel RAM (RMTMEM) | 0x60016010+8n / 0x60016400+0xC0n | 48 words (192 bytes) per channel |

### Measured behaviour highlights

1. **LEDC duty layout**: the `DUTY_CH0` field sits in bits[18:4]; register
   value = duty × 16 (same as real hardware).
2. **GPIO-matrix routing is readable**: after the firmware maps GPIO9 to
   LEDC0, `FUNC9_OUT_SEL=0x2d` (=45, LEDC_LS_CH0_SIG); after mapping GPIO4 to
   RMT, `FUNC4_OUT_SEL=0x33` (=51, RMT_SIG_0). **Auto-discovery of peripheral
   wiring** can be built on this: poll every pin's OUT_SEL + IO_MUX to learn
   which peripheral signal currently drives each pad.
3. **RMT RAM retention**: symbols are not cleared after transmission;
   48 words per channel; frames with >192 symbols use ping-pong
   (TX_THR_EVENT refill + wrap), so a snapshot may contain fragments of
   adjacent frames; frames are delimited by the reset symbol (low ≥30µs,
   i.e. d0≥300 with l0=0).
4. **Bit-grid resynchronisation**: in this test the RAM bitstream was missing
   2 head bits relative to the LED byte grid (ping-pong write order); a
   leading-zero search (0..7) re-aligns it; real device decoders must
   implement that resync.
5. **Time fast-forward**: during `vTaskDelay` the emulator does not spend
   full CPU cycles (`cycles()` can jump by thousands inside one
   `run_batch(40)`), therefore **peripheral waveforms during CPU sleep are
   not capturable at pin level** — the root cause of the Q3a failure,
   independent of sample rate.
6. **Performance** (Node 24, direct wasm calls): coarse (50k instr/batch) ≈
   **5000+ MIPS**; fine (40 instr/batch + `gpio_state()` each batch) ≈
   **99 MIPS** (~53× overhead). A browser worker is in the same ballpark —
   fine-grained sampling should only be a temporary measure inside
   CPU-active windows; standing sampling uses coarse batches + MMIO.
7. **Firmware must be a merged image** (bootloader@0x0 + partition
   table@0x8000 + app@0x10000), produced by `idf.py merge-bin`; a bare app
   bin does not boot.

## Ruled out / still limited by upstream

- Hardware I2C/SPI external device models, a real touch peripheral, ADC,
  I2S, SPI/RGB565 displays, SD cards, UART1: no wasm API — waiting on
  esp-emulator upstream (see docs/ROADMAP.md).
- Pin-level PWM/RMT waveform observation: structurally unviable
  (Q2a/Q3a), independent of sample rate.

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
| RMT_CHnSTATUS | 0x60016028+4n | bits[11:9] = channel state machine (1 = sending) — M3 |

### Measured behaviour highlights

1. **LEDC duty layout**: the `DUTY_CH0` field sits in bits[18:4]; register
   value = duty × 16 (same as real hardware).
2. **GPIO-matrix routing is readable**: after the firmware maps GPIO9 to
   LEDC0, `FUNC9_OUT_SEL=0x2d` (=45, LEDC_LS_CH0_SIG); after mapping GPIO4 to
   RMT, `FUNC4_OUT_SEL=0x33` (=51, RMT_SIG_0). **Auto-discovery of peripheral
   wiring** can be built on this: poll every pin's OUT_SEL + IO_MUX to learn
   which peripheral signal currently drives each pad. (M2 follow-up: the full
   C3 LEDC signal range ch0–5 = 45–50 was verified live — rgb-led
   auto-binding in tests/m1_smoke.mjs S8 — and the duty fraction decodes via
   conf0.TIMER_SEL → timer DUTY_RES, see peris/devices/ledc-lib.js. M3
   follow-up: RMT_SIG_OUT0/1 = 51/52 are the C3's only RMT pad signals —
   ch2/3 are RX-only, so ws2812 offers just two TX channels.)
3. **RMT RAM retention**: symbols are not cleared after transmission;
   48 words per channel. (M3 follow-up refined the model: the copy encoder
   writes **one RMT word per WS2812 bit** — d0/l0 = high run, d1/l1 = low
   run of the same bit — words land sequentially at `k mod 48` and wrap, so
   after a transmission the RAM holds exactly the reset word, **one
   all-zero transmit-terminator word**, and the **last 46 bits** of the
   frame. The reset symbol delimits a frame (low ≥30µs, i.e. d0≥300 with
   l0=0); a reset lands at word `24·L mod 48` (0 or 24), so any new frame's
   first 26 writes overwrite every possible stale reset. Consequence,
   identical to real C3 hardware: strips longer than ~2 LEDs are only
   recoverable in their tail — ⌊46/24⌋ LED slots, the oldest of them minus
   its two head bits.)
4. **Bit-grid resynchronisation**: the RAM window is the frame tail, so the
   bitstream is missing its head bits relative to the LED byte grid (the
   RAM wrap destroyed them); prepending `(24 − visible mod 24) mod 24`
   zero bits re-aligns it (M0 measured 2 lost bits for 8-LED frames; the
   per-LED "grad" burst + `tests/m1_smoke.mjs` S9 pin the exact behaviour
   on real firmware — ws2812-lib implements it in
   `decodeWs2812`). `CHnSTATUS` bits[11:9] ≠ 0 while the TX state machine
   is sending, so the M3 device skips half-overwritten windows.
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

## M4 measurements (bit-bang protocol devices + IR)

Firmware `tests/firmware/peris_probe` P4 phase, wasm v0.51.0; scripts were
scratch probes (conclusions verified by the shipped tests):

1. **Guest clock distortion through ROM delays**: `esp_rom_delay_us` advances
   emulator time at **~50% of nominal** — a "9 ms" NEC leader measures
   4.505 ms, a "13 µs" carrier half-period ~6.5 µs (exact 0.50 ratio
   everywhere; `run_batch` sizes were ruled out as the cause by tracing
   cycles between edges). Consequences: the NEC decoder is **ratio-based**
   (`nec-lib.decodeNec` — leader dominance, leader-gap ½ vs ¼, bit
   gap/burst ≈1 vs ≈3); the I2C engine is **level-based** (no timing at
   all); `vTaskDelay` sleeps keep full emulated duration (the distortion is
   in the ROM delay loop, not the sleep path).
2. **Armed-batch sleep fast-forward**: with an arm lease standing
   (~1000-instruction batches), each batch during `vTaskDelay` jumps
   **~680k cycles** — a whole firmware round (P1–P4, ~11 s emulated) passes
   in ~2.5k armed batches, while P4's CPU-active fine windows (300-instr
   batches) need ~166k batches. Batch-count test windows therefore
   overshoot entire rounds; every m1_smoke window is marker-bounded.
3. **Input pulse cadence for GPIO ISRs** (button semantics at armed sizes):
   pulses every **8 batches held 3** (~10–40 ms emulated during sleep
   fast-forward) count 4/4; press+release inside one batch gap loses the
   edge (known), and M0's instruction-count shapes (150k instr held /
   2M instr apart) no longer fit inside one P1 (~470 armed batches) — only
   ~1 of 3 counts. Emulated timing, not instruction counts, is what the
   ISR needs.
4. **`CHnSTATUS.APB_MEM_WADDR` (bits[20:12]) reads 0 always** — the
   emulator does not implement the RMT write pointer. Mid-transmission
   channel-RAM stitching is therefore impossible; post-TX RAM windows are
   the only RMT decode path (NEC fits: 34 words ≤ 46).
5. **Two I2C slaves on one bus need wired-AND input arbitration**:
   `gpio_set_input` is a level write with a single winner, so a second
   slave engine's "release" silently overwrote the addressed slave's ACK
   pull (every transaction NACKed). The runtime now resolves shared-bus
   pad drives as a wired-AND (`sharedBus` device metadata).
6. **Soft-I2C round-trip is exact** at ~20 kHz firmware clocking (25 µs
   half-period → ~12.5 µs emulated): write+sequential-read, pointer wrap,
   33-byte factory calibration, forced measurements — all `ack=0`. The
   C↔JS compensation parity check caught `dig_P1` needing **uint16**
   (36477 wraps negative in int16 — T/H matched, only P diverged, which
   is what localised it).

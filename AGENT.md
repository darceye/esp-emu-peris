**English** | [简体中文](AGENT.zh-cn.md)

# AGENT.md — required reading for follow-up agents (gotchas & conventions)

This file captures every environment pitfall, architecture rule and
verification method learned so far. **Read it fully before touching anything.**
(Chinese version: AGENT.zh-cn.md — keep both in sync, see §7.)

## 0. Quick start

```bash
npm install                # typescript via npmmirror (see §1)
npm run build              # prebuild fetches the esp-emulator browser build into
                           # vendor/esp-emu-browser/ on first run, then tsc: src/ → build/
                           # (mandatory after src changes; build/ not in git)
npm test                   # unit tests + integration smoke
npm run serve              # http://127.0.0.1:8080/esp-emu-peris.html
npm run sync               # publish into vendor/esp-emu-browser/www (build first; --clean removes stale output)
```

Architecture & data flow: `docs/ARCHITECTURE.md`; peripheral development:
`docs/DEVICE-API.md`; esp-emulator wasm capability limits: `docs/EMU-API.md`
and `docs/FEASIBILITY.md` (M0 measurements); hardware SPI development
(TX capture + RX injection): `docs/SPI-M5.md`; emulator peripheral support
matrix, wasm vs native Linux builds: `docs/EMU-PERIPHERALS.md`.

## 1. Environment pitfalls (this machine)

- **CDN unreachable**: direct jsdelivr connections are reset. Use a mirror for
  npm: `npm --registry=https://registry.npmmirror.com install ...`; fetch
  static assets as tarballs from
  `https://registry.npmmirror.com/<pkg>/-/<name>-<ver>.tgz` and unpack
  (that is how xterm was vendored into `peris/vendor/`; the package ships the
  **unminified** build, no .min).
- **GitHub downloads need the local proxy**:
  `https_proxy=http://127.0.0.1:10809`. The esp-emulator browser (wasm)
  build is fetched from the espressif/esp-emulator GitHub release by
  `tools/fetch_esp_emu.py` (runs automatically on `npm run build`/`npm test`;
  honours `https_proxy`; sha256-verified; cached in `vendor/downloads/`;
  unpacked into `vendor/esp-emu-browser/www`). Override the location with
  `ESP_EMU_WWW=/path/to/www`.
- **Playwright browser binaries** not installed (network); to install:
  `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`.
- **ESP-IDF**: master checkout at `C:\esp\master\esp-idf`; enable the
  environment with `C:\Users\A\Desktop\quick\idfm.bat` (PowerShell profile).
  Scripted invocation **must clear the `MSYSTEM` env var** (Git Bash inherits
  it and idf.py refuses); see `tests/firmware/build.ps1`.
- Firmware must be loaded into the browser as the **`idf.py merge-bin` merged
  image**; a bare app bin silently never starts (symptom: UART stays quiet
  forever). Artifact: `tests/firmware/peris_probe/build/merged-binary.bin`;
  produce it with `tests/firmware/merge.ps1` — **merge-bin's `-o` path is
  relative to the build dir**, so the intuitive `build/merged-binary.bin`
  lands in `build/build/` and silently overwrites nothing.
- `node --test <directory>` resolves incorrectly on Windows/Git Bash —
  **pass the .test.mjs file list explicitly** (package.json does).

## 2. esp-emulator wasm behaviour (measured — do not guess)

- **No callbacks**: everything is `run_batch()` polling between batches; UART
  output is the return string of `run_batch`.
- **LEDC/RMT waveforms never appear in `gpio_state()`** (they go through the
  GPIO matrix); only CPU-direct GPIO writes are visible. Same for hardware
  SPI pads (M5) — matrix-routed signals are pad-invisible, always.
  PWM → read the LEDC `DUTY_R` (value = duty×16, bits[18:4]; full-scale via
  `conf0.TIMER_SEL` → timer `DUTY_RES` bits[3:0]; conf0 bit2 = sig_out_en),
  wiring → scan `GPIO_FUNCn_OUT_SEL_CFG` low bits (LEDC ch0–5 = 45–50;
  **C3: the field is 8 bits and plain GPIO reads 0x80**, S3-class: 9 bits /
  0x100), WS2812 → read the RMT channel RAM (left over after
  transmission). One implementation of all of this: `peris/devices/ledc-lib.js`
  — reuse, never fork. Address tables: `src/core/mmio/`; sources &
  verification: FEASIBILITY.md.
- **Hardware SPI is modelled and usable (M5 — the old "impossible" verdict
  is overturned)**: transfers complete (polling/irq/DMA), the register
  block at 0x60024000 is readable via `read_memory()`, wiring is
  discoverable (FSPICLK=63/FSPIQ=64/FSPID=65/FSPICS0..5=68..73). TX:
  DMA payloads sit in guest RAM (coarse-readable); no-DMA TX only lives in
  W0..W15 between the driver's copy and completion — 10-instruction micro
  batches catch it 9/9, 300-instr batches never do (`USR=1` resolves
  inside the guest's register read). RX: the model returns constant 0xff
  and ignores `gpio_set_input` (no pad sampling); injection works by
  patching the memory-backed W fields in wasm linear memory during the
  completion→consumption window (instance captured by monkey-patching
  `WebAssembly.Instance` around `initSync()`; struct found by value scan,
  no hardcoded offsets). Probes: `tests/m5_probe.mjs`, `m5_mem_probe.mjs`,
  `m5_wasm_static.mjs`; firmware P5 phase; details: FEASIBILITY.md M5.
- **S3 register-level support is measured too (0.14.0, smoke S17 with
  duel_of_8 0.3.0)**: SPI2/GPIO/LEDC/RMT/GDMA all readable on S3. Per-chip
  differences live in the mmio tables (`src/core/mmio/{c3,s3}.ts`) — never
  hardcode a C3 fact for another chip: OUT_SEL is 9 bits on S3 (0x100 =
  plain GPIO), LEDC DUTY at bits[18:0] (`dutyShift`), RMT_STATE at
  bits[24:22] (`rmt.stateShift`), 4 RMT TX channels, RMTMEM at base+0x800,
  GDMA 5 channels with OUT_LINK at +0x80+0xC0·n, FSPI signals 101..115.
  Firmware using `SPI_DMA_CH_AUTO` never touches W0..W15 — max7219 hwspi
  polls the GDMA chain with a frame-shape gate (other devices' DMA on the
  same channels is ignored, not dropped).
- **RMT channel RAM (WS2812, M3-measured)**: the copy encoder writes **one
  RMT word per WS2812 bit**; words wrap every 48; after a transmission the
  RAM holds the reset symbol, one all-zero terminator word and **only the
  last 46 bits** — decode the frame tail, resync on the reset (low ≥30µs)
  and realign the LED grid with leading zeros. `CHnSTATUS` bits[11:9] ≠ 0
  while sending (skip decoding then). C3 RMT pad signals are ch0/1 only
  (51/52). One implementation: `peris/devices/ws2812-lib.js` — reuse, never
  fork.
- **Time fast-forwards during `vTaskDelay`**: pin-level waveforms inside a
  sleep window cannot be captured, regardless of sample rate.
  Waveforms of CPU-active bit-banged signals can be sampled, but **consecutive
  input flips within one batch gap lose edges** (press→release must straddle
  batches; see m1_smoke S3). With an arm lease standing (~1000-instr batches)
  a sleep batch jumps **~680k cycles** — a whole firmware round passes in
  ~2.5k batches while P4's fine windows need ~166k. Never bound test windows
  by batch counts; bound them by UART markers.
- **Guest clock distortion (M4)**: `esp_rom_delay_us` advances emulator time
  at ~50% of nominal (a "9 ms" leader measures 4.505 ms); `vTaskDelay` keeps
  full duration. Decoders must be level- or ratio-based, never absolute-us
  (see FEASIBILITY.md M4 measurements).
- **GPIO input pulses need emulated spacing (M4)**: at armed sizes a press
  every 8 batches held for 3 (~10-40 ms emulated) counts reliably; denser
  pulses lose edges, and M0's instruction-count shapes no longer fit a phase.
- **RMT `CHnSTATUS.APB_MEM_WADDR` reads 0 always** (not implemented) -
  mid-transmission channel-RAM stitching is impossible; post-TX windows only.
- **I2S is not modelled at all (M6, five-layer evidence)**: 0 `i2s`
  strings in the binary, no periph module, and the C3 I2S block
  0x6002D000 appears in **no** encoding (sleb128 immediates / LE-u32
  data / hex strings) while every modelled peripheral's base shows 4-26
  hits — register-level I2S cannot exist. Audio rides a **soft I2S bus**
  (`peris/devices/i2s-lib.js` + `bitbang-i2s-audio.js`): the firmware is
  the bit-bang master (P7 phase of the probe firmware is the reference;
  pace BCLK half-periods ≥ the fine batch of 80 instructions or edges
  land in one batch and slots drop — the decoder resyncs on WS).
  Decoded PCM travels as **incremental getState chunks** (the 33 ms
  throttle + trailing flush guarantee delivery — never cache the chunk);
  the browser mic flows in through `onCommand('mic')` (getUserMedia needs
  a user gesture + secure context; ScriptProcessor must pump through a
  zero-gain node, never the speakers — feedback). Emulator time is
  compressed vs wall time: playback uses a bounded backlog with
  drop-oldest; do not promise real-time continuity.
- **BME280 dig_T1/dig_P1 are uint16** (Bosch layout): 36477 in int16 silently
  becomes negative - T/H still matched, only P diverged (that signature is
  how the bug was found).
- `gpio_set_input` defaults to a high level (pull-up); it reliably raises the
  firmware's GPIO interrupts.
- After a fresh `WasmEmulator` instance the input levels reset → devices must
  re-drive in `onEmuReady()`.

## 3. Architecture iron rules (full picture in docs/ARCHITECTURE.md)

1. **The emulator lives only in the worker**: the page never imports the wasm;
   everything goes through `src/ui/worker-client.ts`.
2. **The only file allowed to replicate upstream logic is `src/core/worker.ts`**
   — every change there must carry a `peris:` marker for upstream-upgrade
   diffs (procedure in docs/UPGRADE.md).
3. **Device plugins are plain JS** (drop a file and it works, no build); the
   framework is TypeScript. Do not add imports from devices/ into src/ runtime
   modules (compiled `build/core/*.d.ts` types may be used for JSDoc hints).
4. Plugin metadata must include `static pins(cfg)` (conflict detection),
   `typeId`, `title`, `defaultConfig`, optional `version`; the registry
   validates at load time and **errors out immediately when missing**.
5. The page's `PerisPanel.config` is the single source of truth for
   configuration: every change is sent in full + localStorage; never cache or
   mutate config on the worker side.
6. State pushes have a 33ms throttle + a **trailing timer** (guarantees the
   last dirty flag is always delivered) — do not remove the trailing flush;
   it fixed a real defect (silently dropped state).
7. sigbus diffs `gpio_state` per batch with the **union mask** (out|oe),
   notifying each pin at most once per batch.
8. **Same-semantic code must be reused — never copy and modify**: one logic,
   one implementation, and every entry point (row chip / details editor / row
   icon / new plugin) calls the same function — GPIO options =
   `fillPinOptions()` in `config-editor.ts`; V·G badge derivation =
   `rowChips()`; a plugin's multiple visuals (LED bulb + row icon) share one
   setter/render — never write a second styling path for the icon; the panel
   calls View hooks in a fixed order, **`rowIcon` before `setConfig`**, so
   config-driven styling covers the icon too. Before changing behaviour, look
   for an existing function and reuse it; when review finds duplicated code,
   extract the shared function first, then change it.
9. **Register-level devices (LEDC/RMT) poll MMIO on `onBatch()`** and get
   their addresses from `ctx.mmio` (per-chip tables in `src/core/mmio/`; a
   missing table means the device must idle). Shared device-side semantics
   live in plain-JS helper modules under `peris/devices/` **outside the
   manifest** (`ledc-lib.js` — wiring scan, duty decode, bulb painter +
   animator) so both plugins and the unit tests import one implementation.
   LEDC devices return `[]` from `pins()` (the wiring is firmware-side
   routing, nothing to claim); the generic editor's `<select>` hands values
   back as **strings** (`parseChannel` normalises; beware `Number(null)===0`).
10. **Bit-bang devices ride the sampling scheduler (M4)**: `ctx.armSampling`
   once (idle watch), `ctx.fineSampling` on every edge (renewed lease;
   auto-expires on CPU-sleep fast-forward). Never busy-poll at fine sizes -
   the scheduler is the only batch-size path (`runtime.batchSize()`, used by
   the worker AND the tests). Bus devices declare `static sharedBus = true`;
   the runtime wired-ANDs shared pads' input drives (gpio_set_input is a
   single-winner level write - two slave engines otherwise clobber each
   other's ACK pulls, a real M4 bug).
11. **Views may own DOM outside their row** (the logic-analyzer floating
   window is `position: fixed` on `document.body`, non-modal by design —
   never add a backdrop). Such Views MUST implement `destroy()` (the panel
   calls it on row removal and list rebuilds) and build multi-pin pickers
   from `host.pinInfo()` — the same candidate-aware pin set the generic
   editor uses, never a forked copy. `ctx.pinLevel(pin)` reads the current
   driven level for snapshots only; the change stream stays `onPinState`.
   Pure listeners declare `static passive = true` (0.11): the runtime's
   conflict check and wired-AND skip their pads, and other devices' pin
   pickers never show them as used — a probe clamps anywhere, an active
   device does not.

## 4. Past bugs (prevent regressions)

| bug | lesson |
|---|---|
| registry resolved manifest module paths to the `peris/` root | manifest paths are relative to the devices/ dir; update `DEVICES_DIR` when compile locations move |
| `ctx.subscribe()` in a device constructor ran before the instance was registered | sigbus stores a **getter function** for lazy resolution — never the instance |
| error bar `style.display=''` fell back to CSS `none`, never visible | set `display='block'` explicitly, and clear textContent when there is no error (stale messages) |
| `peris_config` arrived before registry init → everything "unknown type" | `applyConfig` awaits init first |
| a device forgot `static pins()` → conflict detection silently off | registry enforces + unit-tested |
| button activeLow levels inverted | idle = high, pressed = low (active-low pull-up wiring); semantics pinned by unit tests |
| worker URL resolved relative to the **page**, not the importing module | worker-client hard-codes the page-relative path `build/core/worker.js` |
| throttle window dropped the last state | trailing flush (see §3.6) |
| LED row-icon colour disagreed with the details bulb (0.3.0) | the panel called setConfig before rowIcon and the plugin styled the two in separate places; unified `setColour` + fixed call order (§3.8) |
| after loading firmware for another chip, the details editor kept the old chip's GPIO options (0.3.0) | the editor snapshot `validPins` at build time; chip changes must rebuild editors, and option building goes through `fillPinOptions` (§3.8) |
| m1 markers: `line === '###P1 end'` never matched (the firmware prints `###P1 end btn=N`), `inP1` stuck true and loops overran whole rounds (M4) | match protocol markers with `startsWith` when the firmware appends data; a stuck phase flag fails silently - bound every loop by markers |
| two I2C slaves on one bus NACKed every transaction (M4) | `gpio_set_input` is a single-winner level write; shared-bus pads need the runtime's wired-AND arbitration (`sharedBus` metadata) |
| read-address bytes were never ACKed by the engine (M4, unit-caught) | the ACK decision belongs to the *completed byte* (`ackThisByte`), not to the (already switched) phase |
| C compensation diverged from the JS model only in pressure (M4) | `dig_P1` is uint16 in the Bosch layout; 36477 wraps negative in int16 - keep the C and JS implementations cross-checked bit-exactly by the smoke test |
| the logic-analyzer popup opened empty (0.10.0 GUI smoke): a `this.`-less `trigSel` threw mid-construction and the half-built window stayed on screen | unit tests never run View DOM code — for popup-building plugins, do a GUI pass with a `window.addEventListener('error')` trap; also wrap `setPointerCapture` in try/catch (synthetic/automated pointer events carry no active pointer id and throw NotFoundError, killing the drag) |

## 5. Testing & verification conventions

- **Unit tests** (node:test, zero deps): pure logic — sigbus bit math, level
  semantics, config validation, MMIO address tables, LEDC duty decode /
  wiring scan / auto-binding against **fake MMIO** (a `Map<addr, u32>` +
  the real C3 table, see `makeMmioCtx` in tests/unit/devices.test.mjs);
  M4 protocol layer (scheduler leases, the I2C engine driven by a synthetic
  open-drain master, register models, compensation pins, NEC decode, the
  sharedBus rule) in `tests/unit/protocol.test.mjs`.
  Mandatory after changing core/devices; for a new device, follow
  `tests/unit/devices.test.mjs` (GPIO semantics) or
  `tests/unit/protocol.test.mjs` (protocol engines) and add level/state
  semantics cases.
- **Integration smoke** `tests/m1_smoke.mjs`: real wasm + firmware + runtime +
  devices (S1–S6 GPIO devices — S4b drives the `###P1b` digital-in sampling:
  switch/touch/button levels read back by the guest plus the LED mirror,
  S7/S8 LEDC register-level devices driven by the `###P2` markers, S9 ws2812
  by `###P3`, S10/S11 the M4 I2C+IR devices by `###P4`, S13 the logic
  analyzer armed on the P4 soft-I2C bus (SCL/SDA legally shared with the
  i2c slaves), S14/S15 the M5 hardware-SPI devices reconfigured in and run
  to the NEXT round's `###P6 end` — the S13 frozen-check loop already
  carried the round through P5/P6 and latched the flag, so S14 resets it
  (a window lesson: unconditional settle loops consume later phases). Unit
  layer for the same devices: `tests/unit/spi.test.mjs`. S12 is
  **machine-local**: it boots the gun 0.1.0 release — a real-world
  ESP32-S3 firmware with a delay-free bit-banged MAX7219 — in a second
  emulator instance and skips with a notice when
  `D:/d3/_git/gun_flag_monster/gun/release/0.1.0/gun-0.1.0-merged.bin`
  is absent; the gun project is read-only reference material, never modify
  it, and its later releases use hardware SPI — M5 made that visible at
  the register level, a future S12 variant could decode it). **Timing lessons**:
  - **drive by UART markers, never batch counts** — with M4 leases standing
    a sleep batch fast-forwards ~680k cycles, and a batch-count window
    overshoots whole rounds (the firmware prints `###P1/P1b..P4 start/end` and
    `###ROUND`, see `tests/firmware/peris_probe/main/main.c`);
  - match markers with `startsWith` when the firmware appends data —
    `###P1 end btn=N` once broke an exact-match flag;
  - the firmware resets the button counter at each P1 start, so the count may
    only appear on the `###P1 end btn=N` line; presses need the emulated
    cadence (every 8 batches held 3, §2);
  - sample state via forced `rt.flushStates(true)` calls in loops — waiting
    on the wall-clock throttle makes checks flaky.
- **M0 probe** `tests/m0_probe.mjs`: after an upstream wasm upgrade this is
  **the first thing to run**; if any of the six conclusions (Q1a..Q3b)
  changed, update FEASIBILITY.md/EMU-API.md before touching other code.
  Then run the M5 pair (`tests/m5_probe.mjs` bus-level,
  `tests/m5_mem_probe.mjs` memory access + RX injection — expects the P5
  firmware phase, three rounds) and `tests/m5_wasm_static.mjs` (export/
  string inventory — checks the wasm surface is still the documented 34
  exports and the periph module strings are unchanged).
- **GUI smoke** (manual; checklist in ARCHITECTURE.md §5): the IAB automation
  used in past sessions degrades easily (click actionability timeouts,
  screenshot surface failures, xterm DOM rendering only viewport rows and
  freezing whole blocks when rAF stalls) — **read-only DOM assertions are the
  most reliable**; firmware injection can use the page's own drop handler
  (same-origin fetch → File → DataTransfer → drop event) as environment setup.

## 6. Versioning & releases

- Project version: synced in three places — `src/core/version.ts` +
  `package.json` + `docs/CHANGELOG.md`.
- Device versions: each plugin's `static version`, shown in the row header;
  CHANGELOG keeps a device version table.
- Publish into www with `npm run sync` (--clean removes stale output); the
  stock www files (index.html/app.js/worker.js/pkg/serve.py) are **never
  touched**.

## 7. Documentation conventions (bilingual)

- Every document ships in two languages: **English under the default
  filename**, **Chinese as `*.zh-cn.md`** (README/AGENT/docs/*); the two
  versions cross-link in their first line, and in-document links stay within
  the same language.
- Any documentation change must be applied to **both languages** in the same
  commit — no translating later.

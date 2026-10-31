**English** | [简体中文](AGENT.zh-cn.md)

# AGENT.md — required reading for follow-up agents (gotchas & conventions)

This file captures every environment pitfall, architecture rule and
verification method learned so far. **Read it fully before touching anything.**
(Chinese version: AGENT.zh-cn.md — keep both in sync, see §7.)

## 0. Quick start

```bash
npm install                # typescript via npmmirror (see §1)
npm run build              # tsc: src/ → build/ (mandatory after src changes; build/ not in git)
npm test                   # unit tests + integration smoke
npm run serve              # http://127.0.0.1:8080/esp-emu-peris.html
npm run sync               # publish into _tools/esp-emu-browser/www (build first; --clean removes stale output)
```

Architecture & data flow: `docs/ARCHITECTURE.md`; peripheral development:
`docs/DEVICE-API.md`; esp-emulator wasm capability limits: `docs/EMU-API.md`
and `docs/FEASIBILITY.md` (M0 measurements).

## 1. Environment pitfalls (this machine)

- **CDN unreachable**: direct jsdelivr connections are reset. Use a mirror for
  npm: `npm --registry=https://registry.npmmirror.com install ...`; fetch
  static assets as tarballs from
  `https://registry.npmmirror.com/<pkg>/-/<name>-<ver>.tgz` and unpack
  (that is how xterm was vendored into `peris/vendor/`; the package ships the
  **unminified** build, no .min).
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
  GPIO matrix); only CPU-direct GPIO writes are visible.
  PWM → read the LEDC `DUTY_R` (value = duty×16, bits[18:4]; full-scale via
  `conf0.TIMER_SEL` → timer `DUTY_RES` bits[3:0]; `conf0` bit2 = sig_out_en),
  wiring → scan `GPIO_FUNCn_OUT_SEL_CFG` low 9 bits (LEDC ch0–5 = 45–50,
  0x100 = plain GPIO), WS2812 → read the RMT channel RAM (left over after
  transmission). One implementation of all of this: `peris/devices/ledc-lib.js`
  — reuse, never fork. Address tables: `src/core/mmio/`; sources &
  verification: FEASIBILITY.md.
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
  by `###P3`, S10/S11 the M4 I2C+IR devices by `###P4`). **Timing lessons**:
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

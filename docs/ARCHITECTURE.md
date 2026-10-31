**English** | [简体中文](ARCHITECTURE.zh-cn.md)

# esp-emu-peris system architecture

## 1. Layered overview

```
┌───────────────────────────────── page ──────────────────────────────────────┐
│ esp-emu-peris.html   stock style block kept verbatim (easy upgrade diff)    │
│                      + <link peris/peris.css>                               │
│ three panes at once: UART0 console | peripherals | debug (no tabs since 0.3)│
│ build/ui/*  (TypeScript compiler output)                                    │
│   app.ts          orchestrator: machine state, Run/Pause/firmware/network   │
│                   controls, message routing                                 │
│   worker-client   the only Worker entry (all other modules go through it)   │
│   terminal / chart / debug-panels     UART console / perf chart / read-only │
│                                       debug panels                          │
│   peris-panel + config-editor         row-based peripherals list            │
│                                       (icon/name/GPIO/V·G badge            │
│                                       + expand/remove/drag-sort) and the   │
│                                       details config editor                │
└───────────────▲───────────────────────────────────────────────▲────────────┘
        postMessage (protocol in core/protocol.ts)                │ DOM
┌───────────────┴───────────────────────────────────────────────▼────────────┐
│ page-side device Views (View classes of peris/devices/*.js, instantiated    │
│ by peris-panel)                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                            ← peris_state / peris_command →                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ build/core/worker.ts  upstream worker replica + 6 peris: hooks (the only    │
│                       file allowed to touch upstream logic)                 │
│ build/core/runtime.ts device host: config validation/instantiation/commands │
│                       /onBatch MMIO tick + throttled state pushes           │
│ build/core/sigbus.ts  pin signal bus: per-batch gpio_state() diff dispatch  │
│ build/core/registry.ts plugin registry (manifest-driven + meta validation)  │
│ build/core/{version,types,protocol,chips,mmio}.ts  version/contracts/       │
│                       messages/chip tables/register tables                  │
│ worker-side devices (Device classes of peris/devices/*.js; shared helpers   │
│                       such as ledc-lib.js sit outside the manifest)         │
└───────────────────────────────────────────────────┬─────────────────────────┘
                                                    │ WasmEmulator (closed-source
                                                    │ wasm, touched only here)
                                            esp_emu_bg.wasm v0.51.0
```

## 2. Key decisions and why

| decision | rationale |
|---|---|
| emulator lives only in the worker | the page never touches the wasm; all interaction goes through postMessage, so the threading model cannot be broken |
| framework in TypeScript, device plugins in plain JS | type-checking covers the bug-prone areas (the big refactor fixed a dropped-state defect this way); plugins stay drop-in with no build dependency |
| tsc per-file compilation, no bundling | output stays a standard ESM directory, deployment model unchanged (www add-only); same shape as upstream for easy upgrade diffs |
| peris styles split into peris.css, stock styles stay inline in the HTML | upstream sections of the HTML can be diffed directly on upgrade |
| data lives in TS constants (chips/mmio), not JSON | carried natively by tsc, type-checked, no runtime copy issues |
| registry validates plugin metadata at load time | plugin authors get no compile-time checks; a missing `pins()`/`typeId` fails immediately at load (a real bug class) |

## 3. Data flow and state ownership

- **Firmware → device**: after each `run_batch()` the worker calls
  `runtime.onBatchEnd()` → `sigbus.sample()` reads `gpio_state()` (four 32-bit
  words) and, using the **union change mask** (out|oe), dispatches one
  `onPinState` per changed pin. With no changes the cost is 1 wasm call + 4
  XORs. Register-level devices (LEDC/RMT) additionally receive an
  `onBatch()` tick in the same call and poll MMIO through
  `ctx.readU32`/`ctx.mmio` — their signals never surface as pin changes
  (GPIO matrix, M0 Q2a/Q3a).
- **Device → page**: `markDirty()` → `flushStates` throttled to ~30 fps; **a
  trailing timer is attached inside the throttle window so the last dirty flag
  is always delivered** (otherwise a final state resting inside the window
  would be dropped).
- **Page → device**: View `sendCmd()` → `peris_command` → `runtime.command()` →
  `onCommand`.
- **Input pin levels**: the only writers are `ctx.setPinInput` (devices) and
  the Debug grid's `gpio_input`. The page-side `gpioInputLevels[]` is only the
  Debug grid's own mirror, not authoritative state; the authority lives in the
  devices (re-driven on `onEmuReady`).
- **Config**: the page's `PerisPanel.config` is the single source of truth;
  every change is sent in full via `peris_config` (the worker destroys and
  rebuilds instances) and written to localStorage. Pin conflicts are validated
  by the worker and reported back through `peris_ready.errors`, shown as a
  yellow bar on the page.

## 4. Directory responsibilities

```
src/core/        worker-side framework (TS sources)   → compiled to build/core/
src/ui/          page-side modules (TS sources)       → compiled to build/ui/
build/           tsc output (not in git; HTML/worker/tests reference it)
peris/devices/   device plugins (JS sources, not compiled; manifest.json
                 registers them; each carries its own version; shared
                 helper modules like ledc-lib.js live here but outside the
                 manifest)
peris/vendor/    vendored xterm
peris/peris.css  peris-specific styles
tests/unit/      unit tests (node:test, zero dependencies)
tests/m1_smoke.mjs  integration smoke (real wasm + firmware + runtime + devices)
tests/m0_probe.mjs  emulator capability probe (run first on upstream upgrades)
tests/firmware/  IDF test firmware
```

## 5. Build & tests

```bash
npm install                 # one-time (typescript from the npmmirror registry)
npm run build               # tsc → peris/core + peris/ui (mandatory after src changes)
npm run check               # type-check only
npm test                    # unit + integration smoke
npm run serve               # python serve.py (merges the service repo and www/pkg)
npm run sync                # publish into the official www (build first)
```

Test layering: **unit** (pure logic: bit math / level semantics / validation /
row-badge derivation / LEDC register decode against fake MMIO, plus the M4
protocol layer — scheduler leases, the I2C slave engine under a synthetic
open-drain master, register models, NEC decode — fast, pinpoints failures) →
**integration** (real wasm + firmware, full chain; S7/S8 drive by the `###P2`
markers, S9 by `###P3`, S10/S11 — soft-I2C slaves + both NEC capture paths —
by `###P4`; every window is marker-bounded because armed batches fast-forward
whole sleep phases) → **GUI** (manual checklist: page load, three panes
visible at once, row rendering after adding a device, inline rename / GPIO
change / V·G flip, row-icon interactions (LED colour / press / switch), expand
details & config editing, drag sorting, firmware load, LED toggling while
running, PWM/RGB LED auto-binding to the firmware's LEDC channels with smooth
breathing during the P2 phase, the I2C transaction log filling during P4 with
the EEPROM hex dump editable from the View, IR codes appearing on both
ir-nec rows, config import/export round-trip; browser automation to be
introduced with Playwright once the network allows —
`PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`).

## 6. Upgrade procedure (summary; details in UPGRADE.md)

1. After a new wasm package lands, run `npm run test:m0` first and compare
   against FEASIBILITY.md;
2. diff the upstream worker.js ↔ `src/core/worker.ts` (all changes carry
   `peris:` markers);
3. diff upstream app.js/index.html ↔ `src/ui/*.ts` and the stock style section
   of the HTML;
4. `npm run build && npm test`, manual GUI pass.

## 7. Extension points

- **New peripheral**: drop a module into `peris/devices/` + one manifest line
  (see docs/DEVICE-API.md); worker and page load it automatically with
  immediate metadata validation.
- **New chip**: add the address table in `src/core/mmio/<chip>.ts` and register
  it in `mmio.ts`; add the pin count in `chips.ts`.
- **New page panel**: add a module in ui/ and register it in app.ts's message
  routing — the worker protocol stays untouched.

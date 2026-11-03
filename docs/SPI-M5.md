**English** | [简体中文](SPI-M5.zh-cn.md)

# Hardware SPI development guide (M5 findings)

Everything a future device author needs to build on the M5 discovery:
hardware GP-SPI **is** modelled by esp-emulator v0.51.0, its **output is
observable** at the register/memory level, and its **input is injectable**
through the wasm linear memory. The old M5 verdict ("hardware SPI cannot be
tapped") was overturned on 2026-11-02; the measurements live in
[FEASIBILITY.md](FEASIBILITY.md) §"M5 measurements", the register/signal
facts in [EMU-API.md](EMU-API.md) §3b. This document is the *how-to*.

Verification entry points:

| tool | what it proves | run |
|---|---|---|
| `tests/m5_probe.mjs` | bus-level: register readability, transfer completion, MISO behaviour, wiring, DMA payload, TX micro-batch window | `node tests/m5_probe.mjs` (needs the peris_probe firmware, ~2 rounds) |
| `tests/m5_mem_probe.mjs` | memory access: struct discovery, writability, RX injection (3 rounds: locate / learn / inject) | `node tests/m5_mem_probe.mjs` |
| `tests/m5_wasm_static.mjs` | wasm surface: exactly 34 exports, periph module strings | `node tests/m5_wasm_static.mjs` |
| firmware P5 phase | hardware SPI2 master exercising polling / interrupt / DMA transfers | `tests/firmware/peris_probe` (see §6 for the marker protocol) |

## 1. What works and what does not

| direction | path | verdict |
|---|---|---|
| firmware → devices (TX / MOSI) | DMA transfers: payload in guest RAM | ✅ readable, coarse batches, no timing tricks |
| firmware → devices (TX / MOSI) | no-DMA transfers: W0..W15 window | ✅ readable with **10-instruction micro batches** (9/9 caught); 300-instr batches never catch it |
| devices → firmware (RX / MISO) | `gpio_set_input` on the MISO pad | ❌ model returns constant 0xff, never samples the pad |
| devices → firmware (RX / MISO) | wasm linear-memory W-field patch | ✅ proven (guest received host bytes `d1 c0 ff ee`), reproducible — hack-grade, per-build offsets |
| wiring discovery | GPIO matrix registers | ✅ identical method to LEDC/RMT |
| transfer lifecycle | completion, trans_done interrupt | ✅ all driver modes work (e=0) |
| pin-level waveforms | `gpio_state()` | ❌ matrix-routed signals never appear (M0 class); CS may be an exception, unmeasured (§8) |

## 2. The facts (ESP32-C3, wasm v0.51.0)

### 2.1 SPI2 register map

Base `0x60024000` (C3; per-chip tables live in `src/core/mmio/` — only C3
is measured). Offsets verified live in **bold**:

| register | offset | notes |
|---|---|---|
| **CMD** | 0x00 | bit0 = USR (fire). **Never reads 1 from the host** — completion resolves inside the guest's own register access |
| **ADDR** | 0x04 | |
| CTRL | 0x08 | |
| CLOCK | 0x0C | |
| **USER** | 0x10 | read 0x18000041 in the probe runs — this exact value is the **struct-discovery anchor** (§5.2) |
| USER1 / USER2 | 0x14 / 0x18 | |
| MS_DLEN | 0x1C | |
| **MISC** | 0x20 | read 0x3e; USER+MISC pair validates the anchor hit |
| DMA_CONF | 0x30 | |
| **W0..W15** | 0x98..0xD4 | 64-byte staging window; byte packing: tx[i] lands in bits [8i+7:8i] (tx {A0,FF,00,5A} → w0 = 0x5a00ffa0) |

### 2.2 GPIO matrix wiring (auto-discovery)

Identical approach to LEDC/RMT (`peris/devices/ledc-lib.js` — reuse its
scan loop shape, don't fork):

- **Output side** — `GPIO_FUNCn_OUT_SEL_CFG = 0x60004000+0x554+4*pin`.
  SPI signal numbers (C3): FSPICLK=63, FSPIQ=64, FSPID=65, FSPIHD=66,
  FSPIWP=67, FSPICS0..5=68..73. Measured with the driver on pins
  11/12/13: sclk→63, mosi→65, miso→64 (FSPIQ_OUT routed, oe off).
  **C3 field correction**: the OUT_SEL field is **8 bits** and plain GPIO
  reads **0x80** (default) — not 9-bit/0x100 as on S3-class chips. SPI
  ids 63–73 are all below 0x80, so scans that match by signal id are
  unaffected.
- **Input side** — `GPIO_FUNC(sig)_IN_SEL_CFG = 0x60004000+0x154+4*sig`;
  FSPIQ_IN (sig 64) read `in_sel=13` (the MISO pin), which pads the
  pad→signal direction of the discovery table.
- IO_MUX: GPIO0..21 contiguous at `0x60009000+0x04+4n`.

### 2.3 Model behaviour (measured, shapes every design decision)

1. **Transfers complete in every driver mode** — polling
   (`spi_device_polling_transmit`), interrupt-driven
   (`spi_device_transmit`, task blocked: the trans_done interrupt *is*
   delivered) and DMA (`SPI_DMA_CH_AUTO`), all e=0.
2. **Completion resolves on register access, not on a timer**: a 1 MHz
   32-bit transfer adds ~0 guest cycles (60 ms sleep window measures
   9.604 M cycles ≈ sleep + overhead; no 32 µs delay is forced). This is
   why `CMD.USR=1` is never observable from the host at any batch size —
   polling drivers resolve it in their own status read, and in the
   interrupt path the sleep-to-IRQ fast-forward swallows the window.
3. **The W window holds TX only between the driver's copy and
   completion**: the hal stores TX into W0..W15, fires CMD, and the model
   overwrites W with the RX result (all 1s) at completion. After a
   transfer W reads 0xffffffff (that is the *received* data, not stale
   TX).
4. **MISO is synthetic and pad-blind**: holding the pad low via
   `gpio_set_input` for an entire transfer still returns 0xff. The SPI
   model does not sample pad inputs (unlike the GPIO peripheral).
5. **DMA bypasses W**: after a DMA transfer the W regs keep their stale
   no-DMA content; the payload sits in the driver's guest-RAM buffer.
6. **GPIO-state pads**: SPI pads never show edges in `gpio_state()`
   (matrix-routed, like LEDC/RMT). The CS pin read the plain-GPIO marker
   (0x80) — CS *frame-boundary visibility* at fine batches is plausible
   but unmeasured (§8).

## 3. Reading TX — implementation guide

### 3.1 DMA transfers (the normal case for displays / SD)

The payload is ordinary guest RAM. Read it with `read_memory()` from the
device's `onBatch()` — coarse batches suffice (measured: 256/256 bytes of
an `i^0xA5` pattern after the "dma done" marker, no timing tricks).

Finding the buffer address without firmware cooperation is an **open
item** (§8): the DMA engine (GDMA) fetches from a linked descriptor list.
The M5 probe short-circuited this by having the firmware print its buffer
address (`###P5 dma buf=0x…`). A production sniffer must walk the GDMA
out-descriptor chain (IDF headers:
`components/soc/esp32c3/register/soc/gdma_reg.h`) or correlate
`SPI_DMA_CONF` activity with buffer ownership.

### 3.2 No-DMA transfers (≤64 bytes: commands, control words)

Strategy: watch the W window with **micro batches** during the driver's
load→fire sequence.

- Measured: **10-instruction batches caught the TX payload 9/9** (8
  polling transfers + 1 interrupt-driven). 300-instruction batches
  caught nothing — the window is a few dozen guest instructions wide.
- Detection: read W0 each batch; when it changes from the idle value
  (0xffffffff or stale) to something else, record W0..W15 immediately.
  The load→fire window spans multiple 10-instr boundaries, so several
  consecutive batches show the TX before the model wipes it.
- Cost: this is the M4 scheduler's floor size (the fine-lease floor is
  20; 10 is below it — extend the floor or add a "micro" lease tier).
  A standing micro lease is expensive; arm it only when the wiring scan
  sees an SPI signal and the phase is transfer-active (see
  `docs/ARCHITECTURE.md` scheduler; the logic-analyzer's arm/fine
  pattern is the template).

### 3.3 Framing (what the sniffer emits)

Combine the two paths: no-DMA words from the W window, DMA runs from the
RAM buffer, frame boundaries from CS activity (once measured, §8) or
from USER1/MS_DLEN bit-length reads around each capture. Protocol
decoders (MAX7219, ILI/ST7789 command streams) then consume the byte
stream — the same shape as `peris/devices/max7219-lib.js`'s shift
engine, fed from registers instead of edges.

## 4. RX is not pad-drivable — the one dead end

For completeness: `gpio_set_input` on MISO does nothing (0xff constant),
and there is no write-memory wasm export (34 exports total,
`m5_wasm_static.mjs` guards this). Any design that needs the *firmware*
to receive bytes must use §5.

## 5. Injecting RX — the linear-memory path

Proven end-to-end by `tests/m5_mem_probe.mjs`: the firmware received
`d1 c0 ff ee` written by the host. Control rounds (no write) receive
`ff ff ff ff`.

### 5.1 Capturing the wasm instance

The glue (`pkg/esp_emu.js`) keeps its `wasm` module-private, but the
instance is created inside `initSync()` — wrap the constructor:

```js
const OrigInstance = WebAssembly.Instance;
let captured = null;
WebAssembly.Instance = function (module, imports) {
    captured = Reflect.construct(OrigInstance, [module, imports]);
    return captured;
};
const { initSync } = await import('./pkg/esp_emu.js');
initSync(fs.readFileSync('./pkg/esp_emu_bg.wasm'));
WebAssembly.Instance = OrigInstance;            // restore immediately
// captured.exports.memory — the live machine's linear memory
```

Notes: only the glue's *first* `initSync` instantiates (later calls
return the cached `wasm`), so patch before the first call. In the worker
architecture this capture belongs in `src/core/worker.ts` (the only
upstream-replicating file — mark the change `peris:`, see
docs/UPGRADE.md) behind a capability probe, because a page-side device
must ask the worker to do the patching.

### 5.2 Locating the model struct (no hardcoded offsets)

The register file is memory-backed: writes through a DataView are
reflected by `read_memory()`. Discovery, per emulator instance:

1. Read a distinctive live register pair through `read_memory()`:
   `USER` (e.g. 0x18000041) and `MISC` (0x3e) — values the running
   firmware wrote; pick them *at runtime*, never hardcode.
2. Scan the whole linear memory (13.5 MiB, one `Uint32Array` pass) for
   the USER value. Expect few hits (one in the M5 runs).
3. Verify a hit `A`: write a sentinel via DataView, confirm
   `read_memory(SPI_USER)` returns it, restore. Optionally check
   `MISC` at `A + 0x10` (USER+0x10 vs MISC: struct base = A − 0x10).
4. W0 sits at `structBase + 0x98` if the layout mirrors the register
   map (it does in v0.51.0) — verify the same write-through way, else
   probe the neighbourhood.

### 5.3 The completion→consumption race

Sequence inside the guest (interrupt-driven transfer): driver stores TX
into W → sets CMD → **model completes, overwrites W with 0xff** →
trans_done interrupt → ISR/task wakes → driver reads W into its rx
buffer. The host can only inject between the model's overwrite and the
driver's read:

- **Batch size 1** won the race (2/2 runs); batch size 10 lost it
  (1/1) — the overwrite and the driver's read land inside one batch at
  larger sizes.
- Watch the W0 field via DataView (cheap — no `read_memory()` call)
  after every single-instruction batch. Trigger states:
  1. field == expected TX word → driver loaded, transfer imminent;
  2. field == 0xffffffff right after (1) → completed, not yet consumed.
- On (2): write the desired RX word(s). tx[i] in bits [8i+7:8i], so
  bytes {d1,c0,ff,ee} → w0 = 0xEEFFC0D1.
- The guest's read path returns the field **directly** — the
  before/after struct diff around consumption is zero words in v0.51.0
  (no pending flags to clear). If a future build introduces flags, the
  learn-round diff in `m5_mem_probe.mjs` will surface them.

### 5.4 Reliability strategy

The proven run wrote once at the (2) boundary. Because "see 0xffffffff"
is ambiguous with "already consumed", the robust product pattern is:

- After seeing (1), **rewrite the RX word on every batch boundary**
  until the transfer's end is confirmed (rx-length bits elapsed / next
  TX load appears). The model's single 0xff write then gets overwritten
  by the next boundary before the driver can read it.
- Verify with an echo: devices that can also observe the firmware's
  reaction (a following TX containing the value, like the P5 marker
  line) close the loop; retry the transfer window if lost.
- Expect this to cost single-instruction batches only inside the
  transfer window (tens of boundaries); outside it, coarse batches
  resume.

### 5.5 Version fragility

- Struct offsets are **per wasm build**. The version is pinned and
  sha256-verified by `tools/fetch_esp_emu.py`; the discovery scan makes
  offsets self-locating, so a new build needs no table — but **re-run
  the M5 probes after every upgrade** (§7).
- A device relying on injection must degrade gracefully: if discovery
  fails (no verified hit), fall back to TX-only mode and say so in the
  UI — never hard-fail the panel.
- The `WebAssembly.Instance` patch must be restored immediately after
  `initSync` so nothing else captures a stale constructor.

## 6. The P5 firmware phase (marker protocol)

`tests/firmware/peris_probe/main/main.c` runs after P4 each round. Pins:
FSPICLK=11, MOSI=12, MISO=13, CS=14. Rebuild:
`tests/firmware/build.ps1` then `tests/firmware/merge.ps1`.

| marker | meaning |
|---|---|
| `###P5 start` | phase A begins: bus init without DMA |
| `###P5 init=N` / `add=N` | init error (esp_err_t) — phase aborts |
| `###P5 tx k=K` | 60 ms sleep, **then** a polling 4-byte transfer {0xA0\|k, ~k, k, 0x5A}; the probe drives the MISO pad level inside the sleep (even k low, odd k high) |
| `###P5 rx k=K e=E b=XX XX XX XX` | transfer done; rx bytes = what the model gave the firmware |
| `###P5 irq tx` / `###P5 irq rx e=E b=…` | same for one interrupt-driven transfer {C3,3C,55,AA} |
| `###P5 w0=… w1=… w2=… w3=…` | firmware's own W readback (ground truth for `read_memory` cross-checks) |
| `###P5 cmd=… user=… misc=… addr=…` | firmware's control-register readback |
| `###P5 dma buf=0xADDR len=256` | bus re-initialised **with DMA**; 60 ms sleep, then a polling 256-byte transfer of `i^0xA5` from that static buffer |
| `###P5 dma done e=E` | DMA transfer finished |
| `###P5 dmainit=N` / `dmadd=N` | DMA re-init error |
| `###P5 end` | phase over (bus freed) |

Conventions honoured: markers matched with `startsWith`-style parsing
(the firmware appends data), loops bounded by markers never batch
counts, phases re-initialise the bus every round (no cross-round state).

## 7. Verification & upgrade procedure

After any esp-emulator wasm upgrade (procedure in
[UPGRADE.md](UPGRADE.md)):

1. `node tests/m0_probe.mjs` — Q1a..Q3b conclusions unchanged.
2. `node tests/m5_wasm_static.mjs` — still 34 exports, no
   write-memory/device-bridge export appeared, periph module strings
   unchanged. **If an official device-bridge API appeared, prefer it
   over §5.**
3. `node tests/m5_probe.mjs` — M5a/M5b/M5e still PASS; M5c still
   constant 0xff; M5g still 9/9 (if it drops, the load→fire window
   changed size — retune the micro-batch tier).
4. `node tests/m5_mem_probe.mjs` — injection still PROVEN; the struct
   address will likely differ (fine — discovery is runtime) and the
   consumption diff should stay empty (if not, read §5.3's flag note).
5. Update FEASIBILITY.md/EMU-API.md and both translations if anything
   shifted (AGENT.md §7 bilingual rule).

Also run `npm test` — m1_smoke ignores P5 but its rounds get ~1.3 s
longer per round (S12 unaffected).

## 8. Open items (not yet measured — do not assume)

- ~~**GDMA descriptor walking**~~ — measured and shipped (0.12.0): see the
  addendum below; `spi-lib.readDmaPayload` / `readDmaChainAt` implement it,
  the ILI9341 rides it.
- **CS frame boundaries**: the CS pin reads the plain-GPIO marker, so
  its edges plausibly appear in `gpio_state()` at fine batches — a free
  frame-delimiter if true.
- **Other chips**: only C3 measured (SPI2 @ 0x60024000). S3/P4/C6 etc.
  need their own mmio tables (`src/core/mmio/`, ROADMAP maintenance
  item) and a probe re-run — base addresses and signal numbers differ.
- **Hardware I2C controller**: modelled upstream (built-in EEPROM at
  0x50; wasm strings show `src/periph/i2c.rs`); register-level access
  should mirror SPI but is untested. Same method applies.
- **SPI slave mode** (firmware as slave, devices as master): untested.
- **Dual/Quad (QIO) transfers**: untested; the W-window story may
  differ when 4 lines carry data.
- **Injection on polling transfers**: proven on the interrupt path;
  polling drivers read W sooner after completion — treat as
  harder/unproven until measured (§5.4's continuous rewrite is the
  candidate strategy).

## 9. Change history


## 10. 0.12.0 development addendum — the GDMA segment lifecycle

Building the devices on this guide surfaced the DMA path's real shape
(P6-traced, wasm v0.51.0; all of it is encoded in `spi-lib.js` and
`ili9341.js`):

1. **A DMA bus bypasses W for EVERY transaction** — commands included.
   esp_lcd-style drivers push the command byte through GDMA too, so the
   W window only serves DMA-less drivers (Arduino-class); a DMA-bus device
   must classify and capture through the descriptor chain.
2. **The hal clears the outlink between transactions** — a gap read of the
   outlink returns 0. The descriptor struct in guest RAM survives, though:
   caching the first-descriptor address while a transfer is in flight and
   re-walking THAT address during gaps recovers the transaction that just
   ended (`readDmaChainAt`) — the only reliable path for 1-byte command
   transactions, whose armed→cleared window is shorter than one batch.
3. **Descriptor memory is reused** (same address re-armed per transaction,
   same hal stack descriptor): a gap read therefore returns the PREVIOUS or
   already-NEXT transaction's bytes (a one-beat misalignment, P6-traced:
   stale RASET params and a 1-byte `0x42` hal sentinel appear inside
   windows). Devices triage per window: drop 1-byte segments inside pixel
   streams, take the LAST 1-byte segment for command/parameter windows,
   verify segments against current memory before assembly.
4. **Large transfers arrive as ~4 kB chunks**, each armed and cleared
   faster than any batch size can sample — segment capture only sees some
   chunks. The chunks' descriptor `buf` fields, however, run in exact
   chunk-size steps through the driver's bounce/frame buffer, so the caught
   segments assemble in frame order (sorted by buffer address, kept in the
   largest strictly-contiguous cluster); a frame-buffer snapshot from the
   lowest seen address (page-walk with segment-content self-consistency)
   backfills incomplete windows.
5. **Known limitation (accepted for 0.12.0)**: when a chunk's descriptor
   load completes inside a single batch, that chunk's bytes are missed or a
   stale chunk displaces it — the RGB565 stream then carries a one-chunk
   rotation (pixel COUNT stays exact; values shift). Chunked-push drivers
   (TFT_eSPI-style block writes, the P6 firmware's shape) are far more
   capturable than single-burst esp_lcd draws. Mitigations to try later:
   sub-20 batches under MIN_BATCH, or descriptor-owner/sequence probing.
6. **ARM batch 60 is the capture workpoint**: the W load→fire window
   survives batch 60 (10/10 measured) but not 100 (1/9) — same standing
   cost class as the bit-bang devices; no fine lease is needed for
   no-DMA capture.

| date | change |
|---|---|
| 2026-11-02 | M5 investigation: old verdict overturned, facts measured, probes + firmware P5 added, this guide written |
| 2026-11-03 | 0.12.0 addendum: GDMA segment lifecycle measured, devices shipped (max7219 hwspi, ili9341), limitations recorded |

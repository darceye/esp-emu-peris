#!/usr/bin/env node
/*
 * M5 probe: is hardware SPI (GPSPI2) observable / drivable on the
 * esp-emulator browser wasm (v0.51.0)?
 *
 * Boots the peris_probe firmware (P5 phase = hardware SPI2 master on
 * FSPICLK=11 / MOSI=12 / MISO=13 / CS=14, no-DMA phase A + DMA phase B)
 * and answers:
 *
 *   M5a Are the SPI2 registers readable through read_memory(), and does
 *       the probe see the same W0..W15/CMD/USER/MISC values the firmware
 *       dumps of its own register view?
 *   M5b Do transfers complete (polling, interrupt-driven, DMA)? e==0 on
 *       every ###P5 rx / irq rx / dma done line.
 *   M5c What does the master receive on MISO? The probe holds the MISO
 *       pad LOW for even k and HIGH for odd k inside the marker-bracketed
 *       sleep window — if rx bytes follow the pad the model samples the
 *       pad input (slave models become possible); 0xff/0x00 constants
 *       mean RX is synthetic.
 *   M5d Wiring: GPIO_FUNCn_OUT_SEL_CFG for pins 11..14 (which pad carries
 *       which SPI output signal) + GPIO_FUNC64_IN_SEL_CFG (FSPIQ_IN ← pin),
 *       and whether SPI activity ever shows up in gpio_state() pads.
 *   M5e DMA phase: is the 256-byte payload (i ^ 0xA5) readable back from
 *       the printed guest-RAM buffer address after "dma done"?
 *
 * Usage: node tests/m5_probe.mjs [firmware.bin] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = process.env.ESP_EMU_WWW || path.join(REPO, 'vendor', 'esp-emu-browser', 'www');
if (!existsSync(path.join(WWW, 'pkg', 'esp_emu.js'))) {
    console.error(`error: ${path.join(WWW, 'pkg', 'esp_emu.js')} not found — run "python tools/fetch_esp_emu.py" first`);
    process.exit(1);
}
const FW = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : path.join(REPO, 'tests', 'firmware', 'peris_probe', 'build', 'merged-binary.bin');
if (!existsSync(FW)) {
    console.error(`SKIP m5_probe: firmware ${FW} not found (build peris_probe first)`);
    process.exit(0);
}

/* --- ESP32-C3 MMIO (IDF soc headers, see docs/FEASIBILITY.md) --- */
const GPIO_BASE = 0x60004000;
const SPI2 = 0x60024000;
const MMIO = {
    SPI_CMD: SPI2 + 0x00,
    SPI_ADDR: SPI2 + 0x04,
    SPI_USER: SPI2 + 0x10,
    SPI_MISC: SPI2 + 0x20,
    SPI_W: SPI2 + 0x98,          // W0..W15, 16 x u32
    GPIO_FUNC_OUT_SEL: (pin) => GPIO_BASE + 0x554 + 4 * pin,
    GPIO_FUNC_IN_SEL: (sig) => GPIO_BASE + 0x154 + 4 * sig,
    IO_MUX: { 11: 0x60009030, 12: 0x60009034, 13: 0x60009038, 14: 0x6000903c },
    FSPIQ_IN_SIG: 64,            // C3 GP-SPI MISO input signal
};
const PINS = { sclk: 11, mosi: 12, miso: 13, cs: 14 };

const { initSync, WasmEmulator } = await import(
    pathToFileURL(path.join(WWW, 'pkg', 'esp_emu.js')).href
);
initSync(readFileSync(path.join(WWW, 'pkg', 'esp_emu_bg.wasm')));

const emu = new WasmEmulator('esp32c3');
if (emu.has_default_rom()) emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(FW)));

function readU32(addr) {
    const b = emu.read_memory(addr, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
function readWords(base, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = readU32(base + 4 * i);
    return out;
}
function gpioBits() {
    const s = emu.gpio_state();
    return { out: s[0] >>> 0, oe: s[2] >>> 0 };
}

/* --- results --- */
const res = {
    wiring: { outSel: {}, inSelFspiq: null, ioMux: {} },
    regs: { cmd: null, user: null, misc: null, addr: null, w: [], fwW: [], fwCtrl: {} },
    transfers: [],            // {k, err, rx:[4], wAfter:[w0..w3], padLevel}
    irq: null,                // {err, rx, wAfter}
    dma: { buf: null, len: null, err: null, patternOk: null, firstBytes: null },
    gpioSeen: { oeAny: false, edges: 0 },
    errors: [],
};

let uartBuf = '';
let uartScan = 0;
let inP5 = false;
let curTx = null;             // {k, padLevel}
let lastGpioLevels = null;
let done = false;
let round = -1;
/* fine pass (round 1): while phase A runs, execute small batches and watch
 * CMD.USR — a transfer in flight means W0..W15 still hold the TX payload
 * (the model swaps in RX results when it completes). */
const fine = { active: false, usrSamples: 0, usrBatches: 0, maxUsrRun: 0, run: 0, txSeen: [], batches: 0 };
const micro = { active: false, batches: 0, wSeen: [], caught: null, curK: null };
const timing = { txCycles: null, deltas: [] };
let phaseA = false;

function txPatternIn(words) {
    const bytes = [];
    for (const word of words) for (let b = 0; b < 4; b++) bytes.push((word >>> (8 * b)) & 0xff);
    return [0, 1, 2, 3, 4, 5, 6, 7].some((k) => {
        const pat = [0xA0 | k, (~k) & 0xff, k, 0x5A];
        return pat.every((pb) => bytes.includes(pb));
    }) || bytes.includes(0xC3) && bytes.includes(0x3C) && bytes.includes(0x55) && bytes.includes(0xAA);
}

function snapshotW() { return readWords(MMIO.SPI_W, 16); }

function watchGpioPads() {
    const g = gpioBits();
    let any = false;
    for (const p of Object.values(PINS)) {
        const oe = (g.oe >>> p) & 1;
        const lvl = (g.out >>> p) & 1;
        if (oe) { res.gpioSeen.oeAny = true; any = true; }
        const key = `${p}:${lvl}`;
        if (lastGpioLevels && lastGpioLevels[key] !== lvl && lastGpioLevels[key] !== undefined) res.gpioSeen.edges++;
        (lastGpioLevels ||= {})[key] = lvl;
    }
    return any;
}

function handleMarker(line) {
    let m;
    if ((m = line.match(/^###ROUND (\d+)/))) round = +m[1];
    else if (line === '###P5 start') {
        inP5 = true;
        phaseA = true;
        if (round === 1) fine.active = true;
        for (const [name, pin] of Object.entries(PINS)) {
            res.wiring.outSel[`${name}(${pin})`] = readU32(MMIO.GPIO_FUNC_OUT_SEL(pin));
            if (MMIO.IO_MUX[pin]) res.wiring.ioMux[pin] = readU32(MMIO.IO_MUX[pin]);
        }
        res.wiring.inSelFspiq = readU32(MMIO.GPIO_FUNC_IN_SEL(MMIO.FSPIQ_IN_SIG));
    } else if ((m = line.match(/^###P5 tx k=(\d+)/))) {
        // settle the MISO pad level NOW, inside the firmware's 60 ms sleep
        curTx = { k: +m[1], padLevel: (+m[1] % 2) === 1 };
        emu.gpio_set_input(PINS.miso, curTx.padLevel);
        if (round >= 1) { micro.active = true; micro.curK = +m[1]; timing.txCycles = emu.cycles(); }
    } else if ((m = line.match(/^###P5 rx k=(\d+) e=(-?\d+) b=([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2})/))) {
        if (timing.txCycles !== null) {
            timing.deltas.push({ k: +m[1], cycles: emu.cycles() - timing.txCycles });
            timing.txCycles = null;
        }
        micro.active = false;
        res.transfers.push({
            k: +m[1], err: +m[2],
            rx: [parseInt(m[3], 16), parseInt(m[4], 16), parseInt(m[5], 16), parseInt(m[6], 16)],
            wAfter: snapshotW().slice(0, 4),
            padLevel: curTx ? curTx.padLevel : null,
        });
        curTx = null;
    } else if ((m = line.match(/^###P5 irq rx e=(-?\d+) b=([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2})/))) {
        res.irq = {
            err: +m[1],
            rx: [parseInt(m[2], 16), parseInt(m[3], 16), parseInt(m[4], 16), parseInt(m[5], 16)],
            wAfter: snapshotW().slice(0, 4),
        };
    } else if (line === '###P5 irq tx') {
        /* keep the fine watch running through the interrupt-driven transfer:
         * the blocked task cannot poll CMD, so a timer-completed transfer
         * leaves USR=1 visible across batch boundaries (unlike the polling
         * transfers, where the guest's own spin loop resolves it in-batch) */
        if (round >= 1) { micro.active = true; micro.curK = 'irq'; timing.txCycles = emu.cycles(); }
    } else if (line.startsWith('###P5 irq rx')) {
        if (timing.txCycles !== null) {
            timing.deltas.push({ k: 'irq', cycles: emu.cycles() - timing.txCycles });
            timing.txCycles = null;
        }
        micro.active = false;
    } else if ((m = line.match(/^###P5 w0=0x([0-9a-f]{8}) w1=0x([0-9a-f]{8}) w2=0x([0-9a-f]{8}) w3=0x([0-9a-f]{8})/))) {
        phaseA = false;                      // fine watch ends with phase A
        res.regs.fwW = [m[1], m[2], m[3], m[4]].map((h) => parseInt(h, 16));
        // probe's own view, read right after the marker
        res.regs.w = snapshotW().slice(0, 4);
    } else if ((m = line.match(/^###P5 cmd=0x([0-9a-f]{8}) user=0x([0-9a-f]{8}) misc=0x([0-9a-f]{8}) addr=0x([0-9a-f]{8})/))) {
        res.regs.fwCtrl = {
            cmd: parseInt(m[1], 16), user: parseInt(m[2], 16),
            misc: parseInt(m[3], 16), addr: parseInt(m[4], 16),
        };
        res.regs.cmd = readU32(MMIO.SPI_CMD);
        res.regs.user = readU32(MMIO.SPI_USER);
        res.regs.misc = readU32(MMIO.SPI_MISC);
        res.regs.addr = readU32(MMIO.SPI_ADDR);
    } else if ((m = line.match(/^###P5 dma buf=0x([0-9a-f]+) len=(\d+)/))) {
        res.dma.buf = parseInt(m[1], 16);
        res.dma.len = +m[2];
    } else if ((m = line.match(/^###P5 dma done e=(-?\d+)/))) {
        res.dma.err = +m[1];
        if (res.dma.buf) {
            const bytes = emu.read_memory(res.dma.buf, Math.min(res.dma.len, 256));
            res.dma.firstBytes = Array.from(bytes.slice(0, 16));
            let ok = 0;
            for (let i = 0; i < Math.min(res.dma.len, 256); i++) {
                if (bytes[i] === ((i ^ 0xA5) & 0xff)) ok++;
            }
            res.dma.patternOk = ok === Math.min(res.dma.len, 256);
            res.dma.patternMatches = ok;
        }
        // W regs after the DMA transfer — bypassed (still phase-A residue)?
        res.dma.wAfter = snapshotW().slice(0, 4);
    } else if ((m = line.match(/^###P5 (init|add|dmainit|dmadd)=(-?\d+)/))) {
        res.errors.push(`${m[1]}=${m[2]}`);
    } else if (line === '###P5 end') {
        inP5 = false;
        fine.active = false;
        if (round === 1) done = true;   // round 0 coarse, round 1 fine pass
    }
}

function processUart() {
    for (;;) {
        const nl = uartBuf.indexOf('\n', uartScan);
        if (nl < 0) break;
        const line = uartBuf.slice(uartScan, nl).trim();
        uartScan = nl + 1;
        if (!line.startsWith('###P5') && !line.startsWith('###ROUND')) continue;
        handleMarker(line);
        if (done) return;
    }
}

let batch = 0;
const MICRO = Math.max(1, +(process.env.M5_MICRO || 10));   // W-window batch size
while (!done) {
    const size = micro.active ? MICRO : (fine.active && phaseA) ? 300 : 50000;
    const out = emu.run_batch(size);
    if (out) { uartBuf += out; processUart(); }
    if (done) break;
    if (batch > 2_000_000) throw new Error('probe ran too long without finishing round 1 P5');
    if (micro.active) {
        /* micro pass: small batches — try to straddle the driver's
         * W-load → CMD-fire instruction window (TX payload sits in W0..W15
         * between the hal copy and the transfer completion) */
        micro.batches++;
        const w = snapshotW().slice(0, 4);
        const key = w.join(',');
        if (!micro.wSeen.some((t) => t.key === key)) {
            /* length encoding companions: USER1 (mosi_dlen bits[17:0]) and
             * MS_DLEN (bits[17:0]) read in the same window */
            const user1 = readU32(SPI2 + 0x14), msDlen = readU32(SPI2 + 0x1c);
            micro.wSeen.push({ key, w, k: micro.curK, user1, msDlen });
        }
        if (!micro.caught && txPatternIn(w)) micro.caught = { k: micro.curK, w };
    }
    if (fine.active && phaseA) {
        fine.batches++;
        const cmd = readU32(MMIO.SPI_CMD);
        if (cmd & 1) {                     // transfer in flight: W holds TX
            fine.usrSamples++;
            fine.run++;
            if (fine.run > fine.maxUsrRun) fine.maxUsrRun = fine.run;
            const w = snapshotW().slice(0, 4);
            if (!fine.txSeen.some((t) => t.join(',') === w.join(','))) fine.txSeen.push(w);
        } else {
            if (fine.run > 0) fine.usrBatches++;
            fine.run = 0;
        }
    }
    if (inP5 && !(fine.active && phaseA)) watchGpioPads();
    batch++;
}

/* ---------------------------------------------------------------- verdicts */
const out = [];
const p = (s = '') => { out.push(s); console.log(s); };

p('================ esp-emu-peris M5 probe (hardware SPI) ================');
p(`firmware: ${FW}  batches=${batch} (round 0 coarse, round 1 fine)`);
if (res.errors.length) p(`firmware errors: ${res.errors.join(', ')}`);

const wf = res.wiring.outSel;
p('\n--- M5d wiring (GPIO matrix / IO_MUX, read at P5 start) ---');
for (const [k, v] of Object.entries(wf)) p(`    FUNC_OUT_SEL[${k}] = 0x${v.toString(16)} (low9=${v & 0x1ff})`);
p(`    FUNC64_IN_SEL (FSPIQ/MISO in) = 0x${(res.wiring.inSelFspiq ?? 0).toString(16)} (in_sel=${res.wiring.inSelFspiq & 0x1f}, en=${(res.wiring.inSelFspiq >> 5) & 1})`);
for (const [pin, v] of Object.entries(res.wiring.ioMux)) p(`    IO_MUX[GPIO${pin}] = 0x${v.toString(16)} (mcu_sel=${(v >> 10) & 7})`);

p('\n--- M5a SPI2 register file (probe read vs firmware dump) ---');
const wMatch = res.regs.w.length === 4 && res.regs.fwW.length === 4 &&
    res.regs.w.every((v, i) => v === res.regs.fwW[i]);
p(`    probe W0..W3 = ${res.regs.w.map((v) => '0x' + v.toString(16).padStart(8, '0')).join(' ')}`);
p(`    fw    W0..W3 = ${res.regs.fwW.map((v) => '0x' + v.toString(16).padStart(8, '0')).join(' ')}`);
p(`    CMD probe=0x${(res.regs.cmd ?? 0).toString(16)} fw=0x${(res.regs.fwCtrl.cmd ?? 0).toString(16)}  USER probe=0x${(res.regs.user ?? 0).toString(16)} fw=0x${(res.regs.fwCtrl.user ?? 0).toString(16)}`);
p(`    MISC probe=0x${(res.regs.misc ?? 0).toString(16)} fw=0x${(res.regs.fwCtrl.misc ?? 0).toString(16)}  ADDR probe=0x${(res.regs.addr ?? 0).toString(16)} fw=0x${(res.regs.fwCtrl.addr ?? 0).toString(16)}`);
p(`    M5a register view match: ${wMatch ? 'PASS' : 'FAIL'}`);

p('\n--- M5b transfer completion ---');
const pollErrs = res.transfers.filter((t) => t.err !== 0);
p(`    polling transfers: ${res.transfers.length} (2 rounds x 8), e!=0: ${pollErrs.length}`);
p(`    interrupt transfer e=${res.irq ? res.irq.err : 'MISSING'}${res.irq ? ` rx=${res.irq.rx.map((b) => b.toString(16).padStart(2, '0')).join(' ')}` : ''}`);
p(`    DMA transfer e=${res.dma.err}`);
const m5bOk = res.transfers.length >= 8 && pollErrs.length === 0 && res.irq && res.irq.err === 0 && res.dma.err === 0;
p(`    M5b all transfers complete: ${m5bOk ? 'PASS' : 'FAIL'}`);

p('\n--- M5c MISO source (probe drove pad low=even k, high=odd k) ---');
for (const t of res.transfers.slice(-8)) {
    p(`    k=${t.k} pad=${t.padLevel ? 'high' : 'low '} rx=${t.rx.map((b) => b.toString(16).padStart(2, '0')).join(' ')} w0after=0x${(t.wAfter[0] || 0).toString(16).padStart(8, '0')}`);
}
const followsPad = res.transfers.length === 8 && res.transfers.every((t) =>
    t.rx.every((b) => t.padLevel ? b === 0xff : b === 0x00));
const constFF = res.transfers.length > 0 && res.transfers.every((t) => t.rx.every((b) => b === 0xff));
const const00 = res.transfers.length > 0 && res.transfers.every((t) => t.rx.every((b) => b === 0x00));
p(`    M5c: ${followsPad ? 'PAD-SAMPLED (gpio_set_input reaches the SPI master!)' : constFF ? 'constant 0xff (unconnected model)' : const00 ? 'constant 0x00' : 'OTHER — see table'}`);

p('\n--- M5d pad visibility in gpio_state() during P5 ---');
p(`    any SPI pad oe ever=${res.gpioSeen.oeAny} level edges=${res.gpioSeen.edges} (expected 0/absent: matrix-routed signals are invisible — M0)`);

p('\n--- M5e DMA payload in guest RAM ---');
if (res.dma.buf) {
    p(`    buf=0x${res.dma.buf.toString(16)} len=${res.dma.len} e=${res.dma.err} pattern(i^0xA5) ${res.dma.patternOk ? `PASS (${res.dma.patternMatches}/256)` : `PARTIAL (${res.dma.patternMatches}/256)`}`);
    p(`    first16: ${res.dma.firstBytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    p(`    W0..W3 after DMA xfer: ${(res.dma.wAfter || []).map((v) => '0x' + v.toString(16).padStart(8, '0')).join(' ')} (phase-A residue = W bypassed by DMA)`);
} else {
    p('    no DMA marker — check firmware');
}

p('\n--- M5f no-DMA TX mid-transfer window (round-1 fine pass, 300-instr batches) ---');
p(`    fine batches=${fine.batches}  CMD.USR=1 samples=${fine.usrSamples} in ${fine.usrBatches} transfers  longest run=${fine.maxUsrRun} batches`);
p(`    distinct W0..W3 while USR=1: ${fine.txSeen.length}`);
for (let i = 0; i < Math.min(fine.txSeen.length, 12); i++) {
    p(`      w=[${fine.txSeen[i].map((v) => '0x' + v.toString(16).padStart(8, '0')).join(' ')}]`);
}
/* the firmware sends {0xA0|k,~k,k,0x5A} per transfer; a caught TX window
 * must contain those bytes regardless of intra-word packing */
const txCaught = fine.txSeen.some((w) => {
    const bytes = [];
    for (const word of w) for (let b = 0; b < 4; b++) bytes.push((word >>> (8 * b)) & 0xff);
    return [0, 1, 2, 3, 4, 5, 6, 7].some((k) => {
        const pat = [0xA0 | k, (~k) & 0xff, k, 0x5A];
        return pat.every((pb) => bytes.includes(pb));
    });
});
p(`    M5f TX payload visible mid-transfer: ${fine.usrSamples > 0 && txCaught ? 'PASS' : fine.usrSamples === 0 ? 'FAIL (never caught USR=1)' : 'FAIL (USR seen but payload not)'}`);

p(`\n--- M5g micro pass (${MICRO}-instr batches across the W-load -> CMD-fire window) ---`);
p(`    micro batches=${micro.batches}  distinct W states=${micro.wSeen.length}`);
for (let i = 0; i < Math.min(micro.wSeen.length, 10); i++) {
    const t = micro.wSeen[i];
    p(`      k=${String(t.k).padEnd(3)} w=[${t.w.map((v) => '0x' + v.toString(16).padStart(8, '0')).join(' ')}] user1=0x${(t.user1 ?? 0).toString(16)} msDlen=0x${(t.msDlen ?? 0).toString(16)}`);
}
p(`    M5g TX payload caught before CMD fire: ${micro.caught ? `PASS (k=${micro.caught.k})` : 'FAIL'}`);
if (timing.deltas.length) {
    p('\n--- guest cycles between tx and rx markers (60 ms sleep = 9.6 M nominal) ---');
    for (const d of timing.deltas) p(`    k=${String(d.k).padEnd(3)} +${(d.cycles / 1000).toFixed(0)}k cycles`);
}

if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));

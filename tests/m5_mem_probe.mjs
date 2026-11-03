#!/usr/bin/env node
/*
 * M5 memory probe — full sequence:
 *
 *   round 0  locate the GPSPI2 model struct in wasm linear memory (scan for
 *            the distinctive USER value; verify writability through to
 *            read_memory()).
 *   round 1  learn the completion protocol: single-instruction batches
 *            around the interrupt-driven transfer; snapshot the struct at
 *            the W0 TX->0xffffffff flip (transfer completed, guest has not
 *            consumed it yet) and again right after the guest's read; the
 *            word diff = the "pending" flags the read path consumes.
 *   round 2  inject: at the flip write our RX bytes into W0..W3 and apply
 *            the learned after-state to every diffed word except W itself.
 *            If the firmware prints "###P5 irq rx ... b=d1 c0 ff ee",
 *            hardware-SPI input is host-injectable.
 *
 * Usage: node tests/m5_mem_probe.mjs [firmware.bin]
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = process.env.ESP_EMU_WWW || path.join(REPO, 'vendor', 'esp-emu-browser', 'www');
const FW = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : path.join(REPO, 'tests', 'firmware', 'peris_probe', 'build', 'merged-binary.bin');
if (!existsSync(path.join(WWW, 'pkg', 'esp_emu.js'))) { console.error('missing wasm bundle'); process.exit(1); }
if (!existsSync(FW)) { console.error(`SKIP: firmware ${FW} not found`); process.exit(0); }

const SPI2 = 0x60024000;
const REG = { CMD: SPI2 + 0x00, ADDR: SPI2 + 0x04, USER: SPI2 + 0x10, MISC: SPI2 + 0x20, W: SPI2 + 0x98 };
const IRQ_TX_W0 = 0xAA553CC3;                     // {0xC3,0x3C,0x55,0xAA} packing (M5g)
const RX_BYTES = [0xD1, 0xC0, 0xFF, 0xEE];

/* ---- capture the live wasm instance the glue creates ------------------- */
const OrigInstance = WebAssembly.Instance;
let captured = null;
WebAssembly.Instance = function (module, imports) {
    captured = Reflect.construct(OrigInstance, [module, imports]);
    return captured;
};
const { initSync, WasmEmulator } = await import(
    pathToFileURL(path.join(WWW, 'pkg', 'esp_emu.js')).href
);
initSync(readFileSync(path.join(WWW, 'pkg', 'esp_emu_bg.wasm')));
WebAssembly.Instance = OrigInstance;
if (!captured) { console.error('failed to capture the wasm instance'); process.exit(1); }

const mem = captured.exports.memory;
const emu = new WasmEmulator('esp32c3');
if (emu.has_default_rom()) emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(FW)));

function readU32(addr) {
    const b = emu.read_memory(addr, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
let dv = new DataView(mem.buffer);
function memView() {
    if (dv.buffer !== mem.buffer || dv.byteLength !== mem.buffer.byteLength) dv = new DataView(mem.buffer);
    return dv;
}
const mRead = (a) => memView().getUint32(a, true);
const mWrite = (a, v) => memView().setUint32(a, v >>> 0, true);

/* ---- state -------------------------------------------------------------- */
const S = {
    round: -1, done: false, phase: 'coarse',      // coarse | micro | done
    structBase: null, w0Field: null, scanned: false,
    seenTx: false, flipped: false,
    snapBefore: null, snapAfter: null, diff: [],
    irqRxLines: [], microBatches: 0, wrote: false,
};
const SNAP_LO = -0x40, SNAP_HI = 0x140;          // window around struct base
function snapshot() {
    const out = [];
    for (let off = SNAP_LO; off < SNAP_HI; off += 4) out.push(mRead(S.structBase + off));
    return out;
}
function applyDiff(excludeW) {
    for (const d of S.diff) {
        if (excludeW && d.off >= 0x98 && d.off < 0xD8) continue;   // W0..W15 handled ourselves
        mWrite(S.structBase + d.off, d.after);
    }
}

function locateFields() {
    const userReg = readU32(REG.USER), miscReg = readU32(REG.MISC);
    const view = new Uint32Array(mem.buffer);
    const hits = [];
    for (let i = 0; i < view.length; i++) if (view[i] === userReg) hits.push(i * 4);
    console.log(`anchor USER=0x${userReg.toString(16)} -> ${hits.length} hits; verifying...`);
    for (const a of hits) {
        const base = a - 0x10;
        const orig = mRead(a);
        mWrite(a, 0x11223344);
        const backed = readU32(REG.USER) === 0x11223344;
        mWrite(a, orig);
        if (backed && mRead(base + 0x20) === miscReg) { S.structBase = base; break; }
        if (backed) { S.structBase = base; break; }
    }
    if (S.structBase === null) { console.log('register file NOT memory-backed'); return; }
    S.w0Field = S.structBase + 0x98;
    /* confirm W0 reflection once (idle moment) */
    const orig = mRead(S.w0Field);
    mWrite(S.w0Field, 0xA1B2C3D4);
    const ok = readU32(REG.W) === 0xA1B2C3D4;
    mWrite(S.w0Field, orig);
    console.log(`struct base 0x${S.structBase.toString(16)} W0 field ${ok ? 'confirmed' : 'NOT reflecting'}`);
    if (!ok) S.w0Field = null;
}

function handleMarker(line) {
    let m;
    if ((m = line.match(/^###ROUND (\d+)/))) S.round = +m[1];
    else if (line.startsWith('###P5 w0=') && !S.scanned) {
        S.scanned = true;
        locateFields();
    } else if (line === '###P5 irq tx' && S.round >= 1 && S.w0Field && S.phase === 'coarse') {
        S.phase = 'micro';
        S.seenTx = false; S.flipped = false; S.wrote = false;
    } else if ((m = line.match(/^###P5 irq rx e=(-?\d+) b=(..) (..) (..) (..)/))) {
        S.irqRxLines.push(`r${S.round}: ${line}`);
        if (S.phase === 'micro') {
            if (S.snapBefore && !S.snapAfter) {
                S.snapAfter = snapshot();
                S.diff = [];
                for (let i = 0; i < S.snapBefore.length; i++) {
                    if (S.snapBefore[i] !== S.snapAfter[i]) {
                        S.diff.push({ off: SNAP_LO + 4 * i, before: S.snapBefore[i], after: S.snapAfter[i] });
                    }
                }
                console.log(`struct diff across the guest's consumption (${S.diff.length} words):`);
                for (const d of S.diff) {
                    console.log(`    +0x${(d.off >>> 0).toString(16)}: 0x${d.before.toString(16)} -> 0x${d.after.toString(16)}`);
                }
            }
            S.phase = 'coarse';
        }
    } else if (line === '###P5 end' && S.round >= 2) S.done = true;
}
function processUart() {
    for (;;) {
        const nl = uartBuf.indexOf('\n', uartScan);
        if (nl < 0) break;
        const line = uartBuf.slice(uartScan, nl).trim();
        uartScan = nl + 1;
        if (line.startsWith('###P5') || line.startsWith('###ROUND')) handleMarker(line);
        if (S.done) return;
    }
}
let uartBuf = '', uartScan = 0;

let batch = 0;
while (!S.done) {
    const size = S.phase === 'micro' ? 1 : 50000;
    const out = emu.run_batch(size);
    if (out) { uartBuf += out; processUart(); }
    if (S.done) break;
    if (batch++ > 3_000_000) throw new Error('probe ran too long');
    if (S.phase === 'micro') {
        S.microBatches++;
        const w0 = mRead(S.w0Field);
        if (!S.seenTx && w0 === IRQ_TX_W0) S.seenTx = true;
        else if (S.seenTx && !S.flipped && w0 === 0xFFFFFFFF) {
            S.flipped = true;
            if (S.round === 1) {
                S.snapBefore = snapshot();        // completed, not yet consumed
            } else if (S.round === 2) {
                /* inject: our RX bytes + the learned consumed-state flags */
                mWrite(S.w0Field,
                    ((RX_BYTES[3] << 24) | (RX_BYTES[2] << 16) | (RX_BYTES[1] << 8) | RX_BYTES[0]) >>> 0);
                applyDiff(true);
                S.wrote = true;
            }
        }
    }
}

/* ---- verdicts ------------------------------------------------------------ */
console.log('\n================ M5 memory probe ================');
console.log(`struct: ${S.structBase ? '0x' + S.structBase.toString(16) : 'not found'}  W0: ${S.w0Field ? '0x' + S.w0Field.toString(16) : '-'}  micro batches=${S.microBatches}  wrote=${S.wrote}`);
console.log('irq rx lines seen:');
for (const l of S.irqRxLines) console.log(`    ${l}`);
const last = S.irqRxLines[S.irqRxLines.length - 1] || '';
const proven = last.includes('b=d1 c0 ff ee');
console.log(`RX INJECTION: ${proven ? 'PROVEN — guest received host-written bytes over hardware SPI' : 'NOT proven'}`);

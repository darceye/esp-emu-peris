#!/usr/bin/env node
/*
 * M5 GDMA probe — can a host-side device find the SPI DMA TX buffer by
 * walking the GDMA out-descriptor chain (no firmware cooperation)?
 *
 * Boots the peris_probe firmware; at the P5 DMA phase ("###P5 dma buf=…")
 * it snapshots the GDMA register block around the transfer and, after
 * "###P5 dma done", scans every register value that looks like a DRAM
 * pointer, reads a 12-byte lldesc at that address ({size,length,…
 * eof,owner}, buf, next) and validates it against the known payload
 * (256 × i^0xA5 at the marker-printed buffer address).
 *
 * Success = a register always names the first descriptor, whose chain
 * covers the payload — the SPI-M5 §8 open item, prerequisite for the
 * display device's DMA pixel path.
 *
 * Usage: node tests/m5_gdma_probe.mjs [firmware.bin]
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

const GDMA_BASE = 0x6003f000;
const GDMA_SPAN = 0x300;          // covers ch0..ch2 on C3
const DRAM_LO = 0x3fc00000, DRAM_HI = 0x3fd00000;

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
function isDram(v) { return v >= DRAM_LO && v < DRAM_HI; }

let uartBuf = '', uartScan = 0, done = false, round = -1;
const dma = { buf: null, len: null, regDumps: [], walked: [] };

function snapshotRegs(tag) {
    const regs = {};
    for (let off = 0; off < GDMA_SPAN; off += 4) {
        const v = readU32(GDMA_BASE + off);
        if (v !== 0) regs[off] = v;
    }
    dma.regDumps.push({ tag, regs });
}

/** Validate a 12-byte lldesc at `d`: {w0, buf, next}. */
function probeDesc(d) {
    const w0 = readU32(d), buf = readU32(d + 4), next = readU32(d + 8);
    const size = w0 & 0xfff, length = (w0 >> 12) & 0xfff;
    const eof = (w0 >> 30) & 1, owner = (w0 >> 31) & 1;
    let pattern = null;
    if (isDram(buf)) {
        const b = emu.read_memory(buf, Math.min(length || 16, 16));
        pattern = Array.from(b.slice(0, 4)).every((v, i) => v === ((i ^ 0xA5) & 0xff));
    }
    return { d, size, length, eof, owner, buf, next, pattern, w0 };
}

/** Walk the chain from a first descriptor; returns {descs, totalBytes, reaches}. */
function walkChain(first, maxLen) {
    const descs = [];
    let total = 0, d = first, guard = 0;
    while (isDram(d) && guard++ < 32) {
        const info = probeDesc(d);
        descs.push(info);
        total += info.length;
        if (info.eof || info.next === 0 || !isDram(info.next)) break;
        d = info.next;
    }
    return { descs, total };
}

function handleMarker(line) {
    let m;
    if ((m = line.match(/^###ROUND (\d+)/))) round = +m[1];
    else if ((m = line.match(/^###P5 dma buf=0x([0-9a-f]+) len=(\d+)/))) {
        dma.buf = parseInt(m[1], 16);
        dma.len = +m[2];
        snapshotRegs('pre');                    // during the 60 ms sleep
        inDma = true;                           // fine batches through the window
    } else if (line.startsWith('###P5 dma done')) {
        snapshotRegs('post');                   // after completion
        analyse();
        if (round >= 0) done = true;            // one DMA phase is enough
    } else if (line === '###P5 dmainit' || line.startsWith('###P5 dmainit=')) {
        console.log('DMA re-init failed — probe unusable this run');
    }
}
function processUart() {
    for (;;) {
        const nl = uartBuf.indexOf('\n', uartScan);
        if (nl < 0) break;
        const line = uartBuf.slice(uartScan, nl).trim();
        uartScan = nl + 1;
        if (line.startsWith('###P5') || line.startsWith('###ROUND')) handleMarker(line);
        if (done) return;
    }
}

/* run fine batches through the DMA window; snapshot the first register state
 * that differs from "pre" — that is the transfer in flight (the outlink
 * register then names the first descriptor, possibly 20-bit-truncated) */
let batch = 0, inDma = false, midTaken = false;
while (!done) {
    const out = emu.run_batch(inDma ? 300 : 50000);
    if (out) { uartBuf += out; processUart(); }
    if (done) break;
    if (batch++ > 600_000) throw new Error('probe ran too long');
    if (inDma && !midTaken) {
        const regs = {};
        for (let off = 0; off < GDMA_SPAN; off += 4) {
            const v = readU32(GDMA_BASE + off);
            if (v !== 0) regs[off] = v;
        }
        const pre = dma.regDumps[0]?.regs ?? {};
        const changed = Object.keys(regs).some((k) => regs[k] !== pre[k]);
        if (changed) { dma.regDumps.push({ tag: 'mid', regs }); midTaken = true; }
    }
}

function analyse() {
    console.log(`\n============ GDMA out-descriptor walk (payload 0x${dma.buf.toString(16)}, ${dma.len} B) ============`);
    for (const { tag, regs } of dma.regDumps) {
        console.log(`--- registers ${tag} (nonzero, GDMA +0x00..+0x2ff) ---`);
        for (const [off, v] of Object.entries(regs)) {
            const cand = isDram(v) ? v : (v >>> 0) < 0x100000 && (v >>> 0) > 0x1000 ? (0x3fc00000 | v) : null;
            const hint = cand ? `  <- desc? 0x${cand.toString(16)}` : '';
            console.log(`    +0x${(+off).toString(16).padStart(3, '0')} = 0x${(v >>> 0).toString(16)}${hint}`);
        }
    }
    /* try every plausible descriptor pointer (absolute DRAM or 20-bit low
     * halves, absolute first — a wrong guess just fails validation) */
    const seen = new Set();
    for (const { regs } of dma.regDumps) {
        for (const raw of Object.values(regs)) {
            const cands = [];
            if (isDram(raw)) cands.push(raw);
            if (raw > 0x1000 && raw < 0x100000) cands.push(0x3fc00000 | raw);
            for (const v of cands) {
                if (seen.has(v)) continue;
                seen.add(v);
                const info = probeDesc(v);
                if (!isDram(info.buf) || info.length === 0 || info.length > 4095) continue;
                const chain = walkChain(v, 4096);
                const reaches = chain.total >= dma.len || chain.descs.some((x) => x.buf === dma.buf);
                console.log(`desc@0x${v.toString(16)}: len=${info.length} eof=${info.eof} owner=${info.owner}`
                    + ` buf=0x${info.buf.toString(16)} pattern=${info.pattern}`
                    + ` chain(${chain.descs.length})=${chain.total}B reachesPayload=${reaches}`);
                if (reaches) dma.walked.push({ first: v, chain });
            }
        }
    }
    const ok = dma.walked.length > 0;
    console.log(`\nGDMA WALK: ${ok ? `PASS — first desc 0x${dma.walked[0].first.toString(16)}, chain covers ${dma.walked[0].chain.total} B` : 'FAIL (no register named the payload chain)'}`);
}

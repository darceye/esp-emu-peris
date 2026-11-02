#!/usr/bin/env node
/*
 * M0 feasibility probe for esp-emu-peris.
 *
 * Loads the esp-emulator browser wasm bundle in Node (via initSync, no
 * fetch needed) and runs the peris_probe firmware against it, answering:
 *
 *   Q1a Are guest GPIO outputs observable through gpio_state()?  (P1 blink)
 *   Q1b Can gpio_set_input() drive a pad *and* raise guest interrupts?
 *       (P1: probe toggles GPIO3, firmware counts falling-edge ISRs)
 *   Q2a Is LEDC PWM observable at the pad register, and does a statistical
 *       duty estimate at coarse batch size track the real duty?
 *   Q2b Are LEDC duty registers readable through read_memory()?
 *   Q3a Is the RMT/WS2812 waveform observable at the pin level using small
 *       run_batch() sizes ("fine sampling")?
 *   Q3b Is the RMT channel RAM readable and decodable via read_memory()?
 *
 * Usage: node tests/m0_probe.mjs [firmware.bin] [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = process.env.ESP_EMU_WWW || path.join(REPO, 'vendor', 'esp-emu-browser', 'www');
if (!existsSync(path.join(WWW, 'pkg', 'esp_emu.js'))) {
    console.error(`error: ${path.join(WWW, 'pkg', 'esp_emu.js')} not found — run "npm run build" (or "python tools/fetch_esp_emu.py") first, or set ESP_EMU_WWW`);
    process.exit(1);
}
const FW = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : path.join(REPO, 'tests/firmware/peris_probe/build/merged-binary.bin');
if (!existsSync(FW)) {
    console.error(`SKIP m0_probe: probe firmware ${path.relative(REPO, FW)} not found ` +
        `(gitignored ESP-IDF artifact — build with tests/firmware/build.ps1, or pass one:` +
        ` node tests/m0_probe.mjs <merged.bin>)`);
    process.exit(0);
}

// --- ESP32-C3 MMIO map (from IDF soc headers, see docs/FEASIBILITY.md) ---
const GPIO_BASE = 0x60004000;
const MMIO = {
    GPIO_FUNC_OUT_SEL: (pin) => GPIO_BASE + 0x554 + 4 * pin,
    IO_MUX: (pin) => 0x60009000 + 0x04 + 4 * pin, // valid for GPIO0..11
    LEDC_CH0_DUTY: 0x60019008,
    LEDC_CH0_DUTY_R: 0x60019010,
    RMT_CH0CONF0: 0x60016010,
    RMTMEM_CH0: 0x60016400,
    RMTMEM_CH0_WORDS: 48,
};
const PIN_BLINK = 8, PIN_BTN = 3, PIN_LEDC = 9, PIN_RMT = 4;

// ---------------------------------------------------------------- wasm boot
const { initSync, WasmEmulator } = await import(
    pathToFileURL(path.join(WWW, 'pkg/esp_emu.js')).href
);
initSync(readFileSync(path.join(WWW, 'pkg/esp_emu_bg.wasm')));

const emu = new WasmEmulator('esp32c3');
if (emu.has_default_rom()) emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(FW)));

const CYCLES_PER_US = emu.cycles_per_us();

function readU32(addr) {
    const b = emu.read_memory(addr, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
function gpioBits() {
    const s = emu.gpio_state(); // [out_lo, out_hi, enable_lo, enable_hi]
    return { out: s[0] >>> 0, oe: s[2] >>> 0 };
}

// ------------------------------------------------------------- WS2812 decode
/* Decode a level-run sequence [{level,us}] into WS2812 frames. High run
 * >0.6us is '1', else '0'; a low run >40us latches the frame. */
function decodeWs2812Runs(runs) {
    const frames = [];
    let bits = [];
    const flush = () => {
        if (bits.length >= 24) {
            const n = Math.floor(bits.length / 24) * 24;
            const colors = [];
            for (let led = 0; led < n / 24; led++) {
                let v = 0;
                for (let b = 0; b < 24; b++) v = (v << 1) | bits[led * 24 + b];
                const rgb = (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | (v & 0xff);
                colors.push(rgb);
            }
            frames.push(colors);
        }
        bits = [];
    };
    for (const r of runs) {
        if (r.level === 1) bits.push(r.us > 0.6 ? 1 : 0);
        else if (r.us > 40) flush();
    }
    flush();
    return frames;
}
/* A decoded frame matches when at least 2 of its LEDs equal the colour the
 * firmware logged for that burst. Ping-pong RAM reuse splits a frame into
 * multiple reset-delimited groups of 1-2 LEDs, so the threshold must be 2. */
function frameMatches(colors, expected) {
    return Array.isArray(colors) && colors.filter((c) => c === expected).length >= 2;
}

// --------------------------------------------------------------- state & bag
const res = {
    cyclesPerUs: CYCLES_PER_US,
    q1a: { blinkTransitions: 0, blinkSamplesTotal: 0, oeSeen: false },
    q1b: { drivenFallingEdges: 0, firmwareCount: null },
    q2a: { pinOeEver: false, pinOutToggled: false, ramp: [], flats: [] },
    q2b: { dutyRegSamples: 0, dutyRTracking: 0, funcOutSel9: null, ioMux9: null },
    q3: {
        pinOeEver: false, pinEdgesTotal: 0, pinFrames: [], memSnapshots: 0, memFrames: [],
        expectedColors: [], pinMatched: [], memMatched: [], rmtConf0: null, funcOutSel4: null,
    },
    perf: { coarseMips: null, fineMips: null, coarseBatches: 0, fineBatches: 0 },
};

let uartBuf = '';
let uartScan = 0;
let phase = 'boot';
let roundNo = null;
let sawReady = false;
let done = false;
let currentDutyCtx = null; // {duty, tag?} for the current P2 step
let dutyStep = null;       // {duty, tag, high, oe, total}
let lastBlink = -1;
let lastLedcLevel = -1;
let inFine = false;
let batch = 0;
let fineBatches = 0, fineCycles = 0;
const tCoarse0 = Date.now();
const cCoarse0 = emu.cycles();
const tFine0 = Date.now();

function pushDutyStep() {
    if (!dutyStep || dutyStep.total === 0) return;
    const est = dutyStep.oe ? +(dutyStep.high / dutyStep.oe).toFixed(3) : null;
    const row = { duty: dutyStep.duty, samples: dutyStep.total, est };
    if (dutyStep.tag) res.q2a.flats.push({ ...row, tag: dutyStep.tag });
    else res.q2a.ramp.push(row);
    dutyStep = null;
}

function handleMarker(line) {
    let m;
    if (line === '###READY') sawReady = true;
    else if ((m = line.match(/^###ROUND (\d+)/))) roundNo = +m[1];
    else if (line === '###P1 start') {
        phase = 'P1';
        emu.gpio_set_input(PIN_BTN, true); // pull-up idle level
        res.q1a.blinkTransitions = 0;
        lastBlink = -1;
    } else if ((m = line.match(/^###P1 end btn=(\d+)/))) {
        res.q1b.firmwareCount = +m[1];
        phase = 'idle';
    } else if (line === '###P2 start') {
        phase = 'P2';
        res.q2b.funcOutSel9 = readU32(MMIO.GPIO_FUNC_OUT_SEL(PIN_LEDC));
        res.q2b.ioMux9 = readU32(MMIO.IO_MUX(PIN_LEDC));
    } else if ((m = line.match(/^###P2 d=(\d+)/))) {
        pushDutyStep();
        dutyStep = { duty: +m[1], tag: null, high: 0, oe: 0, total: 0 };
    } else if ((m = line.match(/^###P2 flat=(\w+) d=(\d+)/))) {
        pushDutyStep();
        dutyStep = { duty: +m[2], tag: m[1], high: 0, oe: 0, total: 0 };
    } else if (line === '###P2 end') {
        pushDutyStep();
        phase = 'idle';
    } else if (line === '###P3 start') {
        phase = 'P3';
        res.q3.rmtConf0 = readU32(MMIO.RMT_CH0CONF0);
        res.q3.funcOutSel4 = readU32(MMIO.GPIO_FUNC_OUT_SEL(PIN_RMT));
    } else if ((m = line.match(/^###P3 f=(\d+) c=0x([0-9a-fA-F]{6})/))) {
        const expected = parseInt(m[2], 16);
        res.q3.expectedColors.push(expected);
        if (!inFine) fineSampleWindow(8_000_000, expected);
    } else if (line === '###P3 end') {
        phase = 'idle';
        if (roundNo === 0) done = true; // one round is enough
    }
}

function processUart() {
    for (;;) {
        const nl = uartBuf.indexOf('\n', uartScan);
        if (nl < 0) break;
        const line = uartBuf.slice(uartScan, nl).trim();
        uartScan = nl + 1;
        if (!line.startsWith('###')) continue;
        handleMarker(line);
        if (done) return;
    }
}

// ------------------------------------------------------- fine (pin) sampling
/* Run small run_batch(40) steps for up to maxCycles emulated cycles,
 * recording level changes on PIN_RMT, then decode WS2812 from the runs. */
function fineSampleWindow(maxCycles, expected) {
    inFine = true;
    const startCycles = emu.cycles();
    const changes = []; // [cycles, level]; level -1 = pad not driven
    let last = null;
    while (emu.cycles() - startCycles < maxCycles) {
        const out = emu.run_batch(40);
        if (out) { uartBuf += out; processUart(); if (done) break; }
        const g = gpioBits();
        const oe = (g.oe >>> PIN_RMT) & 1;
        const lvl = oe ? (g.out >>> PIN_RMT) & 1 : -1;
        if (oe) res.q3.pinOeEver = true;
        if (lvl !== last) { changes.push([emu.cycles(), lvl]); last = lvl; }
        fineBatches++; fineCycles += 40;
    }
    if (changes.length > 1) res.q3.pinEdgesTotal += changes.length - 1;

    const runs = [];
    for (let i = 0; i < changes.length - 1; i++) {
        const [t0, l0] = changes[i];
        const t1 = changes[i + 1][0];
        if (l0 === -1) continue; // undriven gap
        runs.push({ level: l0, us: (t1 - t0) / CYCLES_PER_US });
    }
    const frames = decodeWs2812Runs(runs);
    for (const f of frames) {
        if (!res.q3.pinFrames.some((x) => JSON.stringify(x) === JSON.stringify(f))) res.q3.pinFrames.push(f);
        if (frameMatches(f, expected)) res.q3.pinMatched.push(expected);
    }
    inFine = false;
}

// RMT symbol words -> level runs (us); stop at an all-zero word (TX end).
function rmtWordsToRuns(words) {
    const runs = [];
    for (const w of words) {
        const d0 = w & 0x7fff, l0 = (w >> 15) & 1;
        const d1 = (w >> 16) & 0x7fff, l1 = (w >> 31) & 1;
        if (d0 === 0 && d1 === 0) break;
        if (d0) runs.push({ level: l0, us: d0 * 0.1 });
        if (d1) runs.push({ level: l1, us: d1 * 0.1 });
    }
    return runs;
}

/* Decode RMT channel RAM into WS2812 frames. Symbols persist in RAM after
 * TX (verified in M0); resync on the low "reset" symbol (>=30 us low),
 * skip zero padding words, bits follow as high-run durations. bitOffset
 * drops the first k bits of each resync'd group (the ping-pong write order
 * can shift the stream a few bits relative to the LED boundary). */
function decodeRmtMemFrames(words, bitOffset = 0) {
    const frames = [];
    let bits = [];
    const flush = () => {
        let b = bits;
        if (b.length >= 24) {
            // The ping-pong write order can leave the first few bits of a
            // frame outside the snapshot; prepending k zeros restores the
            // LED byte grid. Try all k in the caller.
            if (bitOffset > 0) b = Array(bitOffset).fill(0).concat(b);
            const n = Math.floor(b.length / 24) * 24;
            const colors = [];
            for (let led = 0; led < n / 24; led++) {
                let v = 0;
                for (let i = 0; i < 24; i++) v = (v << 1) | b[led * 24 + i];
                const rgb = (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | (v & 0xff);
                colors.push(rgb);
            }
            frames.push(colors);
        }
        bits = [];
    };
    for (const w of words) {
        const d0 = w & 0x7fff, l0 = (w >> 15) & 1;
        const d1 = (w >> 16) & 0x7fff, l1 = (w >> 31) & 1;
        if (d0 === 0 && d1 === 0) continue; // padding between ping-pong blocks
        if (l0 === 0 && d0 >= 300) { // reset symbol: frame boundary
            flush();
            continue;
        }
        if (l0 === 1) bits.push(d0 * 0.1 > 0.6 ? 1 : 0);
        if (l1 === 1) bits.push(d1 * 0.1 > 0.6 ? 1 : 0);
    }
    flush();
    return frames;
}

// --------------------------------------------------------------- coarse loop
while (!done) {
    const out = emu.run_batch(50000);
    if (out) { uartBuf += out; processUart(); }
    if (done) break;
    if (!sawReady && batch > 6000) throw new Error('firmware never printed ###READY — boot failed?');
    if (batch > 600_000) throw new Error('probe ran too long without finishing a round');
    const g = gpioBits();

    if (phase === 'P1') {
        const oe8 = (g.oe >>> PIN_BLINK) & 1;
        const b8 = (g.out >>> PIN_BLINK) & 1;
        if (oe8) res.q1a.oeSeen = true;
        if (b8 !== lastBlink) { res.q1a.blinkTransitions++; lastBlink = b8; }
        res.q1a.blinkSamplesTotal++;
        // Drive GPIO3: falling edge every 64 batches, released high again 32
        // batches later. Counted by the firmware ISR (vTaskDelay durations
        // are cycle-compressed in the emulator, so use a dense cadence).
        if (batch % 64 === 0) { emu.gpio_set_input(PIN_BTN, false); res.q1b.drivenFallingEdges++; }
        else if (batch % 64 === 32) emu.gpio_set_input(PIN_BTN, true);
    }

    if (phase === 'P2') {
        const oe9 = (g.oe >>> PIN_LEDC) & 1;
        const b9 = (g.out >>> PIN_LEDC) & 1;
        if (oe9) res.q2a.pinOeEver = true;
        if (b9 !== lastLedcLevel) { lastLedcLevel = b9; res.q2a.pinOutToggled = true; }
        if (dutyStep) {
            dutyStep.total++;
            if (oe9) { dutyStep.oe++; if (b9) dutyStep.high++; }
        }
        if (batch % 16 === 0) {
            res.q2b.dutyRegSamples++;
            const dutyR = readU32(MMIO.LEDC_CH0_DUTY_R);
            // C3 DUTY_CH0 field is duty << 4 (bits [18:4]) — verified in M0.
            if (dutyStep && Math.abs(dutyR - dutyStep.duty * 16) <= 64) res.q2b.dutyRTracking++;
        }
    }

    if (phase === 'P3' && batch % 6 === 0) {
        const bytes = emu.read_memory(MMIO.RMTMEM_CH0, MMIO.RMTMEM_CH0_WORDS * 4);
        const words = new Uint32Array(48);
        for (let w = 0; w < 48; w++) {
            words[w] = (bytes[w * 4] | (bytes[w * 4 + 1] << 8) | (bytes[w * 4 + 2] << 16) | (bytes[w * 4 + 3] << 24)) >>> 0;
        }
        if (words.filter((w) => w !== 0).length >= 10) {
            res.q3.memSnapshots++;
            for (let off = 0; off < 8; off++) {
                for (const f of decodeRmtMemFrames(words, off)) {
                    if (!res.q3.memFrames.some((x) => JSON.stringify(x) === JSON.stringify(f))) res.q3.memFrames.push(f);
                    for (const exp of res.q3.expectedColors) {
                        if (frameMatches(f, exp) && !res.q3.memMatched.includes(exp)) res.q3.memMatched.push(exp);
                    }
                }
            }
        }
    }
    batch++;
}
pushDutyStep();

res.perf.coarseBatches = batch;
const coarseMs = Date.now() - tCoarse0;
const coarseCycles = emu.cycles() - cCoarse0;
res.perf.coarseMips = +((coarseCycles / coarseMs / 1000).toFixed(1));
const fineMs = Math.max(Date.now() - tFine0 - coarseMs, 1);
res.perf.fineBatches = fineBatches;
res.perf.fineMips = +((fineCycles / fineMs / 1000).toFixed(1));

// ------------------------------------------------------------------ verdicts
const out = [];
const p = (s = '') => { out.push(s); console.log(s); };

p('================ esp-emu-peris M0 probe ================');
p(`firmware: ${FW}`);
p(`cycles_per_us=${CYCLES_PER_US}  coarse=${batch} batches(${res.perf.coarseMips} MIPS)  fine=${fineBatches}x40(${res.perf.fineMips} MIPS)`);

const q1aOk = res.q1a.blinkTransitions >= 6 && res.q1a.oeSeen;
p(`\nQ1a GPIO output via gpio_state(): ${q1aOk ? 'PASS' : 'FAIL'}`);
p(`    blink transitions=${res.q1a.blinkTransitions} oe=${res.q1a.oeSeen} samples=${res.q1a.blinkSamplesTotal}`);

const q1bOk = res.q1b.firmwareCount !== null && res.q1b.firmwareCount > 0 &&
    res.q1b.firmwareCount >= res.q1b.drivenFallingEdges - 2;
p(`Q1b gpio_set_input() -> guest ISR: ${q1bOk ? 'PASS' : 'FAIL'}`);
p(`    probe drove ${res.q1b.drivenFallingEdges} falling edges, firmware counted ${res.q1b.firmwareCount}`);

const rampWithEst = res.q2a.ramp.filter((s) => s.est !== null);
let corr = null;
if (rampWithEst.length >= 5) {
    const xs = rampWithEst.map((s) => s.duty / 8192), ys = rampWithEst.map((s) => s.est);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    corr = +(num / Math.sqrt(dx * dy)).toFixed(3);
}
const q2aOk = res.q2a.pinOeEver && res.q2a.pinOutToggled && (corr === null || corr > 0.8);
p(`\nQ2a LEDC PWM observable at pad register: ${q2aOk ? 'PASS' : 'FAIL'}`);
p(`    pin9 oe ever=${res.q2a.pinOeEver} out toggled=${res.q2a.pinOutToggled} ramp r=${corr} over ${rampWithEst.length} steps`);
for (const f of res.q2a.flats) p(`    flat ${f.tag}: duty=${(f.duty / 8192).toFixed(3)} est=${f.est} (n=${f.samples})`);

const q2bOk = res.q2b.dutyRegSamples > 10 && res.q2b.dutyRTracking > 5;
p(`Q2b LEDC duty regs via read_memory(): ${q2bOk ? 'PASS' : 'FAIL'}`);
p(`    samples=${res.q2b.dutyRegSamples} tracking=${res.q2b.dutyRTracking}  FUNC9_OUT_SEL=0x${(res.q2b.funcOutSel9 ?? 0).toString(16)} IO_MUX9=0x${(res.q2b.ioMux9 ?? 0).toString(16)}`);

const q3aOk = res.q3.pinMatched.length > 0;
p(`\nQ3a WS2812 via pin fine-sampling(40): ${q3aOk ? 'PASS' : 'FAIL'}`);
p(`    pin4 oe ever=${res.q3.pinOeEver} changes=${res.q3.pinEdgesTotal} frames=${res.q3.pinFrames.length} matched=${res.q3.pinMatched.map((c) => '0x' + c.toString(16)).join(',') || '-'}`);
if (res.q3.pinFrames.length) p(`    e.g. ${res.q3.pinFrames[0].slice(0, 8).map((c) => '0x' + c.toString(16)).join(' ')}`);

const q3bOk = res.q3.memMatched.length > 0;
p(`Q3b WS2812 via RMT channel RAM: ${q3bOk ? 'PASS' : 'FAIL'}`);
p(`    snapshots=${res.q3.memSnapshots} frames=${res.q3.memFrames.length} matched=${res.q3.memMatched.map((c) => '0x' + c.toString(16)).join(',') || '-'}`);
for (let i = 0; i < Math.min(res.q3.memFrames.length, 12); i++) {
    p(`    frame[${i}] len=${res.q3.memFrames[i].length}: ${res.q3.memFrames[i].map((c) => '0x' + c.toString(16)).join(' ')}`);
}

p(`\nRMT_CH0CONF0=0x${(res.q3.rmtConf0 ?? 0).toString(16)} FUNC4_OUT_SEL=0x${(res.q3.funcOutSel4 ?? 0).toString(16)}`);
p(`fine-vs-coarse slowdown: ${(res.perf.coarseMips / Math.max(res.perf.fineMips, 0.1)).toFixed(1)}x`);

if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));

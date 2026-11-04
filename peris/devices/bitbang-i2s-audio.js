/*
 * Bit-bang I2S audio codec — a microphone + speaker pair sitting on four
 * firmware bit-banged GPIOs (BCLK/WS/DOUT/DIN, all configurable).
 *
 * Why "bit-bang": the esp-emulator wasm has no I2S model (M6 evidence
 * chain, docs/FEASIBILITY.md) — the esp_i2s driver hangs on unmodelled
 * registers. Only CPU-driven GPIO_OUT flips appear in gpio_state(), so
 * the firmware must be the soft I2S *master* (see the P7 phase of the
 * probe firmware for a reference loop). This device:
 *   - decodes DOUT on BCLK rising edges into PCM and streams it to the
 *     page (getState chunks) where the View plays it through Web Audio;
 *   - answers on the DIN *input* path (ctx.setPinInput) bit by bit, fed
 *     from the browser microphone via onCommand('mic') — the M4 answer
 *     cadance, like the I2C slave's ACK pull.
 * Every edge is only observable while a fine sampling lease is held; the
 * device arms a standing watch and escalates on activity (M4). Pacing
 * requirement for the firmware: a BCLK half-period must span at least
 * the fine batch size in instructions (80 here), i.e. pace the bit loop
 * — edges closer than one batch are lost, the codec then drops the slot
 * and resynchronises on the next WS edge (counted in `drops`).
 */
import { I2sCodecEngine, resample, floatToI16 } from './i2s-lib.js';

/** Standing watch batch (instructions) while the bus is idle. */
export const ARM_BATCH = 1000;
/** Fine batch size while a stream is in flight (MIN_BATCH is 20; 80 keeps
 * every edge of a half-period ≥ ~80-instruction bit loop, at ~1/3 the
 * per-batch overhead of 20). */
export const FINE_BATCH = 80;
/** Fine lease budget, in emulator cycles, renewed on every edge. */
export const FINE_HOLD_CYCLES = 400000; // ~2.5 ms at 160 MHz
/** Mic queue cap in samples (drop-oldest beyond this; ~128 ms @ 16 kHz
 * stereo-interleaved) — bounds the mic → emu latency. */
export const MIC_QUEUE_MAX = 2048;
/** Tone generator watermark/chunk (samples per onBatch refill). */
export const TONE_CHUNK = 256;

const pinNum = (v, dflt) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : dflt;
};
const intIn = (v, allowed, dflt) => {
    const n = Number(v); // the generic editor hands <select> values as strings
    return allowed.includes(n) ? n : dflt;
};

export class Device {
    static typeId = 'bitbang-i2s-audio';
    static version = '1.0.0';
    static title = 'Bit-bang I2S audio codec';
    static category = 'audio';
    static description = 'Microphone + speaker behind a firmware bit-banged I2S bus (BCLK/WS/DOUT/DIN GPIOs): decodes DOUT to browser audio, feeds the browser microphone back on DIN. The esp-emulator has no hardware I2S model — the firmware must be the soft master.';
    static defaultConfig = {
        name: 'I2S Audio', bclk: 4, ws: 5, dout: 6, din: 7,
        bits: 16, channels: 2, micRate: 16000,
    };
    /* BCLK/WS/DOUT/DIN are a bus: the logic analyzer may legally probe
     * them (passive), and a future second codec could share the wires. */
    static sharedBus = true;
    static pins(cfg) {
        return [pinNum(cfg.bclk, 4), pinNum(cfg.ws, 5),
                pinNum(cfg.dout, 6), pinNum(cfg.din, 7)];
    }
    static configSchema = [
        { key: 'bclk', label: 'BCLK GPIO', type: 'pin' },
        { key: 'ws', label: 'WS (LRCLK) GPIO', type: 'pin' },
        { key: 'dout', label: 'DOUT GPIO (speaker data)', type: 'pin' },
        { key: 'din', label: 'DIN GPIO (microphone data)', type: 'pin' },
        { key: 'bits', label: 'Slot width', type: 'select', options: [
            { value: '16', label: '16-bit' },
            { value: '24', label: '24-bit' },
            { value: '32', label: '32-bit' },
        ] },
        { key: 'channels', label: 'Channels', type: 'select', options: [
            { value: '2', label: 'Stereo (Philips frame)' },
            { value: '1', label: 'Mono (one sample per WS period)' },
        ] },
        { key: 'micRate', label: 'Mic sample rate', type: 'select', options: [
            { value: '8000', label: '8 kHz' },
            { value: '16000', label: '16 kHz' },
            { value: '48000', label: '48 kHz' },
        ] },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.bclk = pinNum(cfg.bclk, 4);
        this.ws = pinNum(cfg.ws, 5);
        this.dout = pinNum(cfg.dout, 6);
        this.din = pinNum(cfg.din, 7);
        this.bits = intIn(cfg.bits, [16, 24, 32], 16);
        this.channels = intIn(cfg.channels, [1, 2], 2);
        this.micRate = intIn(cfg.micRate, [8000, 16000, 48000], 16000);
        this.levels = { bclk: false, ws: false, dout: false };
        this.stats = { micChunks: 0, micDropped: 0, tone: false };
        this.tonePhase = 0;
        this.engine = new I2sCodecEngine(
            { bits: this.bits, channels: this.channels, cyclesPerUs: ctx.cyclesPerUs },
            (bit) => ctx.setPinInput(this.din, !!bit),
            () => ctx.markDirty(),
            () => ctx.markDirty()); // a dropped slot updates the counters
        ctx.subscribe([this.bclk, this.ws, this.dout]);
        ctx.armSampling(ARM_BATCH);
        ctx.setPinInput(this.din, false); // idle: silence
    }

    onEmuReady() {
        // fresh emulator: bus idle, decoded audio gone, mic re-silenced
        this.levels = { bclk: false, ws: false, dout: false };
        this.engine.cyclesPerUs = this.ctx.cyclesPerUs;
        this.engine.reset();
        this.stats = { micChunks: 0, micDropped: 0, tone: this.stats.tone };
        this.ctx.setPinInput(this.din, false);
        this.ctx.armSampling(ARM_BATCH);
        this.ctx.markDirty();
    }

    onPinState(pin, s) {
        // push-pull master: the driven level is the output register
        const high = !!s.out;
        if (pin === this.bclk) this.levels.bclk = high;
        else if (pin === this.ws) this.levels.ws = high;
        else if (pin === this.dout) this.levels.dout = high;
        else return;
        if (this.engine.step(this.levels, this.ctx.cycles())) {
            // any edge: keep the fine window alive for the rest of the stream
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
        }
    }

    onBatch() {
        if (this.engine.busy) {
            // mid-stream: renew even without edges (slow slots)
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
        }
        if (this.stats.tone) this._refillTone();
    }

    onCommand(cmd, params) {
        if (cmd === 'mic') {
            // Int16Array (browser) or plain array (tests) of mono samples
            const pcm = params?.pcm;
            if (!pcm || !pcm.length) return;
            const before = this.engine.queue.length;
            if (this.channels === 2) {
                // interleave the mono mic stream into L/R slot order
                const stereo = new Array(pcm.length * 2);
                for (let i = 0; i < pcm.length; i++) {
                    stereo[i * 2] = pcm[i];
                    stereo[i * 2 + 1] = pcm[i];
                }
                this.engine.pushMic(stereo);
            } else {
                this.engine.pushMic(pcm);
            }
            this.engine.trimQueue(MIC_QUEUE_MAX);
            this.stats.micChunks++;
            this.stats.micDropped += Math.max(0, before + pcm.length * this.channels - MIC_QUEUE_MAX);
            this.ctx.markDirty();
        } else if (cmd === 'tone') {
            this.stats.tone = !!params?.on;
            this.tonePhase = 0;
            this.ctx.markDirty();
        }
    }

    getState() {
        return {
            bclk: this.bclk, ws: this.ws, dout: this.dout, din: this.din,
            bits: this.bits, channels: this.channels,
            rate: this.engine.detectedRate(),
            frames: this.engine.frames,
            drops: this.engine.drops,
            underruns: this.engine.underruns,
            queue: this.engine.queue.length,
            micChunks: this.stats.micChunks,
            micDropped: this.stats.micDropped,
            tone: this.stats.tone,
            pcm: this.engine.drainOut(), // null when nothing new (33 ms flush)
        };
    }

    destroy() {
        this.ctx.releaseSampling();
        this.ctx.unsubscribe();
        this.ctx.setPinInput(this.din, false); // release to silence
    }

    /** 440 Hz test tone at micRate, phase-continuous, queue-watermarked. */
    _refillTone() {
        const q = this.engine.queue.length;
        if (q >= MIC_QUEUE_MAX / 2) return;
        const chunk = new Array(TONE_CHUNK * this.channels);
        for (let i = 0; i < TONE_CHUNK; i++) {
            const v = Math.round(Math.sin(2 * Math.PI * 440 * (this.tonePhase++ / this.micRate)) * 9830);
            if (this.channels === 2) { chunk[i * 2] = v; chunk[i * 2 + 1] = v; }
            else chunk[i] = v;
        }
        this.engine.pushMic(chunk);
        this.engine.trimQueue(MIC_QUEUE_MAX);
    }
}

/* ---- View (page side) ------------------------------------------------------- */

const WAVE_W = 232, WAVE_H = 56, ICON = 22;
/** Wall-clock playback backlog bound (ms) before dropping oldest chunks. */
const PLAY_BACKLOG_MS = 600;

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.cfg = { bclk: 4, ws: 5, dout: 6, din: 7, bits: 16, channels: 2, micRate: 16000 };
        this.state = null;
        this.outRing = new Int16Array(512); this.outLen = 0; // waveform tail
        this.micLevel = 0;
        el.className = 'dev-body i2sa-body';

        this.status = document.createElement('div');
        this.status.className = 'i2sa-status';
        el.appendChild(this.status);

        const wrap = document.createElement('div');
        wrap.className = 'mx-wrap';
        this.cv = this._makeCanvas(WAVE_W, WAVE_H, 'mx-canvas i2sa-canvas');
        wrap.appendChild(this.cv);
        const cap = document.createElement('div');
        cap.className = 'mx-cap';
        cap.textContent = 'output / input';
        wrap.appendChild(cap);
        el.appendChild(wrap);

        this.ctrl = document.createElement('div');
        this.ctrl.className = 'i2sa-ctrl';
        el.appendChild(this.ctrl);
        this._buildControls();
        this._renderStatus({});
    }

    /* canvas factory with devicePixelRatio scaling (ws2812-lib pattern;
     * inlined because the View must stay a plain self-contained DOM) */
    _makeCanvas(w, h, cls) {
        const dpr = window.devicePixelRatio || 1;
        const cv = document.createElement('canvas');
        cv.width = w * dpr; cv.height = h * dpr;
        cv.className = cls;
        cv.style.width = w + 'px'; cv.style.height = h + 'px';
        const g = cv.getContext('2d');
        g.scale(dpr, dpr);
        return cv;
    }

    _buildControls() {
        const mk = (label, cb) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'i2sa-btn'; b.textContent = label;
            b.addEventListener('click', cb);
            this.ctrl.appendChild(b);
            return b;
        };
        this.micBtn = mk('🎤 mic on', () => this._toggleMic());
        this.toneBtn = mk('∿ 440 Hz', () => {
            this.toneOn = !this.toneOn;
            this.toneBtn.classList.toggle('live', this.toneOn);
            this.send('tone', { on: this.toneOn });
        });
        this.playBtn = mk('🔈 play', () => this._togglePlay());
        const vol = document.createElement('input');
        vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = 70;
        vol.className = 'i2sa-vol'; vol.title = 'playback volume';
        this.ctrl.appendChild(vol);
        this.vol = vol;
    }

    rowIcon(el) {
        el.title = 'I2S audio';
        this.icon = this._makeCanvas(ICON, ICON, 'mx-icon i2sa-icon');
        el.appendChild(this.icon);
        this._applyIcon(0);
    }

    _applyIcon(level) {
        if (!this.icon) return;
        const g = this.icon.getContext('2d');
        g.clearRect(0, 0, ICON, ICON);
        g.strokeStyle = g.fillStyle = level > 0.02 ? 'var(--accent-text, #4cc38a)' : 'var(--faint, #888)';
        // speaker glyph with an activity arc whose radius tracks the level
        g.beginPath();
        g.moveTo(5, 9); g.lineTo(9, 9); g.lineTo(13, 5); g.lineTo(13, 17); g.lineTo(9, 13); g.lineTo(5, 13);
        g.closePath(); g.fill();
        if (level > 0.02) {
            g.beginPath();
            g.arc(14, 11, 3 + Math.min(5, level * 8), -0.9, 0.9);
            g.stroke();
        }
    }

    render(state) {
        this.state = state;
        if (state.pcm && state.pcm.length) this._enqueue(state.pcm, state.rate || this.lastRate || this.cfg.micRate);
        this._pushWave(state.pcm);
        this._renderStatus(state);
        // icon activity from the recent output peak
        this._applyIcon(this._outPeak());
    }

    setConfig(cfg) {
        this.cfg = { bclk: cfg.bclk, ws: cfg.ws, dout: cfg.dout, din: cfg.din,
                     bits: Number(cfg.bits) || 16, channels: Number(cfg.channels) || 2,
                     micRate: Number(cfg.micRate) || 16000 };
        if (this.micOn && this.micCtx && this.micCtx.sampleRate !== this.cfg.micRate) {
            this._stopMic();
            this._startMic();
        }
        this._renderStatus(this.state || {});
    }

    destroy() {
        this._stopMic();
        this._stopPlay();
    }

    /* ---- status + waveform ---- */

    _renderStatus(s) {
        const c = this.cfg;
        const rate = s.rate ? (s.rate / 1000).toFixed(1) + ' kHz' : '—';
        this.status.textContent =
            `soft I2S · BCLK ${c.bclk} WS ${c.ws} DOUT ${c.dout} DIN ${c.din}` +
            ` · ${c.bits}-bit ${c.channels === 1 ? 'mono' : 'stereo'} · ${rate}` +
            ` · ${s.frames ?? 0} frames, ${s.drops ?? 0} drops` +
            (s.underruns ? `, ${s.underruns} underruns` : '') +
            (this.micErr ? ` · mic: ${this.micErr}` : '');
    }

    _pushWave(pcm) {
        if (!pcm || !pcm.length) return;
        const step = Math.max(1, Math.floor(pcm.length / this.outRing.length));
        for (let i = 0; i < pcm.length; i += step) {
            this.outRing[this.outLen++ % this.outRing.length] = pcm[i];
        }
        this.outLen = Math.min(this.outLen, this.outRing.length);
        this._drawWave();
    }

    _outPeak() {
        let peak = 0;
        for (let i = 0; i < this.outLen; i++) {
            const a = Math.abs(this.outRing[i]);
            if (a > peak) peak = a;
        }
        return peak / 32768;
    }

    _drawWave() {
        const g = this.cv.getContext('2d');
        g.clearRect(0, 0, WAVE_W, WAVE_H);
        g.strokeStyle = 'rgba(128,128,128,0.25)';
        g.beginPath(); g.moveTo(0, WAVE_H / 2); g.lineTo(WAVE_W, WAVE_H / 2); g.stroke();
        if (!this.outLen) return;
        g.strokeStyle = 'var(--accent-text, #4cc38a)';
        g.beginPath();
        const n = this.outLen, mid = WAVE_H / 2, amp = (WAVE_H / 2 - 2) / 32768;
        for (let i = 0; i < n; i++) {
            const x = (i / (n - 1 || 1)) * WAVE_W;
            const y = mid - this.outRing[i] * amp;
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        // mic level bar at the bottom
        if (this.micLevel > 0.01) {
            g.fillStyle = 'rgba(86,156,214,0.8)';
            g.fillRect(0, WAVE_H - 3, WAVE_W * Math.min(1, this.micLevel), 3);
        }
    }

    /* ---- playback (decoded DOUT → Web Audio) ---- */

    _togglePlay() {
        if (this.playing) { this._stopPlay(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
            this.micErr = 'Web Audio unavailable';
            this._renderStatus(this.state || {});
            return;
        }
        this.playing = true;
        this.playBtn.classList.add('live');
        this.playBtn.textContent = '⏸ playing';
        this.actx = this.actx || new AC();
        this.actx.resume().catch(() => {});
        this.gain = this.actx.createGain();
        this.gain.gain.value = (Number(this.vol.value) || 70) / 100;
        this.gain.connect(this.actx.destination);
        this.vol.oninput = () => { if (this.gain) this.gain.gain.value = (Number(this.vol.value) || 70) / 100; };
        this.nextStart = this.actx.currentTime + 0.05;
        this.backlog = []; // {samples, rate}
        this.droppedChunks = 0;
    }

    _stopPlay() {
        this.playing = false;
        if (this.playBtn) { this.playBtn.classList.remove('live'); this.playBtn.textContent = '🔈 play'; }
        if (this.gain) { try { this.gain.disconnect(); } catch { /* already gone */ } this.gain = null; }
        this.backlog = [];
    }

    _enqueue(pcm, rate) {
        if (!this.playing) return;
        const r = rate > 3000 && rate < 100000 ? rate : 16000;
        this.lastRate = r;
        this.backlog.push({ pcm, rate: r });
        // bound the wall-clock backlog: the emulator's time compression
        // makes audio arrive faster than real time — drop oldest, count it
        let buffered = 0;
        for (const b of this.backlog) buffered += b.pcm.length / b.rate;
        while (buffered > PLAY_BACKLOG_MS / 1000 && this.backlog.length > 1) {
            const b = this.backlog.shift();
            buffered -= b.pcm.length / b.rate;
            this.droppedChunks++;
        }
        this._pump();
    }

    _pump() {
        if (!this.playing || !this.actx) return;
        while (this.backlog.length) {
            const { pcm, rate } = this.backlog[0];
            const chs = this.cfg.channels === 1 ? 1 : 2;
            const frames = Math.floor(pcm.length / chs);
            if (!frames) { this.backlog.shift(); continue; }
            const buf = this.actx.createBuffer(chs, frames, rate);
            for (let c = 0; c < chs; c++) {
                const d = buf.getChannelData(c);
                for (let i = 0; i < frames; i++) d[i] = (pcm[i * chs + c] || 0) / 32768;
            }
            const src = this.actx.createBufferSource();
            src.buffer = buf;
            src.connect(this.gain);
            // schedule seamlessly after whatever is still queued
            const start = Math.max(this.actx.currentTime + 0.005, this.nextStart);
            src.start(start);
            this.nextStart = start + frames / rate;
            this.backlog.shift();
        }
    }

    /* ---- microphone (browser getUserMedia → onCommand('mic')) ---- */

    async _toggleMic() {
        if (this.micOn) { this._stopMic(); return; }
        if (!navigator.mediaDevices?.getUserMedia) {
            this.micErr = 'getUserMedia unavailable (secure context?)';
            this._renderStatus(this.state || {});
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            });
            this._startMic(stream);
        } catch (e) {
            this.micErr = e && e.name ? e.name : 'denied';
            this._renderStatus(this.state || {});
        }
    }

    _startMic(stream) {
        this.micOn = true;
        this.micStream = stream;
        this.micErr = null;
        this.micBtn.classList.add('live');
        this.micBtn.textContent = '🎤 mic off';
        // ScriptProcessorNode: zero build steps, works from a plain plugin
        this.micCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = this.micCtx.createMediaStreamSource(stream);
        const node = this.micCtx.createScriptProcessor(2048, 1, 1);
        const target = this.cfg.micRate;
        this.micProc = node;
        node.onaudioprocess = (ev) => {
            let f32 = ev.inputBuffer.getChannelData(0);
            if (this.micCtx.sampleRate !== target) f32 = resample(f32, this.micCtx.sampleRate, target);
            let peak = 0;
            for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > peak) peak = a; }
            this.micLevel = peak;
            this.send('mic', { pcm: floatToI16(f32) });
        };
        src.connect(node);
        // the node must reach a destination to pump in some UAs — through
        // a zero gain, never the speakers (acoustic feedback)
        const mute = this.micCtx.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(this.micCtx.destination);
    }

    _stopMic() {
        this.micOn = false;
        if (this.micBtn) { this.micBtn.classList.remove('live'); this.micBtn.textContent = '🎤 mic on'; }
        if (this.micProc) { try { this.micProc.disconnect(); } catch { /* gone */ } this.micProc = null; }
        if (this.micStream) { for (const t of this.micStream.getTracks()) t.stop(); this.micStream = null; }
        if (this.micCtx) { this.micCtx.close().catch(() => {}); this.micCtx = null; }
        this.micLevel = 0;
    }
}

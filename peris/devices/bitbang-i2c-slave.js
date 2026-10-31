/*
 * Bit-bang I2C slave — emulates a 24C02 EEPROM or a BME280 sensor sitting
 * on two firmware bit-banged GPIOs (SCL/SDA).
 *
 * Why "bit-bang": signals routed through hardware I2C cannot be tapped
 * from outside the wasm (M0) — only CPU-driven GPIO_OUT flips appear in
 * gpio_state(). The device therefore watches SCL/SDA through the sigbus,
 * decodes the protocol with the engine in i2c-lib.js, and answers on the
 * SDA *input* path (ctx.setPinInput), which the master sees while it
 * releases the pad as an input — the standard open-drain idiom. Every
 * edge is only observable while a fine sampling lease is held: the
 * device arms a standing watch (~1600-instruction batches, enough to
 * resolve a START on buses down to ~20 kHz) and escalates to fine
 * batches on the first bus activity (see docs/DEVICE-API.md, M4).
 */
import {
    I2cSlaveEngine, Eeprom24c02, Bme280Model, bme280Compensate,
} from './i2c-lib.js';

/** Standing watch batch (instructions) while the bus is idle — must stay
 * below the SDA-low window after a START (guest delay loops run ~50% of
 * nominal time on this emulator, so a 25 µs firmware delay is ~12.5 µs of
 * emulator time; M4 measurement). */
export const ARM_BATCH = 1000;
/** Fine batch size while a transaction is in flight. */
export const FINE_BATCH = 300;
/** Fine lease budget, in emulator cycles, renewed on every edge. */
export const FINE_HOLD_CYCLES = 300000; // ~1.9 ms at 160 MHz

const MODEL_DEFAULT_ADDR = { eeprom24c02: 0x50, bme280: 0x76 };

const pinNum = (v, dflt) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : dflt;
};

const addrFrom = (cfg, kind) => {
    const n = Number(cfg.address);
    return Number.isInteger(n) && n >= 0x08 && n <= 0x77 ? n : MODEL_DEFAULT_ADDR[kind];
};

export class Device {
    static typeId = 'bitbang-i2c-slave';
    static version = '1.0.0';
    static title = 'Bit-bang I2C slave';
    static category = 'protocol';
    static description = '24C02 EEPROM or BME280 behind a firmware bit-banged I2C bus (SCL/SDA GPIOs; answers via the SDA input path).';
    static defaultConfig = {
        name: 'I2C', model: 'eeprom24c02', scl: 1, sda: 2, address: 0x50,
    };
    /* SCL/SDA are a bus: several slaves may share the pair (e.g. the 24C02
     * and the BME280 demo). */
    static sharedBus = true;
    static pins(cfg) {
        return [pinNum(cfg.scl, 1), pinNum(cfg.sda, 2)];
    }
    static configSchema = [
        { key: 'model', label: 'Device model', type: 'select', options: [
            { value: 'eeprom24c02', label: '24C02 EEPROM (256 B)' },
            { value: 'bme280', label: 'BME280 sensor' },
        ] },
        { key: 'scl', label: 'SCL GPIO', type: 'pin' },
        { key: 'sda', label: 'SDA GPIO', type: 'pin' },
        { key: 'address', label: 'Address (7-bit hex)', type: 'number', min: 8, max: 119, step: 1 },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.kind = cfg.model === 'bme280' ? 'bme280' : 'eeprom24c02';
        this.model = this.kind === 'bme280' ? new Bme280Model() : new Eeprom24c02();
        this.scl = pinNum(cfg.scl, 1);
        this.sda = pinNum(cfg.sda, 2);
        this.addr = addrFrom(cfg, this.kind);
        this.levels = { scl: true, sda: true };
        this.log = [];   // transaction summaries, newest last (capped)
        this.stats = { starts: 0, stops: 0, bytes: 0, nacks: 0 };
        this.tx = null;  // transaction accumulator
        this.engine = new I2cSlaveEngine(
            this.addr, this.model,
            (high) => ctx.setPinInput(this.sda, high),
            (e) => this._onEvent(e));
        ctx.subscribe([this.scl, this.sda]);
        ctx.armSampling(ARM_BATCH);
        ctx.setPinInput(this.sda, true); // idle: line released high
    }

    onEmuReady() {
        // fresh emulator: bus idle, volatile model state gone; EEPROM
        // contents survive (non-volatile), like the real part
        this.levels = { scl: true, sda: true };
        this.model.reset();
        this.engine.reset();
        this.log = [];
        this.stats = { starts: 0, stops: 0, bytes: 0, nacks: 0 };
        this.tx = null;
        this.ctx.setPinInput(this.sda, true);
        this.ctx.armSampling(ARM_BATCH);
        this.ctx.markDirty();
    }

    onPinState(pin, s) {
        // released pad (oe=0) or driven high → line high; only oe=1+out=0 drives low
        const high = !(s.oe && !s.out);
        if (pin === this.scl) this.levels.scl = high;
        else this.levels.sda = high;
        if (this.engine.step(this.levels.scl, this.levels.sda)) {
            // any edge: keep the fine window alive for the rest of the transfer
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
            this.ctx.markDirty();
        }
    }

    onBatch() {
        if (this.engine.busy) {
            // mid-transaction: renew even without edges (slow ACK pauses)
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
        }
    }

    onCommand(cmd, params) {
        if (this.kind !== 'eeprom24c02') return;
        if (cmd === 'eeprom-load') {
            const addr = Number(params?.addr) & 0xff;
            const bytes = Array.isArray(params?.bytes) ? params.bytes.map((b) => Number(b) & 0xff) : [];
            if (bytes.length) this.model.load(addr, bytes);
            this.ctx.markDirty();
        } else if (cmd === 'eeprom-clear') {
            this.model.mem.fill(0xff);
            this.model.writes = 0;
            this.ctx.markDirty();
        }
    }

    getState() {
        const st = {
            model: this.kind,
            address: this.addr,
            scl: this.scl,
            sda: this.sda,
            state: this.engine.phase,
            stats: { ...this.stats },
            log: this.log.slice(-6),
        };
        if (this.kind === 'eeprom24c02') {
            st.mem = Array.from(this.model.mem);
        } else {
            const m = this.model.measurement();
            const c = bme280Compensate(m.adcT, m.adcP, m.adcH, this.model.dig);
            st.bme = {
                n: this.model.n,
                ctrlHum: this.model.regs[0xF2],
                ctrlMeas: this.model.regs[0xF4],
                ...m,
                tCx100: c.tCx100,
                pPa: c.pPa,
                hRx1024: c.hRx1024,
            };
        }
        return st;
    }

    destroy() {
        this.ctx.releaseSampling();
        this.ctx.unsubscribe();
        this.ctx.setPinInput(this.sda, true); // release the line
    }

    _onEvent(e) {
        switch (e.type) {
            case 'start':
                this.stats.starts++;
                this.tx = { rw: 0, ptr: null, bytes: [], reads: 0 };
                break;
            case 'addr':
                if (e.matched) this.tx.rw = e.rw;
                break;
            case 'wrbyte':
                this.stats.bytes++;
                if (this.tx) {
                    if (e.first) this.tx.ptr = e.value;
                    else this.tx.bytes.push(e.value);
                }
                break;
            case 'rdbyte':
                this.stats.bytes++;
                if (this.tx) this.tx.reads++;
                break;
            case 'mack':
                if (e.nack) this.stats.nacks++;
                break;
            case 'stop': {
                this.stats.stops++;
                if (this.tx && (this.tx.bytes.length || this.tx.reads)) {
                    this.log.push({
                        rw: this.tx.rw,
                        ptr: this.tx.ptr,
                        bytes: this.tx.bytes.slice(-12),
                        reads: this.tx.reads,
                    });
                    if (this.log.length > 40) this.log.shift();
                }
                this.tx = null;
                this.ctx.markDirty();
                break;
            }
        }
    }
}

const hex2 = (v) => (v & 0xff).toString(16).padStart(2, '0');

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.cfg = { model: 'eeprom24c02' };
        this.memSig = '';
        el.className = 'dev-body i2c-body';

        this.status = document.createElement('div');
        this.status.className = 'i2c-status';
        this.list = document.createElement('div');
        this.list.className = 'i2c-log';
        this.panel = document.createElement('div');
        this.panel.className = 'i2c-panel';
        el.appendChild(this.status);
        el.appendChild(this.list);
        el.appendChild(this.panel);
        this._renderLog([]);
    }

    rowIcon(el) {
        el.title = 'I2C slave';
        const chip = document.createElement('span');
        chip.className = 'i2c-icon';
        chip.textContent = 'I²C';
        this.icon = chip;
        el.appendChild(chip);
        this._applyIcon('idle');
    }

    /* one styling path for the icon (AGENT.md §3.8) */
    _applyIcon(state) {
        if (!this.icon) return;
        this.icon.classList.toggle('live', state !== 'idle');
    }

    _renderLog(entries) {
        this.list.innerHTML = '';
        if (!entries.length) {
            const d = document.createElement('div');
            d.className = 'i2c-empty';
            d.textContent = 'waiting for bus traffic…';
            this.list.appendChild(d);
            return;
        }
        for (const e of entries.slice().reverse()) {
            const d = document.createElement('div');
            d.className = 'i2c-entry';
            const head = document.createElement('span');
            head.className = 'i2c-dir';
            if (e.rw === 0) {
                head.textContent = `W 0x${(e.ptr ?? 0).toString(16).padStart(2, '0')} · ${e.bytes.length + 1}B`;
            } else {
                head.textContent = `R ← ${e.reads}B`;
            }
            d.appendChild(head);
            if (e.rw === 0 && e.bytes.length) {
                const b = document.createElement('span');
                b.className = 'i2c-bytes';
                b.textContent = e.bytes.map(hex2).join(' ');
                d.appendChild(b);
            }
            this.list.appendChild(d);
        }
    }

    _renderEeprom(mem) {
        const sig = mem.join(',');
        if (sig === this.memSig && this.panel.childNodes.length) return;
        this.memSig = sig;
        this.panel.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'i2c-hex';
        for (let row = 0; row < 16; row++) {
            const r = document.createElement('div');
            r.className = 'i2c-hex-row';
            const a = document.createElement('span');
            a.className = 'i2c-hex-addr';
            a.textContent = (row * 16).toString(16).padStart(2, '0') + '0';
            r.appendChild(a);
            for (let col = 0; col < 16; col++) {
                const s = document.createElement('span');
                const v = mem[row * 16 + col] ?? 0xff;
                s.textContent = hex2(v);
                if (v !== 0xff) s.className = 'set';
                r.appendChild(s);
            }
            grid.appendChild(r);
        }
        this.panel.appendChild(grid);

        const io = document.createElement('div');
        io.className = 'i2c-io';
        const addr = document.createElement('input');
        addr.type = 'text';
        addr.placeholder = 'addr';
        addr.value = '10';
        addr.className = 'i2c-addr';
        const bytes = document.createElement('input');
        bytes.type = 'text';
        bytes.placeholder = 'hex bytes: aa 55 …';
        bytes.className = 'i2c-bytes-in';
        const load = document.createElement('button');
        load.type = 'button';
        load.textContent = 'Load';
        load.addEventListener('click', () => {
            const a = parseInt(addr.value.replace(/^0x/, ''), 16) || 0;
            const bs = (bytes.value.match(/[0-9a-fA-F]{1,2}/g) || []).map((h) => parseInt(h, 16));
            if (bs.length) this.send('eeprom-load', { addr: a, bytes: bs });
        });
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = 'Erase';
        clear.addEventListener('click', () => this.send('eeprom-clear'));
        io.appendChild(addr);
        io.appendChild(bytes);
        io.appendChild(load);
        io.appendChild(clear);
        this.panel.appendChild(io);
    }

    _renderBme(bme) {
        this.panel.innerHTML = '';
        this.memSig = '';
        if (!bme) return;
        const table = document.createElement('div');
        table.className = 'i2c-regs';
        const rows = [
            ['chip id', '0x60'],
            ['measurements', String(bme.n)],
            ['adc_T', String(bme.adcT)],
            ['adc_P', String(bme.adcP)],
            ['adc_H', String(bme.adcH)],
            ['temperature', `${(bme.tCx100 / 100).toFixed(2)} °C`],
            ['pressure', `${(bme.pPa / 100).toFixed(2)} hPa`],
            ['humidity', `${(bme.hRx1024 / 1024).toFixed(2)} %`],
            ['ctrl_hum / ctrl_meas', `0x${hex2(bme.ctrlHum)} / 0x${hex2(bme.ctrlMeas)}`],
        ];
        for (const [k, v] of rows) {
            const r = document.createElement('div');
            r.className = 'i2c-reg';
            const kEl = document.createElement('span');
            kEl.textContent = k;
            const vEl = document.createElement('span');
            vEl.textContent = v;
            r.appendChild(kEl);
            r.appendChild(vEl);
            table.appendChild(r);
        }
        this.panel.appendChild(table);
    }

    render(state) {
        this._applyIcon(state.state || 'idle');
        const name = state.model === 'bme280' ? 'BME280' : '24C02';
        this.status.textContent = `${name} @ 0x${(state.address ?? 0).toString(16).padStart(2, '0')}`
            + ` · SCL GPIO${state.scl} / SDA GPIO${state.sda}`
            + ` · ${state.state ?? 'idle'}`
            + ` · ${state.stats?.stops ?? 0} transactions, ${state.stats?.bytes ?? 0} bytes`;
        this._renderLog(state.log || []);
        if (state.model === 'eeprom24c02') this._renderEeprom(state.mem || []);
        else this._renderBme(state.bme);
    }

    setConfig(cfg) {
        this.cfg = { model: cfg.model };
    }
}

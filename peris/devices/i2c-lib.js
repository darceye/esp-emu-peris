/*
 * i2c-lib — shared helpers for the bit-bang I2C slave device (M4). One
 * semantic, one implementation (AGENT.md §3.8): the wire-protocol state
 * machine, the two register models (24C02 EEPROM, BME280) and the Bosch
 * compensation math live here; the plugin and the unit tests import this
 * module. Not listed in manifest.json → never loaded as a device itself.
 * No page-only helpers here (Node tests must be able to import the file).
 *
 * Wire model (matches what gpio_state() exposes and what a soft master
 * that follows the open-drain idiom produces):
 *   - a pad DRIVES LOW when oe=1 and out=0; everything else (oe=0, or
 *     out=1) is a RELEASED line that idles high;
 *   - the slave answers on the SDA input path: driveSda(false) pulls the
 *     line low for ACK / read data, driveSda(true) releases it. This is
 *     visible to the master exactly while it releases the pad as an
 *     input (gpio_get_level reads the level gpio_set_input drives — the
 *     M0 Q1b path); push-pull masters that never release cannot be
 *     answered (documented constraint, see DEVICE-API.md).
 *
 * The engine is fed one (scl, sda) level pair per sample and is a no-op
 * when neither level changed — so it tolerates being stepped twice with
 * the same end-of-batch levels when both lines moved inside one batch.
 * Every edge is only guaranteed to be seen when the device holds a fine
 * sampling lease (ctx.fineSampling) — bit-banged buses are slow enough
 * that the standing ARM lease (~2000-instruction batches) already
 * resolves a START; the engine then relies on the device's fine window.
 */

/* ---- protocol engine ------------------------------------------------------- */

/**
 * Level-driven I2C slave. Constructor takes:
 *   driveSda(high:boolean)  — electrical callback (pull low / release)
 *   onEvent(evt)            — protocol events for logging / state pushes:
 *     {type:'start'} {type:'addr', addr, rw, matched}
 *     {type:'wrbyte', value, first}   — master wrote a byte (first = pointer)
 *     {type:'rdbyte', value}          — slave served a read byte
 *     {type:'mack', nack}             — master ACK (nack:false) after a read byte
 *     {type:'stop'}
 * Step it with step(sclHigh, sdaHigh); getState() summarises the bus.
 * Clock stretching is not modelled (the models never need it).
 */
export class I2cSlaveEngine {
    constructor(addr7, model, driveSda, onEvent) {
        this.addr7 = addr7 & 0x7f;
        this.model = model;
        this.driveSda = driveSda;
        this.onEvent = onEvent || (() => {});
        this.reset();
    }

    reset() {
        this.phase = 'idle';   // idle | addr | wr | rd | ignore
        this.scl = true;
        this.sda = true;
        this.clk = 0;          // SCL clocks completed inside the current byte
        this.shift = 0;
        this.ackThisByte = false; // the 9th clock of THIS byte is ours to ACK
        this.masterAck = 1;
        this.rdByte = 0;
        this.rdDone = false;
        this.ptrSet = false;
        this.driveSda(true);
    }

    get busy() {
        return this.phase !== 'idle';
    }

    /** One sample of the bus. Returns true when an edge was consumed. */
    step(sclHigh, sdaHigh) {
        const scl = !!sclHigh, sda = !!sdaHigh;
        let consumed = false;
        if (scl !== this.scl) {
            consumed = true;
            if (scl) this._rising(sda);
            else this._falling();
        }
        if (sda !== this.sda && scl) {
            // SDA moves while SCL is high: START (fall) / STOP (rise)
            consumed = true;
            if (sda) this._stop();
            else this._start();
        }
        this.scl = scl;
        this.sda = sda;
        return consumed;
    }

    _start() {
        this.phase = 'addr';
        this.clk = 0;
        this.shift = 0;
        this.ptrSet = false;
        this.rdDone = false;
        this.onEvent({ type: 'start' });
    }

    _stop() {
        this.driveSda(true);
        const wasActive = this.phase !== 'idle';
        this.phase = 'idle';
        this.clk = 0;
        if (wasActive) this.onEvent({ type: 'stop' });
    }

    _rising(sda) {
        if (this.phase === 'idle') return;
        if (this.clk < 8) {
            this.shift = ((this.shift << 1) | (sda ? 1 : 0)) & 0xff;
            this.clk++;
            if (this.clk === 8) this._byteDone();
        } else if (this.clk === 8) {
            // 9th clock: in a read the master ACKs here
            if (this.phase === 'rd') {
                this.masterAck = sda ? 1 : 0;
                this.onEvent({ type: 'mack', nack: this.masterAck === 1 });
            }
            this.clk = 9;
        }
    }

    _falling() {
        if (this.phase === 'idle') return;
        if (this.clk === 8) {
            // the ACK slot of the completed byte: ours to answer or the
            // master's (read data) — decided per byte in _byteDone, not by
            // the (possibly already switched) phase
            if (this.ackThisByte) this.driveSda(false);
            else this.driveSda(true);
        } else if (this.clk === 9) {
            this.clk = 0;
            this.shift = 0;
            if (this.phase === 'rd' && !this.rdDone) {
                this.rdByte = this.model.readByte() & 0xff;
                this.driveSda(((this.rdByte >> 7) & 1) === 1);
                this.onEvent({ type: 'rdbyte', value: this.rdByte });
            } else {
                this.driveSda(true); // stop pulling after our ACK
            }
        } else if (this.phase === 'rd' && !this.rdDone) {
            // data bit clk of the outgoing byte, MSB first
            this.driveSda(((this.rdByte >> (7 - this.clk)) & 1) === 1);
        }
    }

    _byteDone() {
        const v = this.shift;
        if (this.phase === 'addr') {
            const addr = (v >> 1) & 0x7f;
            const rw = v & 1;
            this.onEvent({ type: 'addr', addr, rw, matched: addr === this.addr7 });
            // the address byte is ACKed by the slave for BOTH directions
            this.ackThisByte = addr === this.addr7;
            this.phase = addr === this.addr7 ? (rw ? 'rd' : 'wr') : 'ignore';
            this.ptrSet = false;
            return;
        }
        if (this.phase === 'wr') {
            this.ackThisByte = true;
            if (!this.ptrSet) {
                this.model.setPointer(v);
                this.ptrSet = true;
                this.onEvent({ type: 'wrbyte', value: v, first: true });
            } else {
                this.model.writeByte(v);
                this.onEvent({ type: 'wrbyte', value: v, first: false });
            }
        } else {
            // read data (the master ACKs) or an ignored transaction
            this.ackThisByte = false;
        }
    }
}

/* ---- register models ------------------------------------------------------- */

/**
 * 24C02 — 256-byte EEPROM. Writes land per byte with the address counter
 * auto-incrementing (page boundaries ignored); the counter persists across
 * transactions like the real part. Contents survive emulator reloads
 * (non-volatile) — reset() keeps them.
 */
export class Eeprom24c02 {
    constructor() {
        this.mem = new Uint8Array(256).fill(0xff); // erased state
        this.ptr = 0;
        this.writes = 0;
    }

    startWrite() { /* the pointer byte arrives as the first wrbyte */ }

    setPointer(v) {
        this.ptr = v & 0xff;
    }

    writeByte(v) {
        this.mem[this.ptr] = v & 0xff;
        this.ptr = (this.ptr + 1) & 0xff;
        this.writes++;
    }

    readByte() {
        const v = this.mem[this.ptr];
        this.ptr = (this.ptr + 1) & 0xff;
        return v;
    }

    /** UI preload: write bytes starting at addr (does not touch the counter). */
    load(addr, bytes) {
        for (let i = 0; i < bytes.length; i++) this.mem[(addr + i) & 0xff] = bytes[i] & 0xff;
        this.writes += bytes.length;
    }

    reset() { /* non-volatile: contents survive chip reset */ }
}

/**
 * BME280 register-level model. Factory calibration block + chip id are
 * read-only; ctrl_hum/ctrl_meas/config are writable RAM (a ctrl_meas write
 * with mode ≠ 0 triggers a forced measurement). The fake signal advances
 * with every forced measurement n (chosen so the compensated readout walks
 * through plausible weather: ≈ 21–23 °C, ≈ 1028→1011 hPa, ≈ 47–69 %RH
 * for n = 0..2 — exact values pinned by tests and the probe firmware):
 *   adc_T = 524288 + 4096·n, adc_P = 1006500 + 200·n, adc_H = 30000 + 4096·n
 * (20-bit adc_T/adc_P, 16-bit adc_H).
 */
export const BME280_FAKE = {
    adcT: (n) => 524288 + 4096 * n,
    adcP: (n) => 1006500 + 200 * n,
    adcH: (n) => 30000 + 4096 * n,
};

/** Factory register block (0x00–0xFF); the calibration bytes mirror the
 * dig_* values bme280Compensate below is hand-verified against. */
export function bme280FactoryRegs() {
    const regs = new Uint8Array(256);
    regs[0xD0] = 0x60;               // chip id
    const put16 = (a, v) => { regs[a] = v & 0xff; regs[a + 1] = (v >> 8) & 0xff; };
    put16(0x88, 28100);              // dig_T1 (uint16)
    put16(0x8A, 23593);              // dig_T2 → T(adc 524288) = 21.00 °C exactly
    put16(0x8C, 0);                  // dig_T3
    put16(0x8E, 36477);              // dig_P1 (uint16, ≠ 0)
    put16(0x90, -10685 & 0xffff);    // dig_P2
    put16(0x92, 3024);               // dig_P3
    put16(0x94, 2855);               // dig_P4
    put16(0x96, 140);                // dig_P5
    put16(0x98, -7 & 0xffff);        // dig_P6
    put16(0x9A, 15500);              // dig_P7
    put16(0x9C, -14600 & 0xffff);    // dig_P8
    put16(0x9E, 6000);               // dig_P9
    regs[0xA1] = 75;                 // dig_H1 (uint8)
    put16(0xE1, 352);                // dig_H2 (int16)
    regs[0xE3] = 0;                  // dig_H3
    regs[0xE4] = 322 >> 4;           // dig_H4[11:4]
    regs[0xE5] = ((322 & 0x0f) << 4) | (383 & 0x0f); // H4[3:0]<<4 | H5[3:0]
    regs[0xE6] = 383 >> 4;           // dig_H5[11:4]
    regs[0xE7] = 30;                 // dig_H6 (int8)
    return regs;
}

/** Signed/unsigned dig_* decoders over the factory block (I2C byte order). */
export function bme280Dig(regs) {
    const s16 = (a) => {
        const v = regs[a] | (regs[a + 1] << 8);
        return v >= 0x8000 ? v - 0x10000 : v;
    };
    return {
        T1: regs[0x88] | (regs[0x89] << 8),
        T2: s16(0x8A), T3: s16(0x8C),
        P1: regs[0x8E] | (regs[0x8F] << 8),
        P2: s16(0x90), P3: s16(0x92), P4: s16(0x94), P5: s16(0x96),
        P6: s16(0x98), P7: s16(0x9A), P8: s16(0x9C), P9: s16(0x9E),
        H1: regs[0xA1], H2: s16(0xE1), H3: regs[0xE3] << 24 >> 24,
        // H4[3:0] and H5[3:0] share 0xE5: high nibble → H4, low nibble → H5
        H4: ((regs[0xE4] << 24 >> 24) << 4) | (regs[0xE5] >> 4),
        H5: ((regs[0xE6] << 24 >> 24) << 4) | (regs[0xE5] & 0x0f),
        H6: regs[0xE7] << 24 >> 24,
    };
}

export class Bme280Model {
    constructor() {
        this.factory = bme280FactoryRegs();
        this.dig = bme280Dig(this.factory);
        this.reset();
    }

    reset() {
        this.regs = new Uint8Array(this.factory); // ctrl/config shadow copy
        this.ptr = 0;
        this.n = 0;      // forced measurements so far (drives the fake signal)
    }

    startWrite() { /* pointer byte first, register value(s) after */ }

    setPointer(v) {
        this.ptr = v & 0xff;
    }

    writeByte(v) {
        const a = this.ptr;
        this.regs[a] = v & 0xff;
        if (a === 0xF4 && (v & 0x03) !== 0) this.n++;  // forced / normal trigger
        if (a === 0xE0) this.reset();                  // soft reset
        this.ptr = (this.ptr + 1) & 0xff;
    }

    readByte() {
        const v = this.regRead(this.ptr);
        this.ptr = (this.ptr + 1) & 0xff;
        return v;
    }

    /** Dynamic register view: measurement bytes derive from n. */
    regRead(a) {
        const adcP = BME280_FAKE.adcP(this.n) & 0xfffff;
        const adcT = BME280_FAKE.adcT(this.n) & 0xfffff;
        const adcH = BME280_FAKE.adcH(this.n) & 0xffff;
        switch (a) {
            case 0xF3: return 0;                                    // status: ready
            case 0xF7: return (adcP >> 12) & 0xff;
            case 0xF8: return (adcP >> 4) & 0xff;
            case 0xF9: return (adcP & 0x0f) << 4;
            case 0xFA: return (adcT >> 12) & 0xff;
            case 0xFB: return (adcT >> 4) & 0xff;
            case 0xFC: return (adcT & 0x0f) << 4;
            case 0xFD: return (adcH >> 8) & 0xff;
            case 0xFE: return adcH & 0xff;
            default: return this.regs[a];
        }
    }

    /** Current measurement as { adcT, adcP, adcH } (for the View/tests). */
    measurement() {
        return {
            adcT: BME280_FAKE.adcT(this.n),
            adcP: BME280_FAKE.adcP(this.n),
            adcH: BME280_FAKE.adcH(this.n),
        };
    }
}

/* ---- Bosch compensation (float-free reference) ----------------------------- */

/**
 * The BME280_driver integer reference, mirrored so the probe firmware's C
 * implementation and the JS View agree bit-exactly. adc in, dig from
 * bme280Dig(); returns { tFine, tCx100, pPa, hRx1024 }.
 * Pressure uses BigInt to reproduce C's int64 arithmetic exactly; the
 * humidity mirrors int32 wrap-around with |0 arithmetic.
 */
export function bme280Compensate(adcT, adcP, adcH, dig) {
    const d = dig;
    // temperature (int32)
    let var1 = ((((adcT >> 3) - ((d.T1 << 1) | 0)) * d.T2) >> 11) | 0;
    const t2a = (adcT >> 4) - d.T1;
    let var2 = ((((t2a * t2a) >> 12) * d.T3) >> 14) | 0;
    const tFine = (var1 + var2) | 0;
    const tCx100 = ((tFine * 5 + 128) >> 8) | 0;

    // pressure (int64 → BigInt)
    let p1 = BigInt(tFine) - 128000n;
    let p2 = p1 * p1 * BigInt(d.P6);
    p2 = p2 + ((p1 * BigInt(d.P5)) << 17n);
    p2 = p2 + (BigInt(d.P4) << 35n);
    p1 = ((p1 * p1 * BigInt(d.P3)) >> 8n) + ((p1 * BigInt(d.P2)) << 12n);
    p1 = (((1n << 47n) + p1) * BigInt(d.P1)) >> 33n;
    let pPa = 0;
    if (p1 !== 0n) {
        let p = BigInt(1048576 - adcP);
        p = (((p << 31n) - p2) * 3125n) / p1;
        const q1 = (BigInt(d.P9) * (p >> 13n) * (p >> 13n)) >> 25n;
        const q2 = (BigInt(d.P8) * p) >> 19n;
        p = ((p + q1 + q2) >> 8n) + (BigInt(d.P7) << 4n);
        pPa = Number(BigInt.asIntN(32, p));
    }

    // humidity (int32 with wrap-around, exactly like the C reference)
    let hv = (tFine - 76800) | 0;
    const h1 = (((adcH << 14) - ((d.H4 << 20) | 0) - ((d.H5 * hv) | 0) + 16384) >> 15) | 0;
    const h2 = (((((hv * d.H6) >> 10) * ((((hv * d.H3) >> 11) + 32768) | 0)) >> 10) + 2097152) | 0;
    const h3 = ((h2 * d.H2 + 8192) >> 14) | 0;
    hv = (h1 * h3) | 0;
    hv = (hv - (((((hv >> 15) * (hv >> 15)) >> 7) * d.H1) >> 4)) | 0;
    if (hv < 0) hv = 0;
    if (hv > 419430400) hv = 419430400;
    const hRx1024 = hv >> 12;

    return { tFine, tCx100, pPa, hRx1024 };
}

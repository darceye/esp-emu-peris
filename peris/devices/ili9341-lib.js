/*
 * ili9341-lib — shared helpers for the ILI9341 SPI display device (M5).
 * One semantic, one implementation (AGENT.md §3.8): the command/state
 * machine (CASET/RASET window, RAMWR pixel stream, COLMOD/MADCTL, sleep /
 * display on-off), the RGB565 GRAM and the page-side painter live here;
 * the plugin and the unit tests import this module. Not in manifest.json
 * → never a device itself. No page-only code at import time.
 *
 * Datasheet facts this encodes (ILI9341 datasheet, command table 9):
 *   - transactions arrive D/C-classified by the driver (D/C low = command,
 *     one byte; D/C high = that command's parameter/pixel stream);
 *   - CASET (0x2A) / RASET (0x2B) take the window as 16-bit big-endian
 *     pairs (x0 x1 / y0 y1); a 2-byte form sets x0 = x1 = value;
 *   - RAMWR (0x2C) starts the pixel stream; the address counter wraps at
 *     the window edge (column → next row, last row → window origin);
 *   - COLMOD (0x3A) parameter 0x55 = 16-bit RGB565 (big-endian stream,
 *     RRRRRGGG GGGBBBBB), 0x66 = 18-bit RGB666 (3 bytes/pixel);
 *   - SWRESET (0x01) resets the interface state (window, cursor, sleep)
 *     but not the GRAM; SLPOUT (0x11) / DISPOFF (0x28) / DISPON (0x29)
 *     flip the documented flags.
 * Simplifications (documented, display-grade): MADCTL rotation/remap is
 * recorded but not applied (GRAM is straight x/y); unknown commands are
 * counted and their data ignored.
 */

/** ILI9341 command bytes the model understands. */
export const ILI = {
    NOP: 0x00, SWRESET: 0x01, SLPOUT: 0x11, DISPOFF: 0x28, DISPON: 0x29,
    CASET: 0x2A, RASET: 0x2B, RAMWR: 0x2C, MADCTL: 0x36, COLMOD: 0x3A,
};

/** Decode one big-endian RGB565 word to a 24-bit RGB triple. */
export function rgb565ToRgb(word) {
    return [
        ((word >> 11) & 0x1f) << 3 | ((word >> 13) & 0x07),
        ((word >> 5) & 0x3f) << 2 | ((word >> 9) & 0x03),
        (word & 0x1f) << 3 | (word & 0x07),
    ];
}

/** GRAM (Uint16Array RGB565) → RGBA Uint8ClampedArray, 4 bytes/pixel. */
export function rgb565ToRgba(gram, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const v = gram[i];
        out[4 * i] = ((v >> 11) & 0x1f) << 3 | ((v >> 13) & 0x07);
        out[4 * i + 1] = ((v >> 5) & 0x3f) << 2 | ((v >> 9) & 0x03);
        out[4 * i + 2] = (v & 0x1f) << 3 | (v & 0x07);
        out[4 * i + 3] = 255;
    }
    return out;
}

/**
 * ILI9341 model. Feed it D/C-classified transactions:
 *   command(byte) — D/C low transaction (first byte; extras are ignored,
 *     real drivers send commands as single-byte transactions);
 *   data(Uint8Array) — D/C high transaction consumed per the active
 *     command (window params, COLMOD/MADCTL, or the RAMWR pixel stream).
 * Visible-state changes return true from the feeding methods (the plugin
 * throttles state pushes on it); `frames` counts completed full-window
 * RAMWR fills (a cheap proxy for "the screen changed wholesale").
 */
export class Ili9341Model {
    constructor(width = 320, height = 240) {
        this.width = clampDim(width, 320);
        this.height = clampDim(height, 240);
        this.reset();
    }

    reset() {
        this.gram = new Uint16Array(this.width * this.height); // black
        this.win = { x0: 0, x1: this.width - 1, y0: 0, y1: this.height - 1 };
        this.cursor = { x: 0, y: 0 };
        this.ramwr = false;        // RAMWR pixel stream active
        this.partial = '';         // CASET/RASET parameter accumulator
        this.partialFor = null;
        this.colmod = 0x66;        // POR: 18-bit (datasheet); drivers set 0x55
        this.colmodSet = false;    // an explicit COLMOD parameter arrived
        this.madctl = 0;
        this.sleep = true;         // POR: sleep-in
        this.displayOn = false;
        this.lastCmd = null;
        this.cmdCount = 0;
        this.dataBytes = 0;
        this.frames = 0;
        this.pixelsWritten = 0;
        this.unknownCmds = 0;
        this.carry = [];          // partial pixel straddling transactions
    }

    /** D/C low transaction. Returns true when visible state changed. */
    command(byte) {
        const b = byte & 0xff;
        this.lastCmd = b;
        this.cmdCount++;
        this.ramwr = false;
        this.partial = '';
        this.partialFor = null;
        switch (b) {
            case ILI.SWRESET: {
                const { gram, frames } = this;
                const w = this.width, h = this.height;
                this.reset();
                this.gram = gram;      // SWRESET keeps GRAM content
                this.frames = frames;
                return true;
            }
            case ILI.SLPOUT: this.sleep = false; return true;
            case ILI.DISPOFF: this.displayOn = false; return true;
            case ILI.DISPON: this.displayOn = true; return true;
            case ILI.RAMWR:
                this.ramwr = true;
                this.cursor = { x: this.win.x0, y: this.win.y0 };
                return false;
            case ILI.CASET:
            case ILI.RASET:
                this.partialFor = b;
                return false;
            case ILI.MADCTL:
            case ILI.COLMOD:
                this.partialFor = b;
                return false;
            default:
                this.unknownCmds++;
                return false;
        }
    }

    /** D/C high transaction. Returns true when visible state changed. */
    data(bytes) {
        if (bytes.length === 0) return false;
        this.dataBytes += bytes.length;
        if (this.partialFor === ILI.CASET || this.partialFor === ILI.RASET) {
            // one data() call is one transaction: 4 bytes = full big-endian
            // range, 2 bytes = start = end (both datasheet forms). Params
            // split across transactions would misalign — drivers send them
            // whole (esp_lcd included).
            this.partial += hexPair(bytes);
            if (this.partial.length === 4 || this.partial.length >= 8) {
                this._applyWindow();
            }
            return false;
        }
        if (this.partialFor === ILI.COLMOD) {
            const v = bytes[0] & 0xff;
            if (v === 0x55 || v === 0x66) {
                this.colmod = v;
                this.colmodSet = true;
            }
            this.partialFor = null;
            return false;
        }
        if (this.partialFor === ILI.MADCTL) {
            this.madctl = bytes[0] & 0xff;
            this.partialFor = null;
            return false;
        }
        if (this.ramwr) return this._pixels(bytes);
        return false;                        // data outside any context
    }

    /** True when the RAMWR stream is active (the plugin walks DMA then). */
    get ramwrActive() {
        return this.ramwr;
    }

    _applyWindow() {
        const parts = this.partial.match(/../g) || [];
        const vals = parts.map((h) => parseInt(h, 16));
        const isX = this.partialFor === ILI.CASET;
        if (vals.length === 2) {
            // 2-byte form: one big-endian value, start = end
            const v = ((vals[0] << 8) | vals[1]) & 0xffff;
            this._setWindow(isX, v, v);
        } else if (vals.length >= 4) {
            this._setWindow(isX, (vals[0] << 8) | vals[1], (vals[2] << 8) | vals[3]);
        }
        this.partial = '';
        this.partialFor = null;
        this.ramwr = false;
    }

    _setWindow(isX, a, b) {
        const max = (isX ? this.width : this.height) - 1;
        const lo = Math.max(0, Math.min(a, b, max));
        const hi = Math.max(0, Math.min(Math.max(a, b), max));
        if (isX) this.win = { ...this.win, x0: lo, x1: hi };
        else this.win = { ...this.win, y0: lo, y1: hi };
        this.cursor = { x: this.win.x0, y: this.win.y0 };
    }

    _pixels(bytes) {
        /* COLMOD fallback: a lost 1-byte COLMOD transaction (DMA segment too
         * short to catch — see the device notes) must not garble the whole
         * stream: esp_lcd-class drivers set 16-bit RGB565, so an explicit
         * COLMOD wins but a missing one decodes as 0x55. */
        const colmod = this.colmodSet ? this.colmod : 0x55;
        const bpp = colmod === 0x55 ? 2 : 3;
        let changed = false;
        let i = 0;
        // a partial pixel may straddle transactions: complete the carry first
        if (this.carry.length > 0) {
            while (this.carry.length < bpp && i < bytes.length) this.carry.push(bytes[i++]);
            if (this.carry.length === bpp) {
                this._putPixel(this.carry);
                this.carry = [];
                changed = true;
            } else {
                return false;   // still incomplete — nothing more to do
            }
        }
        for (; i + bpp <= bytes.length; i += bpp) {
            this._putPixel(bytes.subarray(i, i + bpp));
            changed = true;
        }
        for (; i < bytes.length; i++) this.carry.push(bytes[i]);
        return changed;
    }

    _putPixel(b) {
        let v;
        if (this.colmodSet ? this.colmod === 0x55 : true) {
            v = ((b[0] << 8) | b[1]) & 0xffff;          // big-endian stream
        } else {
            // 18-bit: take the high bits of each byte into RGB565
            v = ((b[0] >> 3) << 11) | ((b[1] >> 2) << 5) | (b[2] >> 3);
        }
        const { x, y } = this.cursor;
        this.gram[y * this.width + x] = v;
        this.pixelsWritten++;
        if (x === this.win.x1 && y === this.win.y1) {
            this.frames++;                                // full window filled
            this.cursor = { x: this.win.x0, y: this.win.y0 };
            return;
        }
        this.cursor = x === this.win.x1
            ? { x: this.win.x0, y: Math.min(y + 1, this.win.y1) }
            : { x: x + 1, y };
    }

    /** Lightweight snapshot for getState (GRAM travels separately). */
    snapshot() {
        return {
            width: this.width, height: this.height,
            win: { ...this.win },
            colmod: this.colmod, madctl: this.madctl,
            sleep: this.sleep, displayOn: this.displayOn,
            lastCmd: this.lastCmd, cmdCount: this.cmdCount,
            dataBytes: this.dataBytes, frames: this.frames,
            pixelsWritten: this.pixelsWritten, unknownCmds: this.unknownCmds,
        };
    }
}

function hexPair(bytes) {
    let s = '';
    for (const b of bytes) s += (b & 0xff).toString(16).padStart(2, '0');
    return s;
}

export function clampDim(v, dflt) {
    const n = Math.round(Number(v));
    return Number.isInteger(n) && n >= 1 && n <= 480 ? n : dflt;
}

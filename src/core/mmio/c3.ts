/*
 * ESP32-C3 MMIO register map (byte addresses, little-endian). Verified
 * against ESP-IDF soc headers and the running emulator in M0 — see
 * docs/FEASIBILITY.md. Data lives in TS (not JSON) so tsc ships it without
 * a copy step.
 */
export interface ChipMmio {
    gpio: { base: number; out: number; enable: number; funcOutSelBase: number; funcOutSelStride: number };
    ioMux: { base: number; pinStride: number; pinBase: number };
    ledc: {
        base: number; chStride: number; dutyShift: number;
        ch: (n: number) => { conf0: number; hpoint: number; duty: number; conf1: number; dutyR: number };
    };
    rmt: {
        base: number; ch0conf0: number; ch1conf0: number;
        memBase: number; memWordsPerChannel: number; chStride: number;
    };
    /** GPIO-matrix signal ids observed on this chip (M0). */
    signals: Record<string, number>;
}

export const esp32c3: ChipMmio = {
    gpio: {
        base: 0x60004000,
        out: 0x60004004,
        enable: 0x60004020,
        funcOutSelBase: 0x60004000 + 0x554, // FUNC0; +4*pin
        funcOutSelStride: 4,
    },
    ioMux: {
        base: 0x60009000,
        pinBase: 0x04,   // GPIO0..11 contiguous at base + 0x04 + 4*pin
        pinStride: 4,
    },
    ledc: {
        base: 0x60019000,
        chStride: 0x14,
        dutyShift: 4,    // DUTY_CHn field is bits [18:4]: reg = duty << 4
        ch: (n: number) => ({
            conf0: 0x60019000 + 0x14 * n,
            hpoint: 0x60019000 + 0x14 * n + 0x4,
            duty: 0x60019000 + 0x14 * n + 0x8,
            conf1: 0x60019000 + 0x14 * n + 0xc,
            dutyR: 0x60019000 + 0x14 * n + 0x10,
        }),
    },
    rmt: {
        base: 0x60016000,
        ch0conf0: 0x60016010,
        ch1conf0: 0x60016014,
        memBase: 0x60016400, // RMTMEM; ch n at memBase + 0xC0*n
        memWordsPerChannel: 48,
        chStride: 0xc0,
    },
    signals: {
        // FUNCn_OUT_SEL values observed when firmware routes a pad (M0)
        ledcCh0: 0x2d,
        rmtCh0: 0x33,
    },
};

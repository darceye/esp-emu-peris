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
        /** Hardware LEDC channels (C3: 6). */
        channelCount: number;
        ch: (n: number) => { conf0: number; hpoint: number; duty: number; conf1: number; dutyR: number };
        /** Timer config registers hold DUTY_RES (bits[3:0]). */
        timer: (n: number) => { conf: number };
    };
    rmt: {
        base: number;
        /** Channel RAM blocks (C3: 4, but only txChannelCount can drive a pad). */
        channelCount: number;
        /** Channels with a GPIO-matrix output signal (C3: 2 TX channels). */
        txChannelCount: number;
        memBase: number; memWordsPerChannel: number; chStride: number;
        /** RMT_STATE shift in CHnSTATUS (bits[11:9] on C3; [24:22] on S3) —
         * nonzero while transmitting. */
        stateShift: number;
        /** Per-channel registers: mem = RMTMEM block start, status = CHnSTATUS. */
        ch: (n: number) => { mem: number; status: number };
    };
    /** GPIO-matrix signal ids observed on this chip (M0 + IDF gpio_sig_map.h). */
    signals: Record<string, number>;
    /**
     * Hardware SPI2 (GP-SPI) register-level access — M5: the peripheral is
     * modelled, TX is observable (W window no-DMA / GDMA chain for DMA),
     * RX is synthetic 0xff. See docs/SPI-M5.md. Optional: chips without a
     * table make register-level SPI devices idle.
     */
    spi?: {
        base: number;
        cmd: number;
        /** W0..W15 staging window (64 bytes; byte i of a word at bits [8i+7:8i]). */
        wBase: number;
        wWords: number;
        /** MS_DLEN: bits[17:0] = transfer length in bits − 1 (M5 measured). */
        msDlen: number;
        /** GDMA outlink registers per TX channel; value = low `addrBits` of
         * the first descriptor, absolute address = dramBase | value. The
         * pointer stays readable after completion (M5: no race needed). */
        gdma: {
            outLink: number[];
            addrBits: number;
            dramBase: number;
        };
    };
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
        channelCount: 6, // LEDC_LS_SIG_OUT0..5
        ch: (n: number) => ({
            conf0: 0x60019000 + 0x14 * n,           // timer_sel[1:0], sig_out_en bit2
            hpoint: 0x60019000 + 0x14 * n + 0x4,
            duty: 0x60019000 + 0x14 * n + 0x8,
            conf1: 0x60019000 + 0x14 * n + 0xc,
            dutyR: 0x60019000 + 0x14 * n + 0x10,
        }),
        // LSTIMERn_CONF at base + 0xA0 + 8n; duty_resolution = bits[3:0]
        timer: (n: number) => ({ conf: 0x60019000 + 0xa0 + 0x8 * n }),
    },
    rmt: {
        base: 0x60016000,
        channelCount: 4,
        txChannelCount: 2, // RMT_SIG_OUT0/1 only (gpio_sig_map.h); ch2/3 are RX
        memBase: 0x60016400, // RMTMEM; ch n at memBase + 0xC0*n
        memWordsPerChannel: 48,
        chStride: 0xc0,
        stateShift: 9, // CHnSTATUS at base + 0x28 + 4n; RMT_STATE bits[11:9]
        ch: (n: number) => ({ mem: 0x60016400 + 0xc0 * n, status: 0x60016000 + 0x28 + 4 * n }),
    },
    signals: {
        // FUNCn_OUT_SEL values when firmware routes a pad: M0 measured ch0,
        // ch1..5 from components/soc/esp32c3/.../gpio_sig_map.h (45..50)
        ledcCh0: 0x2d,
        ledcCh1: 0x2e,
        ledcCh2: 0x2f,
        ledcCh3: 0x30,
        ledcCh4: 0x31,
        ledcCh5: 0x32,
        // RMT_SIG_OUT0/1 — C3 has only two TX channels routed to pads
        // (ch2/3 are RX-only, no output signal), verified vs gpio_sig_map.h
        rmtCh0: 0x33,
        rmtCh1: 0x34,
        // GP-SPI2 (FSPI) matrix signals — M5 measured sclk/d/q routing live;
        // full set from gpio_sig_map.h. C3 OUT_SEL field is 8 bits, plain
        // GPIO = 0x80 (not 9-bit/0x100 as on S3-class chips).
        spiClk: 63,
        spiQ: 64,   // MISO (FSPIQ_OUT routes on the pad but oe stays off)
        spiD: 65,   // MOSI
        spiHd: 66,
        spiWp: 67,
        spiCs0: 68,
        spiCs1: 69,
        spiCs2: 70,
        spiCs3: 71,
        spiCs4: 72,
        spiCs5: 73,
    },
    spi: {
        base: 0x60024000,          // GPSPI2 (M5: register file readable, transfers complete)
        cmd: 0x60024000,           // bit0 = USR (never host-visible — resolves on guest access)
        wBase: 0x60024098,         // W0; +4*n up to W15
        wWords: 16,                // 64-byte staging window
        msDlen: 0x6002401c,        // bits[17:0] = transfer bits − 1
        gdma: {
            // GDMA_OUT_LINK_CHn_REG (0x6003F000 + 0xE0 + 0xC0*n); the addr
            // field is the low 20 bits of the first lldesc (0x3FC00000-based
            // DRAM). M5 measured: valid during AND after the transfer.
            outLink: [0x6003f0e0, 0x6003f1a0, 0x6003f260],
            addrBits: 20,
            dramBase: 0x3fc00000,
        },
    },
};

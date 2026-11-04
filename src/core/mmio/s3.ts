/*
 * ESP32-S3 MMIO register map. Addresses from ESP-IDF (master, components/
 * soc/esp32s3/register/soc/reg_base.h + per-peripheral *_reg.h, gpio_sig_map.h)
 * and verified against the running wasm emulator with the duel_of_8 0.3.0
 * firmware (hardware-SPI MAX7219, SPI_DMA_CH_AUTO) — see tests/m7_smoke.mjs.
 *
 * S3 vs C3 differences that bite register-level devices (AGENT.md §2):
 *   - GPIO_FUNCn_OUT_SEL field is 9 bits; plain GPIO reads 0x100 (C3: 8
 *     bits / 0x80). The wiring scans mask with 0x1ff, which covers both.
 *   - LEDC DUTY/DUTY_R fields are bits [18:0] (C3: [18:4]) → dutyShift 0.
 *   - RMT: 4 TX channels (C3: 2), RMT_STATE in CHnSTATUS is bits [24:22]
 *     (C3: [11:9]) → rmt.stateShift, and RMTMEM sits at base + 0x800
 *     (C3: +0x400).
 *   - GDMA has 5 channels; OUT_LINK_CHn at base + 0x80 + 0xC0*n (C3:
 *     0xE0 + 0xC0*n, 3 channels). The address field is 20 bits on both.
 */
import type { ChipMmio } from './c3.js';

export const esp32s3: ChipMmio = {
    gpio: {
        base: 0x60004000,
        out: 0x60004004,
        enable: 0x60004020,
        funcOutSelBase: 0x60004000 + 0x554, // FUNC0; +4*pin (same slot as C3)
        funcOutSelStride: 4,
    },
    ioMux: {
        base: 0x60009000,
        pinBase: 0x04,   // GPIO0..21 contiguous at base + 0x04 + 4*pin
        pinStride: 4,
    },
    ledc: {
        base: 0x60019000,
        chStride: 0x14,
        dutyShift: 0,    // DUTY_CHn field is bits [18:0]: reg = duty << 0
        channelCount: 8, // LEDC_LS_SIG_OUT0..7
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
        channelCount: 8,
        txChannelCount: 4, // RMT_SIG_OUT0..3; ch4..7 are RX
        memBase: 0x60016800, // RMTMEM (ld: PROVIDE(RMTMEM = 0x60016800)); ch n at +0xC0*n
        memWordsPerChannel: 48,
        chStride: 0xc0,
        stateShift: 22, // RMT_STATE bits[24:22] in CHnSTATUS
        // TX CHnSTATUS at base + 0x50 + 4n (chnstatus[4] in rmt_dev_t)
        ch: (n: number) => ({ mem: 0x60016800 + 0xc0 * n, status: 0x60016000 + 0x50 + 4 * n }),
    },
    signals: {
        // gpio_sig_map.h: LEDC_LS_SIG_OUT0..7 = 73..80, RMT_SIG_OUT0..3 =
        // 81..84, FSPI matrix signals 101..105 / 110..115
        ledcCh0: 73,
        ledcCh1: 74,
        ledcCh2: 75,
        ledcCh3: 76,
        ledcCh4: 77,
        ledcCh5: 78,
        ledcCh6: 79,
        ledcCh7: 80,
        rmtCh0: 81,
        rmtCh1: 82,
        rmtCh2: 83,
        rmtCh3: 84,
        // GP-SPI2 (FSPI) matrix signals — OUT_SEL field is 9 bits on S3,
        // plain GPIO = 0x100; verified live by m7_smoke (MOSI GPIO21 /
        // SCLK GPIO13 discovery).
        spiClk: 101,
        spiQ: 102,   // MISO
        spiD: 103,   // MOSI
        spiHd: 104,
        spiWp: 105,
        spiCs0: 110,
        spiCs1: 111,
        spiCs2: 112,
        spiCs3: 113,
        spiCs4: 114,
        spiCs5: 115,
    },
    spi: {
        base: 0x60024000,          // GPSPI2 (REG_SPI_BASE(2)); same GP-SPI2 layout as C3
        cmd: 0x60024000,
        wBase: 0x60024098,         // W0; +4*n up to W15
        wWords: 16,
        msDlen: 0x6002401c,        // bits[17:0] = transfer bits − 1
        gdma: {
            // GDMA_OUT_LINK_CHn_REG (0x6003F000 + 0x80 + 0xC0*n); the addr
            // field is the low 20 bits of the first lldesc (0x3FC00000-based
            // DRAM). S3 has 5 channels (C3: 3, at +0xE0).
            outLink: [0x6003f080, 0x6003f140, 0x6003f200, 0x6003f2c0, 0x6003f380],
            addrBits: 20,
            dramBase: 0x3fc00000,
        },
    },
};

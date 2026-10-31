/*
 * peris_probe — M0 feasibility firmware for esp-emu-peris.
 *
 * Runs four phases in an endless loop, each announced on UART0 with
 * distinctive "###" markers so an external probe can sync on them:
 *
 *   P1  plain GPIO blink on GPIO 8 (2 Hz) — proves gpio_state() polling.
 *       While blinking, GPIO 3 is an input with a falling-edge ISR whose
 *       count is printed every half period — proves gpio_set_input() can
 *       drive pins *and* raise interrupts in the guest.
 *   P1b digital-in sampling (2 s, one line every 125 ms): GPIO 0 carries
 *       the toggle-switch level, GPIO 18 the touch pad (active-low, the
 *       touch peripheral itself is not emulated), GPIO 3 reappears as a
 *       plain level. The blink LED mirrors the switch so flipping it is
 *       visible without the UART, and touch press edges (falling) are
 *       counted — exercises the toggle-switch and touch-button devices
 *       from an imported wiring config (examples/esp32c3-probe.json).
 *   P2  LEDC breathing on GPIO 9 (5 kHz / 13-bit duty ramp) — lets the
 *       probe check whether PWM is observable at the pad register and
 *       whether the LEDC duty registers track the requested duty.
 *       Channels 1 (GPIO 6, mirrored counter-ramp) and 2 (GPIO 7, constant
 *       half duty) run alongside since M2 so multi-channel devices (RGB
 *       LED) are exercised too; the ###P2 markers still describe ch0 only.
 *   P2b one-shot extremes (duty 0 / 50% / max for 300 ms each) so duty
 *       estimates have flat, unambiguous windows to be measured against.
 *   P3  RMT WS2812 bursts on GPIO 4 (8 LEDs, colour walk, frame logged
 *       *before* it is sent) — lets the probe switch to high-rate pin
 *       sampling in time to catch the waveform, and separately dump the
 *       RMT channel RAM to decode the frame from symbols. Since M3 a
 *       trailing non-uniform "grad" burst (red, green, blue n-1) pins
 *       per-LED tail alignment of RAM-window decoders.
 *   P4  bit-bang protocol traffic (M4): a software I2C master (~25 kHz,
 *       open-drain idiom: drive low = output 0, release = switched input
 *       with pull-up) talks to the emulated 24C02 EEPROM at 0x50 and the
 *       emulated BME280 at 0x76 on SCL=GPIO1/SDA=GPIO2 — write/readback
 *       patterns, the register file incl. factory calibration, and forced
 *       measurements whose raw adc values and Bosch-compensated results
 *       are printed so the probe can cross-check the slave model. NEC IR
 *       codes go out twice: bit-banged on GPIO 5 (38 kHz carrier, envelope
 *       the probe must catch with fine-grained sampling) and carrier-less
 *       through RMT ch1 on GPIO 10 (1 MHz resolution → 34-symbol frames
 *       that fit a post-transmission 48-word channel-RAM window).
 *
 * The driver paths used here mirror esp-emulator's own smoke test app
 * (gpio_config, legacy ledc_* driver, rmt_new_tx_channel + copy encoder),
 * which the emulator is known to support.
 */
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/rmt_tx.h"
#include "esp_rom_sys.h"

#define PIN_GPIO   8                       /* P1: plain blink            */
#define PIN_BTN    3                       /* P1: driven input + ISR     */
#define PIN_SWITCH 0                       /* P1b: toggle-switch level   */
#define PIN_TOUCH  18                      /* P1b: touch pad, active-low */
#define PIN_LEDC   9                       /* P2: LEDC PWM ch0           */
#define PIN_LEDC1  6                       /* P2: LEDC PWM ch1           */
#define PIN_LEDC2  7                       /* P2: LEDC PWM ch2           */
#define PIN_RMT    4                       /* P3: RMT WS2812             */
#define PIN_I2C_SCL 1                      /* P4: soft I2C clock         */
#define PIN_I2C_SDA 2                      /* P4: soft I2C data          */
#define PIN_IR_BB   5                      /* P4: NEC bit-bang TX        */
#define PIN_IR_RMT  10                     /* P4: NEC RMT ch1 TX         */
#define LED_COUNT  8
#define RMT_RES_HZ (10 * 1000 * 1000)      /* 0.1 us per RMT tick        */
#define I2C_HALF_US 25                     /* ~20 kHz soft I2C           */
#define IR_CARRIER_HALF_US 13              /* ~38 kHz NEC carrier        */

static rmt_channel_handle_t s_chan;
static rmt_encoder_handle_t s_enc;
static rmt_symbol_word_t s_syms[LED_COUNT * 24 + 1];
static volatile int s_btn_count;

static void IRAM_ATTR btn_isr(void *arg)
{
    s_btn_count++;
}

/* GRB order, MSB first. T1H/T1L = 0.8/0.5 us, T0H/T0L = 0.4/0.8 us at
 * 0.1 us per tick, trailing >60 us low reset. */
static void ws2812_build_n(const uint32_t *rgb)
{
    int n = 0;
    for (int led = 0; led < LED_COUNT; led++) {
        uint8_t grb[3] = { (rgb[led] >> 8) & 0xFF, (rgb[led] >> 16) & 0xFF, rgb[led] & 0xFF };
        for (int b = 0; b < 24; b++, n++) {
            int one = (grb[b / 8] >> (7 - (b % 8))) & 1;
            s_syms[n].duration0 = one ? 8 : 4;
            s_syms[n].level0 = 1;
            s_syms[n].duration1 = one ? 5 : 8;
            s_syms[n].level1 = 0;
        }
    }
    s_syms[n].duration0 = 600;
    s_syms[n].level0 = 0;
    s_syms[n].duration1 = 1;
    s_syms[n].level1 = 0;
}

static void ws2812_build(uint32_t rgb)
{
    uint32_t uniform[LED_COUNT];
    for (int i = 0; i < LED_COUNT; i++) uniform[i] = rgb;
    ws2812_build_n(uniform);
}

static void ws2812_send(void)
{
    rmt_transmit_config_t tx = { .loop_count = 0 };
    esp_err_t err = rmt_transmit(s_chan, s_enc, s_syms, sizeof(s_syms), &tx);
    if (err != ESP_OK) {
        printf("###ERR rmt_transmit %d\n", err);
        return;
    }
    err = rmt_tx_wait_all_done(s_chan, 100);
    if (err != ESP_OK) {
        printf("###ERR rmt_wait %d\n", err);
    }
}

/* ---- P4a: software I2C master (open-drain idiom) ------------------------- */
/*
 * A soft master the emulated slave can genuinely talk to: "drive low" is
 * output-0, "release" switches the pad to a pulled-up input — so when the
 * guest releases SDA, gpio_get_level() reads the level the *device* drives
 * via gpio_set_input() (the ACK / read-data path; M0 Q1b proved that input
 * path reaches the guest). SCL is never stretched by the slave models.
 */
static void i2c_hold(int pin)
{
    gpio_set_level(pin, 0);
    gpio_set_direction(pin, GPIO_MODE_OUTPUT);
}

static void i2c_release(int pin)
{
    gpio_set_level(pin, 1);
    gpio_set_direction(pin, GPIO_MODE_INPUT); /* pull-up enabled at boot */
}

static int i2c_sda(void)
{
    return gpio_get_level(PIN_I2C_SDA);
}

static void i2c_start(void)
{
    i2c_release(PIN_I2C_SCL);
    i2c_release(PIN_I2C_SDA);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_hold(PIN_I2C_SDA);            /* START: SDA falls while SCL high */
    esp_rom_delay_us(I2C_HALF_US);
    i2c_hold(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);
}

static void i2c_stop(void)
{
    i2c_hold(PIN_I2C_SCL);
    i2c_hold(PIN_I2C_SDA);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_release(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_release(PIN_I2C_SDA);         /* STOP: SDA rises while SCL high */
    esp_rom_delay_us(I2C_HALF_US);
}

static void i2c_write_bit(int bit)
{
    if (bit) i2c_release(PIN_I2C_SDA); else i2c_hold(PIN_I2C_SDA);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_release(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);    /* slave samples on this edge      */
    i2c_hold(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);
}

static int i2c_read_bit(void)
{
    i2c_release(PIN_I2C_SDA);         /* let the slave drive the line   */
    esp_rom_delay_us(I2C_HALF_US);
    i2c_release(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);
    int bit = i2c_sda();              /* sample while SCL high          */
    i2c_hold(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_release(PIN_I2C_SDA);
    return bit;
}

/** Shift one byte out (MSB first), return the ACK bit (0 = acked). */
static int i2c_tx_byte(uint8_t v)
{
    for (int i = 7; i >= 0; i--) i2c_write_bit((v >> i) & 1);
    return i2c_read_bit();
}

/** Shift one byte in (MSB first), then ACK (ack=1) or NACK it. */
static uint8_t i2c_rx_byte(int ack)
{
    uint8_t v = 0;
    for (int i = 0; i < 8; i++) v = (uint8_t)((v << 1) | i2c_read_bit());
    if (ack) i2c_hold(PIN_I2C_SDA); else i2c_release(PIN_I2C_SDA);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_release(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_hold(PIN_I2C_SCL);
    esp_rom_delay_us(I2C_HALF_US);
    i2c_release(PIN_I2C_SDA);
    return v;
}

/** addr<<1 | rw, then data; returns the number of NACKed bytes (0 = clean). */
static int i2c_write(uint8_t addr7, const uint8_t *data, int n)
{
    int bad = 0;
    i2c_start();
    if (i2c_tx_byte((uint8_t)(addr7 << 1))) bad++;
    for (int i = 0; i < n; i++) if (i2c_tx_byte(data[i])) bad++;
    i2c_stop();
    return bad;
}

/** set pointer (write), repeated start, n sequential reads. 0 = clean. */
static int i2c_read(uint8_t addr7, uint8_t ptr, uint8_t *out, int n)
{
    int bad = 0;
    i2c_start();
    if (i2c_tx_byte((uint8_t)(addr7 << 1))) bad++;
    if (i2c_tx_byte(ptr)) bad++;
    i2c_start();                       /* repeated START */
    if (i2c_tx_byte((uint8_t)(addr7 << 1 | 1))) bad++;
    for (int i = 0; i < n; i++) out[i] = i2c_rx_byte(i < n - 1);
    i2c_stop();
    return bad;
}

/* ---- P4a: BME280 client (probe-side view of the emulated sensor) --------- */

#define BME_ADDR   0x76
#define EE_ADDR    0x50
#define BME_REG_ID 0xD0

/* dig_* are read back from the emulated calibration block; the values below
 * only shape the printf check-lines, they are NOT used for compensation. */
/* NB dig_T1/dig_P1 are uint16 in the Bosch layout — P1 (36477 here)
 * overflows int16_t and silently turns negative (a real M4 bug). */
static uint16_t dig_T1, dig_P1;
static int16_t dig_T2, dig_T3, dig_P2, dig_P3, dig_P4, dig_P5,
    dig_P6, dig_P7, dig_P8, dig_P9, dig_H2, dig_H3, dig_H4, dig_H5, dig_H6;
static uint8_t dig_H1;
static int32_t t_fine;

/* Bosch reference compensation (BME280_driver float-free path). The probe
 * cross-checks the emulated calibration block: the same raw adc values must
 * produce these results in C and in the JS model (tests + device View). */
static int32_t bme_compensate_T(int32_t adc_T)
{
    int32_t var1 = ((((adc_T >> 3) - ((int32_t)dig_T1 << 1))) * (int32_t)dig_T2) >> 11;
    int32_t var2 = (((((adc_T >> 4) - (int32_t)dig_T1) * ((adc_T >> 4) - (int32_t)dig_T1)) >> 12)
                    * (int32_t)dig_T3) >> 14;
    t_fine = var1 + var2;
    return (t_fine * 5 + 128) >> 8;              /* 0.01 °C */
}

static int32_t bme_compensate_P(int32_t adc_P)
{
    int64_t var1 = ((int64_t)t_fine) - 128000;
    int64_t var2 = var1 * var1 * (int64_t)dig_P6;
    var2 = var2 + ((var1 * (int64_t)dig_P5) << 17);
    var2 = var2 + (((int64_t)dig_P4) << 35);
    var1 = ((var1 * var1 * (int64_t)dig_P3) >> 8) + ((var1 * (int64_t)dig_P2) << 12);
    var1 = (((((int64_t)1) << 47) + var1) * (int64_t)dig_P1) >> 33;
    if (var1 == 0) return 0;
    int64_t p = 1048576 - adc_P;
    p = (((p << 31) - var2) * 3125) / var1;
    var1 = ((int64_t)dig_P9 * (p >> 13) * (p >> 13)) >> 25;
    var2 = ((int64_t)dig_P8 * p) >> 19;
    p = ((p + var1 + var2) >> 8) + (((int64_t)dig_P7) << 4);
    return (int32_t)p;                           /* Pa */
}

static uint32_t bme_compensate_H(int32_t adc_H)
{
    int32_t v = (t_fine - 76800);
    v = (((((adc_H << 14) - (((int32_t)dig_H4) << 20) - ((int32_t)dig_H5 * v)) + 16384) >> 15)
         * (((((((v * (int32_t)dig_H6) >> 10) * (((v * (int32_t)dig_H3) >> 11) + 32768)) >> 10)
               + 2097152) * (int32_t)dig_H2 + 8192) >> 14));
    v = v - (((((v >> 15) * (v >> 15)) >> 7) * (int32_t)dig_H1) >> 4);
    if (v < 0) v = 0;
    if (v > 419430400) v = 419430400;
    return (uint32_t)(v >> 12);                  /* %RH ×1024 */
}

/* ---- P4b: NEC IR encoders ------------------------------------------------ */

static void ir_carrier_us(int us)
{
    for (int t = 0; t < us; t += 2 * IR_CARRIER_HALF_US) {
        gpio_set_level(PIN_IR_BB, 1);
        esp_rom_delay_us(IR_CARRIER_HALF_US);
        gpio_set_level(PIN_IR_BB, 0);
        esp_rom_delay_us(IR_CARRIER_HALF_US);
    }
}

static void ir_space_us(int us)
{
    gpio_set_level(PIN_IR_BB, 0);
    esp_rom_delay_us(us);
}

static void ir_bb_bit(int bit)
{
    ir_carrier_us(560);
    ir_space_us(bit ? 1690 : 560);
}

/** One full NEC frame, address + command + inverses, LSB first per byte. */
/* Real NEC bit order: addr, ~addr, cmd, ~cmd, each byte LSB first. */
static void ir_bb_frame(uint16_t addr, uint8_t cmd)
{
    const uint8_t bytes[4] = { (uint8_t)addr, (uint8_t)~addr, cmd, (uint8_t)~cmd };
    ir_carrier_us(9000);
    ir_space_us(4500);
    for (int k = 0; k < 4; k++)
        for (int i = 0; i < 8; i++) ir_bb_bit((bytes[k] >> i) & 1);
    ir_carrier_us(560);                /* stop burst */
    ir_space_us(300);
}

static void ir_bb_repeat(void)
{
    ir_carrier_us(9000);
    ir_space_us(2250);
    ir_carrier_us(560);
    ir_space_us(300);
}

/* RMT version: carrier-less envelope symbols at 1 MHz resolution. */
#define IR_RMT_RES_HZ (1000 * 1000)
static rmt_channel_handle_t s_ir_chan;
static rmt_encoder_handle_t s_ir_enc;
static rmt_symbol_word_t s_ir_syms[36];

static void ir_rmt_word(int i, uint32_t dur0, uint32_t dur1)
{
    s_ir_syms[i].duration0 = dur0;
    s_ir_syms[i].level0 = 1;
    s_ir_syms[i].duration1 = dur1;
    s_ir_syms[i].level1 = 0;
}

static void ir_rmt_frame(uint16_t addr, uint8_t cmd)
{
    const uint8_t bytes[4] = { (uint8_t)addr, (uint8_t)~addr, cmd, (uint8_t)~cmd };
    int i = 0;
    ir_rmt_word(i++, 9000, 4500);
    for (int k = 0; k < 4; k++) {
        for (int b = 0; b < 8; b++) {
            int one = (bytes[k] >> b) & 1;
            ir_rmt_word(i++, 560, one ? 1690 : 560);
        }
    }
    ir_rmt_word(i++, 560, 20000); /* stop burst + long idle tail */
    rmt_transmit_config_t tx = { .loop_count = 0 };
    esp_err_t err = rmt_transmit(s_ir_chan, s_ir_enc, s_ir_syms, i * sizeof(s_ir_syms[0]), &tx);
    if (err != ESP_OK) printf("###ERR ir rmt_transmit %d\n", err);
    err = rmt_tx_wait_all_done(s_ir_chan, 100);
    if (err != ESP_OK) printf("###ERR ir rmt_wait %d\n", err);
}

static void ir_rmt_repeat(void)
{
    int i = 0;
    ir_rmt_word(i++, 9000, 2250);
    ir_rmt_word(i++, 560, 20000);
    rmt_transmit_config_t tx = { .loop_count = 0 };
    esp_err_t err = rmt_transmit(s_ir_chan, s_ir_enc, s_ir_syms, i * sizeof(s_ir_syms[0]), &tx);
    if (err != ESP_OK) printf("###ERR ir rmt_transmit %d\n", err);
    err = rmt_tx_wait_all_done(s_ir_chan, 100);
    if (err != ESP_OK) printf("###ERR ir rmt_wait %d\n", err);
}

/* ---- P4 driver ----------------------------------------------------------- */

static void p4_run(int round)
{
    printf("###P4 start\n");

    /* 24C02 EEPROM: write + sequential read-back, pointer wrap at the end.
     * An EEPROM write transaction is [pointer, data...] in one go. */
    static const uint8_t wr[9] = { 0x10, 0xA5, 0x3C, 0x0F, 0xFF, 0x00, 0x55, 0x81, 0x7E };
    uint8_t rd[8];
    int bad = i2c_write(EE_ADDR, wr, 9);
    bad += i2c_read(EE_ADDR, 0x10, rd, 8);
    printf("###P4 eeprom ack=%d rd=%02x %02x %02x %02x %02x %02x %02x %02x\n",
           bad, rd[0], rd[1], rd[2], rd[3], rd[4], rd[5], rd[6], rd[7]);
    bad = i2c_write(EE_ADDR, ((uint8_t[]){ 0xFE, 0x11, 0x22 }), 3);
    bad += i2c_read(EE_ADDR, 0xFE, rd, 4); /* FE FF 00 01: wraps into erased ff */
    printf("###P4 eeprom ack=%d wrap=%02x %02x %02x %02x\n", bad, rd[0], rd[1], rd[2], rd[3]);

    /* BME280: id, calibration block, forced measurements */
    uint8_t id = 0, calib[26], hcal[7], meas[8];
    bad = i2c_read(BME_ADDR, BME_REG_ID, &id, 1);
    printf("###P4 bme id=0x%02x ack=%d\n", id, bad);
    bad = i2c_read(BME_ADDR, 0x88, calib, 26);
    bad += i2c_read(BME_ADDR, 0xE1, hcal, 7);
    dig_T1 = (int16_t)(calib[0] | (calib[1] << 8));
    dig_T2 = (int16_t)(calib[2] | (calib[3] << 8));
    dig_T3 = (int16_t)(calib[4] | (calib[5] << 8));
    dig_P1 = (int16_t)(calib[6] | (calib[7] << 8));
    dig_P2 = (int16_t)(calib[8] | (calib[9] << 8));
    dig_P3 = (int16_t)(calib[10] | (calib[11] << 8));
    dig_P4 = (int16_t)(calib[12] | (calib[13] << 8));
    dig_P5 = (int16_t)(calib[14] | (calib[15] << 8));
    dig_P6 = (int16_t)(calib[16] | (calib[17] << 8));
    dig_P7 = (int16_t)(calib[18] | (calib[19] << 8));
    dig_P8 = (int16_t)(calib[20] | (calib[21] << 8));
    dig_P9 = (int16_t)(calib[22] | (calib[23] << 8));
    dig_H1 = calib[25];
    dig_H2 = (int16_t)(hcal[0] | (hcal[1] << 8));
    dig_H3 = (int8_t)hcal[2];
    dig_H4 = (int16_t)(((int8_t)hcal[3] << 4) | (hcal[4] >> 4)); /* E5 hi -> H4 lo */
    dig_H5 = (int16_t)(((int8_t)hcal[5] << 4) | (hcal[4] & 0x0F)); /* E5 lo -> H5 lo */
    dig_H6 = (int8_t)hcal[6];
    uint8_t sum = 0;
    for (int i = 0; i < 26; i++) sum += calib[i];
    for (int i = 0; i < 7; i++) sum += hcal[i];
    printf("###P4 bme calib=0x%02x ack=%d\n", sum, bad);

    /* 3 forced measurements; the emulated sensor advances its fake signal
     * with every ctrl_meas write, so each round must print fresh values. */
    for (int m = 0; m < 3; m++) {
        bad = i2c_write(BME_ADDR, ((uint8_t[]){ 0xF2, 0x01 }), 2);       /* ctrl_hum */
        bad += i2c_write(BME_ADDR, ((uint8_t[]){ 0xF4, 0x25 }), 2);      /* forced  */
        vTaskDelay(pdMS_TO_TICKS(20));
        bad += i2c_read(BME_ADDR, 0xF7, meas, 8);
        uint32_t rp = ((uint32_t)meas[0] << 12) | ((uint32_t)meas[1] << 4) | (meas[2] >> 4);
        uint32_t rt = ((uint32_t)meas[3] << 12) | ((uint32_t)meas[4] << 4) | (meas[5] >> 4);
        uint32_t rh = ((uint32_t)meas[6] << 8) | meas[7];
        int32_t T = bme_compensate_T((int32_t)rt);
        int32_t P = bme_compensate_P((int32_t)rp);
        uint32_t H = bme_compensate_H((int32_t)rh);
        printf("###P4 bme m=%d ack=%d rt=%lu rp=%lu rh=%lu T=%ld P=%ld H=%lu\n",
               m, bad, (unsigned long)rt, (unsigned long)rp, (unsigned long)rh,
               (long)T, (long)P, (unsigned long)H);
        vTaskDelay(pdMS_TO_TICKS(50));
    }

    /* NEC: bit-bang first (fine-sampled envelope), then RMT ch1 (RAM) */
    static const struct { uint16_t a; uint8_t c; } codes[] = {
        { 0x00FF, 0x11 }, { 0x00FF, 0x22 }, { 0x1234, 0xAB },
    };
    for (int k = 0; k < 3; k++) {
        printf("###P4 nec bb a=0x%04x c=0x%02x\n", codes[k].a, codes[k].c);
        ir_bb_frame(codes[k].a, codes[k].c);
        if (k == 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            printf("###P4 nec bb rpt\n");
            ir_bb_repeat();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    for (int k = 0; k < 2; k++) {
        printf("###P4 nec rmt a=0x%04x c=0x%02x\n", codes[k].a, codes[k].c);
        ir_rmt_frame(codes[k].a, codes[k].c);
        if (k == 1) {
            vTaskDelay(pdMS_TO_TICKS(100));
            printf("###P4 nec rmt rpt\n");
            ir_rmt_repeat();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    (void)round;
    printf("###P4 end\n");
}

void app_main(void)
{
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << PIN_GPIO) | (1ULL << PIN_BTN),
        .mode = GPIO_MODE_OUTPUT_OD,           /* patched below, see pins */
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    /* Split config: PIN_GPIO is a push-pull output, PIN_BTN a pulled-up
     * input with a falling-edge ISR. */
    io.mode = GPIO_MODE_OUTPUT;
    io.pin_bit_mask = 1ULL << PIN_GPIO;
    ESP_ERROR_CHECK(gpio_config(&io));
    io.mode = GPIO_MODE_INPUT;
    io.pin_bit_mask = 1ULL << PIN_BTN;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    io.intr_type = GPIO_INTR_NEGEDGE;
    ESP_ERROR_CHECK(gpio_config(&io));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(PIN_BTN, btn_isr, NULL));
    /* P1b digital inputs: GPIO0 idles low (switch off), GPIO18 idles high
     * (touch pad released, active-low). The peripheral devices override
     * the pad level while attached; the pulls only pin the undriven case. */
    io.mode = GPIO_MODE_INPUT;
    io.pin_bit_mask = 1ULL << PIN_SWITCH;
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_ENABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    ESP_ERROR_CHECK(gpio_config(&io));
    io.pin_bit_mask = 1ULL << PIN_TOUCH;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    ESP_ERROR_CHECK(gpio_config(&io));

    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_13_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&t));
    ledc_channel_config_t c = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .intr_type = LEDC_INTR_DISABLE,
        .gpio_num = PIN_LEDC,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&c));
    /* ch1/ch2 ride the same timer; their duties are driven inside P2 */
    c.channel = LEDC_CHANNEL_1;
    c.gpio_num = PIN_LEDC1;
    ESP_ERROR_CHECK(ledc_channel_config(&c));
    c.channel = LEDC_CHANNEL_2;
    c.gpio_num = PIN_LEDC2;
    ESP_ERROR_CHECK(ledc_channel_config(&c));

    rmt_tx_channel_config_t rc = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = PIN_RMT,
        .mem_block_symbols = SOC_RMT_MEM_WORDS_PER_CHANNEL,
        .resolution_hz = RMT_RES_HZ,
        .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&rc, &s_chan));
    rmt_copy_encoder_config_t ec = {};
    ESP_ERROR_CHECK(rmt_new_copy_encoder(&ec, &s_enc));
    ESP_ERROR_CHECK(rmt_enable(s_chan));

    /* P4: soft-I2C lines idle released (pulled-up inputs); IR bit-bang pad;
     * RMT ch1 carries the carrier-less NEC frames at 1 MHz resolution. */
    gpio_set_level(PIN_I2C_SCL, 1);
    gpio_set_level(PIN_I2C_SDA, 1);
    gpio_pullup_en(PIN_I2C_SCL);
    gpio_pullup_en(PIN_I2C_SDA);
    gpio_set_direction(PIN_I2C_SCL, GPIO_MODE_INPUT);
    gpio_set_direction(PIN_I2C_SDA, GPIO_MODE_INPUT);
    gpio_config_t ir_io = {
        .pin_bit_mask = 1ULL << PIN_IR_BB,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&ir_io));
    gpio_set_level(PIN_IR_BB, 0);
    rmt_tx_channel_config_t ir_rc = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = PIN_IR_RMT,
        .mem_block_symbols = SOC_RMT_MEM_WORDS_PER_CHANNEL,
        .resolution_hz = IR_RMT_RES_HZ,
        .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&ir_rc, &s_ir_chan));
    ESP_ERROR_CHECK(rmt_new_copy_encoder(&ec, &s_ir_enc));
    ESP_ERROR_CHECK(rmt_enable(s_ir_chan));

    printf("###READY\n");
    int round = 0;

    while (1) {
        printf("###ROUND %d\n", round++);

        /* --- P1: blink + count probe-driven falling edges on PIN_BTN --- */
        s_btn_count = 0;
        printf("###P1 start\n");
        for (int i = 0; i < 8; i++) {
            gpio_set_level(PIN_GPIO, i & 1);
            printf("###P1 i=%d btn=%d\n", i, s_btn_count);
            vTaskDelay(pdMS_TO_TICKS(250));
        }
        gpio_set_level(PIN_GPIO, 0);
        printf("###P1 end btn=%d\n", s_btn_count);

        /* --- P1b: digital-in sampling (switch / touch / button level) ---
         * Two seconds, one line per 125 ms: sw = toggle-switch level on
         * GPIO0, btnlvl = the P1 button read as a level, tch = touch pad
         * (active-low). The blink LED mirrors the switch (flipping it is
         * visible without the UART) and touch press edges are counted. */
        printf("###P1b start\n");
        int last_tch = 1, touches = 0;
        for (int i = 0; i < 16; i++) {
            int sw = gpio_get_level(PIN_SWITCH);
            int btnlvl = gpio_get_level(PIN_BTN);
            int tch = gpio_get_level(PIN_TOUCH);
            if (tch == 0 && last_tch == 1) touches++;
            last_tch = tch;
            gpio_set_level(PIN_GPIO, sw);      /* LED mirrors the switch */
            printf("###P1b i=%d sw=%d btnlvl=%d tch=%d n=%d\n",
                   i, sw, btnlvl, tch, touches);
            vTaskDelay(pdMS_TO_TICKS(125));
        }
        gpio_set_level(PIN_GPIO, 0);
        printf("###P1b end n=%d\n", touches);

        /* --- P2: duty ramp, then flat extremes for clean measurement --- */
        printf("###P2 start\n");
        /* ch1 mirrors the ramp downwards, ch2 holds half duty; the markers
         * below keep describing ch0 only (m0 probe compatibility) */
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_2, 4096);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_2);
        for (int step = 0; step <= 32; step++) {
            uint32_t duty = step <= 16 ? (uint32_t)step * 512 : (uint32_t)(32 - step) * 512;
            if (duty > 8191) {
                duty = 8191;
            }
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, 8191 - duty);
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
            printf("###P2 d=%lu\n", (unsigned long)duty);
            vTaskDelay(pdMS_TO_TICKS(100));
        }
        static const struct { uint32_t duty; const char *tag; } flats[] = {
            { 0,    "zero" },
            { 4096, "half" },
            { 8191, "max"  },
        };
        for (int k = 0; k < 3; k++) {
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, flats[k].duty);
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, 8191 - flats[k].duty);
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
            printf("###P2 flat=%s d=%lu\n", flats[k].tag, (unsigned long)flats[k].duty);
            vTaskDelay(pdMS_TO_TICKS(300));
        }
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_2, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_2);
        printf("###P2 end\n");

        /* --- P3: WS2812 frames; log before sending so a probe that
         * switches to fine sampling on the marker catches the waveform --- */
        printf("###P3 start\n");
        for (int f = 0; f < 8; f++) {
            uint32_t rgb = 0x111111u * (uint32_t)(f + 1);   /* 0x111111..0x888888 */
            printf("###P3 f=%d c=0x%06lx\n", f, (unsigned long)rgb);
            ws2812_build(rgb);
            ws2812_send();
            vTaskDelay(pdMS_TO_TICKS(400));
        }
        /* One non-uniform frame so decoders can be checked per LED: all red
         * except LED n-1 = blue and LED n-2 = green. A 48-word channel RAM
         * window only keeps the last 46 bits, so exactly two LED slots
         * survive: the blue one intact, the green one with its two high G
         * bits lost (decoded G = 0x3f) — the M3 tail-alignment check. */
        {
            uint32_t grad[LED_COUNT];
            for (int i = 0; i < LED_COUNT; i++) grad[i] = 0xff0000;
            grad[LED_COUNT - 1] = 0x0000ff;
            grad[LED_COUNT - 2] = 0x00ff00;
            printf("###P3 grad\n");
            ws2812_build_n(grad);
            ws2812_send();
            vTaskDelay(pdMS_TO_TICKS(400));
        }
        printf("###P3 end\n");

        /* --- P4: bit-bang I2C + IR traffic (M4) --- */
        p4_run(round);
    }
}

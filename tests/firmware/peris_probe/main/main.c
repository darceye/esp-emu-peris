/*
 * peris_probe — M0 feasibility firmware for esp-emu-peris.
 *
 * Runs three phases in an endless loop, each announced on UART0 with
 * distinctive "###" markers so an external probe can sync on them:
 *
 *   P1  plain GPIO blink on GPIO 8 (2 Hz) — proves gpio_state() polling.
 *       While blinking, GPIO 3 is an input with a falling-edge ISR whose
 *       count is printed every half period — proves gpio_set_input() can
 *       drive pins *and* raise interrupts in the guest.
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
 *       RMT channel RAM to decode the frame from symbols.
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

#define PIN_GPIO   8                       /* P1: plain blink            */
#define PIN_BTN    3                       /* P1: driven input + ISR     */
#define PIN_LEDC   9                       /* P2: LEDC PWM ch0           */
#define PIN_LEDC1  6                       /* P2: LEDC PWM ch1           */
#define PIN_LEDC2  7                       /* P2: LEDC PWM ch2           */
#define PIN_RMT    4                       /* P3: RMT WS2812             */
#define LED_COUNT  8
#define RMT_RES_HZ (10 * 1000 * 1000)      /* 0.1 us per RMT tick        */

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
static void ws2812_build(uint32_t rgb)
{
    int n = 0;
    for (int led = 0; led < LED_COUNT; led++) {
        uint8_t grb[3] = { (rgb >> 8) & 0xFF, (rgb >> 16) & 0xFF, rgb & 0xFF };
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
        printf("###P3 end\n");
    }
}

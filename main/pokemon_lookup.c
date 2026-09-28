#include <stdbool.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "mbedtls/base64.h"

#define SAMPLE_RATE 16000
#define AUDIO_CHUNK_BYTES 1024
#define AUDIO_MAX_SECONDS 10
#define AUDIO_MAX_BYTES (SAMPLE_RATE * 2 * AUDIO_MAX_SECONDS)
#define AUDIO_MIN_BYTES (SAMPLE_RATE * 2 / 3)

#define IMG_WIDTH 194
#define IMG_HEIGHT 272
#define IMG_BYTES (IMG_WIDTH * IMG_HEIGHT * 2)

/* Audio captured continuously while idle, so the syllables spoken during the
   hold-to-talk delay are not lost ("Charizard" used to arrive as "izard") */
#define PREROLL_CHUNKS 20    /* 20 x 32 ms = 640 ms */

#define MAX_MATCHES 50

#define IMG_CACHE_SLOTS 6
#define IMG_INFLIGHT_MAX 6
#define IMG_REQUEST_TIMEOUT_MS 15000

#define LOOKUP_TIMEOUT_MS 30000
#define PROTOCOL_VERSION 2

/* USB-Serial-JTAG driver buffers: the default (no driver) console path reads a
   64-byte FIFO and made every card image take ~22 s to arrive */
#define SERIAL_RX_BUFFER 16384
#define SERIAL_TX_BUFFER 8192
#define SERIAL_LINE_MAX 5120

/* QMI8658 6-axis IMU (shares the BSP I2C bus) */
#define QMI8658_I2C_ADDR_ONE 0x6B
#define QMI8658_I2C_ADDR_TWO 0x6A
#define QMI8658_REG_WHO_AM_I 0x00
#define QMI8658_REG_CTRL1 0x02
#define QMI8658_REG_CTRL2 0x03
#define QMI8658_REG_CTRL3 0x04
#define QMI8658_REG_CTRL5 0x06
#define QMI8658_REG_AX_L 0x35
#define QMI8658_WHO_AM_I_VALUE 0x05

typedef struct {
    char id[40];
    char name[48];
    char number[16];
    char set_name[36];
    int printed_total;
    float price;
    bool owned;
} card_match_t;

typedef enum {
    APP_IDLE,
    APP_RECORDING,
    APP_WAITING,
    APP_SHOWING,
} app_state_t;

static const char *TAG = "card_lookup";

static esp_io_expander_handle_t s_io_expander;
static esp_codec_dev_handle_t s_microphone;
static uint8_t *s_audio_buffer;

/* UI and lookup state is owned by the LVGL lock (bsp_display_lock): LVGL
   callbacks, the control task and the record task take it before touching
   it. Only the flags marked volatile are read without it. The image cache
   has its own mutex (see s_image_mutex). */
static volatile app_state_t s_state = APP_IDLE;
static app_state_t s_wait_return_state;  /* where a failed lookup goes back to */
static int32_t s_wait_started_ms;
static volatile bool s_record_requested;
static volatile bool s_screen_off = false;
static volatile bool s_ignore_touch = false;  /* swallow touches until first release */
static volatile bool s_keypad_mode = false;   /* typing instead of voice (both side buttons) */
static int s_brightness = 80;
static lv_timer_t *s_flash_timer;

static card_match_t s_matches[MAX_MATCHES];
static int s_match_count;
static int s_match_index;
static char s_transcript[128];        /* committed: title of the results on screen */
static char s_pending_transcript[128]; /* in-flight lookup; committed only on success */

static uint8_t *s_image_buffer;  /* canvas pixels */
static char s_displayed_id[40];  /* card whose pixels are on the canvas; "" = none */
static int s_display_retries;    /* re-requests left for the card on screen */

/* Card image cache (LRU): flipping back to a card never re-streams it.
   Every transfer is tagged with its card id, so a lost or failed transfer
   can never shift later images onto the wrong card.
   Guarded by s_image_mutex, NOT the LVGL lock: the serial reader must never
   wait on a screen redraw, because the USB driver silently drops incoming
   bytes once its RX ring is full (~35 ms of image data). */
static SemaphoreHandle_t s_image_mutex;
typedef struct {
    char id[40];
    uint8_t *pixels;
    uint32_t last_used;
    bool valid;
} image_slot_t;
static image_slot_t s_img_slots[IMG_CACHE_SLOTS];
static uint32_t s_img_clock;
static struct { char id[40]; int32_t since_ms; bool used; } s_inflight[IMG_INFLIGHT_MAX];
static int s_stream_slot = -1;
static char s_stream_id[40];
static size_t s_stream_received;

static lv_obj_t *s_name_label;
static lv_obj_t *s_page_label;
static lv_obj_t *s_hint_panel;
static lv_obj_t *s_hint_label;
static lv_obj_t *s_canvas;
static lv_obj_t *s_number_label;
static lv_obj_t *s_set_label;
static lv_obj_t *s_price_label;
static lv_indev_t *s_touch_input;
static SemaphoreHandle_t s_serial_mutex;  /* recursive: one writer per line */
static QueueHandle_t s_control_queue;     /* non-image lines for the UI task */
static char s_result_decoded[6144];

/* Multi-tap keyboard (idle screen): type card names instead of speaking */
static lv_obj_t *s_keypad;
static lv_obj_t *s_typed_label;
static char s_typed[48];
static int s_typed_len;
static int s_mt_cycle_index;
static int s_mt_last_key = -1;
static int32_t s_mt_last_ms;
#define MULTITAP_WINDOW_MS 900
static const char *kKeyChars[10] = {
    "", ".,?!", "abc", "def", "ghi", "jkl", "mno", "pqrs", "tuv", "wxyz",
};

/* Poké ball spinner shown while the companion analyzes */
#define BALL_SIZE 128
extern const uint8_t ball_start[] asm("_binary_pokeball_rgb565_start");
extern const uint8_t ball_end[] asm("_binary_pokeball_rgb565_end");
static lv_obj_t *s_ball;
static lv_obj_t *s_analyzing_label;
static lv_image_dsc_t s_ball_descriptor;

static void sync_card_image(void);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/* Raw write through the driver's TX ring. Call with s_serial_mutex held. */
static bool serial_write(const void *data, size_t length, TickType_t timeout)
{
    const uint8_t *bytes = data;
    while (length > 0) {
        const int written = usb_serial_jtag_write_bytes(bytes, length, timeout);
        if (written <= 0) return false;  /* host not reading: drop, never hang */
        bytes += written;
        length -= (size_t)written;
    }
    return true;
}

static void serial_send_line(const char *line)
{
    xSemaphoreTakeRecursive(s_serial_mutex, portMAX_DELAY);
    serial_write(line, strlen(line), pdMS_TO_TICKS(200));
    serial_write("\n", 1, pdMS_TO_TICKS(200));
    xSemaphoreGiveRecursive(s_serial_mutex);
}

/* ESP_LOG output shares the wire with the protocol: route it through the same
   mutex so a log line can never land in the middle of a @DATA line. */
static int serial_log_vprintf(const char *format, va_list args)
{
    char buffer[256];
    int length = vsnprintf(buffer, sizeof(buffer), format, args);
    if (length < 0) return length;
    if ((size_t)length >= sizeof(buffer)) {
        length = sizeof(buffer) - 1;
        buffer[length - 1] = '\n';
    }
    if (xSemaphoreTakeRecursive(s_serial_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        serial_write(buffer, (size_t)length, pdMS_TO_TICKS(20));
        xSemaphoreGiveRecursive(s_serial_mutex);
    }
    return length;
}

static esp_err_t init_serial(void)
{
    s_serial_mutex = xSemaphoreCreateRecursiveMutex();
    ESP_RETURN_ON_FALSE(s_serial_mutex, ESP_ERR_NO_MEM, TAG, "serial mutex");
    usb_serial_jtag_driver_config_t config = {
        .rx_buffer_size = SERIAL_RX_BUFFER,
        .tx_buffer_size = SERIAL_TX_BUFFER,
    };
    ESP_RETURN_ON_ERROR(usb_serial_jtag_driver_install(&config), TAG, "usb serial driver");
    usb_serial_jtag_vfs_use_driver();  /* stray printf() goes through the driver too */
    esp_log_set_vprintf(serial_log_vprintf);
    return ESP_OK;
}

static void format_price(float price, char *out, size_t out_size)
{
    if (price <= 0.0f) {
        snprintf(out, out_size, "$--");
        return;
    }
    snprintf(out, out_size, "$%.2f", price);
}

/* ------------------------------------------------------------------ */
/* UI state painters (call with display lock held OR from LVGL ctx)     */
/* ------------------------------------------------------------------ */

static void hide_canvas(void)
{
    lv_obj_add_flag(s_canvas, LV_OBJ_FLAG_HIDDEN);
    s_displayed_id[0] = '\0';
}

static void hide_card_details(void)
{
    hide_canvas();
    lv_obj_add_flag(s_number_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_set_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_price_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_page_label, LV_OBJ_FLAG_HIDDEN);
}

static const char *idle_hint(void)
{
    return s_keypad_mode ? "Type a card name, then GO\nBoth side buttons: voice"
                         : "Hold the screen and\nsay a card name";
}

/* The keypad only shows in keypad mode; in voice mode the whole screen is
   the talk button. */
static void apply_idle_ui(const char *message)
{
    hide_card_details();
    lv_obj_add_flag(s_ball, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_analyzing_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_hint_panel, LV_OBJ_FLAG_HIDDEN);
    if (s_keypad_mode) {
        lv_obj_clear_flag(s_keypad, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(s_typed_label, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(s_keypad, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s_typed_label, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_add_flag(s_number_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_set_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_price_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_page_label, LV_OBJ_FLAG_HIDDEN);

    lv_label_set_text(s_name_label, "POKEDEX");
    lv_obj_set_style_text_color(s_name_label, lv_color_hex(0xa78bfa), LV_PART_MAIN);
    lv_label_set_text(s_hint_label, message);
}

/* A new search: the card from the last one is no longer relevant */
static void apply_recording_ui(void)
{
    hide_card_details();
    lv_obj_add_flag(s_keypad, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_typed_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_hint_panel, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_ball, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_analyzing_label, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(s_name_label, "LISTENING...");
    lv_obj_set_style_text_color(s_name_label, lv_color_hex(0xfb7185), LV_PART_MAIN);
    lv_label_set_text(s_hint_label, "Say a card name\ne.g. \"Charizard base\"\nRelease to search");
}

static void apply_waiting_ui(const char *transcript)
{
    lv_obj_add_flag(s_hint_panel, LV_OBJ_FLAG_HIDDEN);
    hide_canvas();
    lv_obj_add_flag(s_keypad, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_typed_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_ball, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_analyzing_label, LV_OBJ_FLAG_HIDDEN);
    if (transcript != NULL && transcript[0] != '\0') {
        lv_label_set_text(s_name_label, transcript);
        lv_obj_set_style_text_color(s_name_label, lv_color_hex(0xfbbf24), LV_PART_MAIN);
    } else {
        lv_label_set_text(s_name_label, "SEARCHING...");
        lv_obj_set_style_text_color(s_name_label, lv_color_hex(0xfbbf24), LV_PART_MAIN);
    }
}

static void apply_showing_labels(void)
{
    const card_match_t *match = &s_matches[s_match_index];
    char buffer[128];

    lv_label_set_text(s_name_label, s_transcript[0] != '\0' ? s_transcript : match->name);
    lv_obj_set_style_text_color(s_name_label, lv_color_hex(0xa78bfa), LV_PART_MAIN);

    snprintf(buffer, sizeof(buffer), "%d/%d", s_match_index + 1, s_match_count);
    lv_label_set_text(s_page_label, buffer);

    /*
     * "#4 Charizard ✓" with the marker recolored inline.
     * Leading '##' escapes the literal '#'; LVGL recolor needs it,
     * otherwise the parser eats "#4 ..." as a broken color command.
     */
    snprintf(buffer, sizeof(buffer), "##%s %s %s%s#",
             match->number, match->name,
             match->owned ? "#34d399 " : "#fb7185 ",
             match->owned ? LV_SYMBOL_OK : LV_SYMBOL_CLOSE);
    lv_label_set_text(s_number_label, buffer);

    snprintf(buffer, sizeof(buffer), "%s (%d)", match->set_name, match->printed_total);
    lv_label_set_text(s_set_label, buffer);

    char price[24];
    format_price(match->price, price, sizeof(price));
    lv_label_set_text(s_price_label, price);
    lv_obj_set_style_text_color(s_price_label, lv_color_hex(0xfbbf24), LV_PART_MAIN);
}

static void apply_showing_ui(bool hide_image_until_loaded)
{
    lv_obj_add_flag(s_hint_panel, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_ball, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_analyzing_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_keypad, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_typed_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_number_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_set_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_price_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_page_label, LV_OBJ_FLAG_HIDDEN);
    if (hide_image_until_loaded) {
        hide_canvas();
    }
    apply_showing_labels();
    sync_card_image();  /* cached art appears in this same frame */
}

static void flash_restore_timer(lv_timer_t *timer)
{
    lv_timer_del(timer);
    s_flash_timer = NULL;
    if (s_state == APP_SHOWING && s_match_count > 0) apply_showing_labels();
}

/*
 * Brief notice shown over the current results without destroying them.
 * Call with the display lock held. Used when a lookup fails or is too
 * short: what the user was looking at stays on screen.
 */
static void flash_message_over_results(const char *message)
{
    if (s_flash_timer != NULL) {
        lv_timer_del(s_flash_timer);
    }
    lv_label_set_text(s_name_label, message);
    lv_obj_set_style_text_color(s_name_label, lv_color_hex(0xfb7185), LV_PART_MAIN);
    s_flash_timer = lv_timer_create(flash_restore_timer, 1600, NULL);
}

/* Call with the display lock held. */
static void enter_waiting(app_state_t return_state, const char *transcript)
{
    s_wait_return_state = return_state;
    s_wait_started_ms = lv_tick_get();
    s_state = APP_WAITING;
    apply_waiting_ui(transcript);
}

/*
 * A lookup failed, found nothing or timed out: go back to what was on screen
 * before it. Results are never wiped by a failed lookup. Display lock held.
 */
static void leave_waiting(const char *flash, const char *idle_message)
{
    if (s_wait_return_state == APP_SHOWING && s_match_count > 0) {
        s_state = APP_SHOWING;
        apply_showing_ui(false);
        flash_message_over_results(flash);
    } else {
        s_state = APP_IDLE;
        apply_idle_ui(idle_message);
    }
}

static void lookup_watchdog_timer(lv_timer_t *timer)
{
    (void)timer;
    if (s_state == APP_WAITING &&
        lv_tick_elaps(s_wait_started_ms) > LOOKUP_TIMEOUT_MS) {
        ESP_LOGW(TAG, "lookup timed out after %d s", LOOKUP_TIMEOUT_MS / 1000);
        leave_waiting("NO RESPONSE", "Mac not responding\nStart the companion and try again");
    }
}

/* Display lock held. Both side buttons toggle it. */
static void set_keypad_mode(bool on)
{
    if (s_state == APP_RECORDING || s_state == APP_WAITING) return;
    s_keypad_mode = on;
    s_state = APP_IDLE;
    apply_idle_ui(idle_hint());
    ESP_LOGI(TAG, "%s mode", on ? "keypad" : "voice");
}

/* ------------------------------------------------------------------ */
/* Board bring-up (power rails, buttons, microphone)                   */
/* ------------------------------------------------------------------ */

static esp_err_t prepare_v2_expander_power(void)
{
    s_io_expander = bsp_io_expander_init();
    ESP_RETURN_ON_FALSE(s_io_expander, ESP_FAIL, TAG, "I/O expander init failed");

    const uint32_t power_rails =
        IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2;
    ESP_RETURN_ON_ERROR(
        esp_io_expander_set_dir(s_io_expander, power_rails, IO_EXPANDER_OUTPUT),
        TAG, "configure V2 power rails");
    ESP_RETURN_ON_ERROR(
        esp_io_expander_set_level(s_io_expander, power_rails, 1),
        TAG, "enable V2 power rails");
    vTaskDelay(pdMS_TO_TICKS(20));
    return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* QMI8658 IMU: two firm jerks toggle the screen on/off                 */
/* ------------------------------------------------------------------ */

static i2c_master_dev_handle_t s_imu_device;
static bool s_imu_ready;

static esp_err_t imu_write(uint8_t reg, uint8_t value)
{
    const uint8_t buffer[2] = {reg, value};
    return i2c_master_transmit(s_imu_device, buffer, sizeof(buffer), 100);
}

static esp_err_t imu_read(uint8_t reg, uint8_t *data, size_t length)
{
    return i2c_master_transmit_receive(s_imu_device, &reg, 1, data, length, 100);
}

static bool imu_probe_addr(i2c_master_bus_handle_t bus, uint8_t address)
{
    i2c_device_config_t config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = address,
        .scl_speed_hz = 400000,
    };
    i2c_master_dev_handle_t device = NULL;
    if (i2c_master_bus_add_device(bus, &config, &device) != ESP_OK) {
        return false;
    }
    s_imu_device = device;

    uint8_t who = 0;
    if (imu_read(QMI8658_REG_WHO_AM_I, &who, 1) == ESP_OK && who == QMI8658_WHO_AM_I_VALUE) {
        return true;
    }
    i2c_master_bus_rm_device(device);
    s_imu_device = NULL;
    return false;
}

static void init_imu(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    if (bus == NULL) {
        ESP_LOGW(TAG, "no BSP I2C bus; shake toggle disabled");
        return;
    }

    if (!imu_probe_addr(bus, QMI8658_I2C_ADDR_ONE) &&
        !imu_probe_addr(bus, QMI8658_I2C_ADDR_TWO)) {
        ESP_LOGW(TAG, "QMI8658 not found on I2C; shake toggle disabled");
        return;
    }

    /* Waveshare reference init: soft reset, auto-increment, enable accel+gyro */
    imu_write(0x60, 0xB0);
    vTaskDelay(pdMS_TO_TICKS(10));
    imu_write(QMI8658_REG_CTRL1, 0xFC);
    imu_write(QMI8658_REG_CTRL2, 0x95);  /* accel +-8g */
    imu_write(QMI8658_REG_CTRL3, 0xD5);  /* gyro +-512dps */
    imu_write(QMI8658_REG_CTRL5, 0x11);

    s_imu_ready = true;
    ESP_LOGI(TAG, "QMI8658 ready: jerk twice to toggle the screen");
}

static void set_screen(bool on)
{
    s_screen_off = !on;
    if (on) {
        /* Swallow touches that are already in progress from handling the
           device, so waking never starts a stray recording or page flip */
        s_ignore_touch = true;
        ESP_ERROR_CHECK_WITHOUT_ABORT(bsp_display_brightness_set(s_brightness));
        if (bsp_display_lock(200)) {
            lv_obj_invalidate(lv_screen_active());
            bsp_display_unlock();
        }
    } else {
        ESP_ERROR_CHECK_WITHOUT_ABORT(bsp_display_brightness_set(0));
    }
    ESP_LOGI(TAG, "screen %s", on ? "ON" : "OFF");
}

/*
 * Double-jerk detector: jerk -> brief pause -> jerk toggles the screen.
 * A continuous vigorous shake has no quiet gap between spikes, so it cannot
 * fire twice and cancel itself out.
 */
static void poll_shake(void)
{
    static TickType_t first_spike;
    static TickType_t last_spike;
    static TickType_t last_quiet;
    static TickType_t cooldown_until;
    static unsigned quiet_reads;
    static bool armed;
    static long baseline_sq = 4096L * 4096L; /* resting ~1g squared */

    if (!s_imu_ready) return;

    uint8_t raw[6] = {0};
    if (imu_read(QMI8658_REG_AX_L, raw, sizeof(raw)) != ESP_OK) {
        return;
    }
    const int16_t ax = (int16_t)((raw[1] << 8) | raw[0]);
    const int16_t ay = (int16_t)((raw[3] << 8) | raw[2]);
    const int16_t az = (int16_t)((raw[5] << 8) | raw[4]);
    const long magnitude_sq = (long)ax * ax + (long)ay * ay + (long)az * az;

    /* Adaptive gravity baseline: immune to scale/orientation differences */
    baseline_sq += (magnitude_sq - baseline_sq) / 16;

    /* A jerk moves apparent gravity by more than ~0.6g */
    const long delta = magnitude_sq - baseline_sq;
    const long band = 2500L * 2500L;
    const bool spiking = delta > band || -delta > band;

    const TickType_t now = xTaskGetTickCount();
    if (!spiking) {
        quiet_reads++;
        last_quiet = now;
        if (armed && quiet_reads > 40 && now - first_spike > pdMS_TO_TICKS(900)) {
            armed = false;  /* window expired */
        }
        return;
    }
    quiet_reads = 0;
    if (now < cooldown_until || now - last_spike < pdMS_TO_TICKS(120)) {
        return;
    }

    if (!armed) {
        armed = true;
        first_spike = now;
        last_spike = now;
        return;
    }
    if (now - first_spike > pdMS_TO_TICKS(900)) {
        /* stale arm: treat this as the fresh first jerk */
        first_spike = now;
        last_spike = now;
        return;
    }
    if (last_quiet > first_spike) {
        /* second jerk after a real pause: flip the screen */
        armed = false;
        cooldown_until = now + pdMS_TO_TICKS(1200);
        set_screen(s_screen_off);
    }
}

static void request_record_start(void)
{
    app_state_t state = s_state;
    if (s_screen_off) return;  /* ignore while the screen is off */
    if ((state == APP_IDLE || state == APP_SHOWING) && !s_record_requested) {
        s_record_requested = true;
    }
}

static void navigate(int direction);

/*
 * Side buttons: BOOT flips to the previous result, PWR to the next. Pressing
 * both at once toggles keypad mode. A single press acts on release, so the
 * first button of a two-button press never flips a card.
 */
static void button_task(void *arg)
{
    (void)arg;
    bool boot_last = false, boot_stable = false;
    bool pwr_last = false, pwr_stable = false;
    unsigned boot_count = 0, pwr_count = 0;
    bool consumed = false;  /* this press was a chord or a wake: no flip */

    while (true) {
        const bool boot = gpio_get_level(GPIO_NUM_0) == 0;
        uint32_t pwr_mask = 0;
        esp_io_expander_get_level(s_io_expander, IO_EXPANDER_PIN_NUM_4, &pwr_mask);
        const bool pwr = (pwr_mask & IO_EXPANDER_PIN_NUM_4) != 0;

        boot_count = boot == boot_last ? boot_count + 1 : 0;
        pwr_count = pwr == pwr_last ? pwr_count + 1 : 0;
        boot_last = boot;
        pwr_last = pwr;

        const bool boot_changed = boot_count == 2 && boot != boot_stable;
        const bool pwr_changed = pwr_count == 2 && pwr != pwr_stable;
        if (boot_changed || pwr_changed) {
            const bool was_down = boot_stable || pwr_stable;
            const int released = boot_changed && !boot ? -1 : pwr_changed && !pwr ? 1 : 0;
            if (boot_changed) boot_stable = boot;
            if (pwr_changed) pwr_stable = pwr;

            if (!was_down && s_screen_off) {
                set_screen(true);  /* any side button wakes the screen */
                consumed = true;
            } else if (boot_stable && pwr_stable && !consumed) {
                consumed = true;
                if (bsp_display_lock(300)) {
                    set_keypad_mode(!s_keypad_mode);
                    bsp_display_unlock();
                }
            } else if (released != 0 && !consumed && !boot_stable && !pwr_stable) {
                if (bsp_display_lock(300)) {
                    navigate(released);
                    bsp_display_unlock();
                }
            }
            if (!boot_stable && !pwr_stable) consumed = false;
        }

        poll_shake();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

static esp_err_t init_buttons(void)
{
    const gpio_config_t boot_config = {
        .pin_bit_mask = 1ULL << GPIO_NUM_0,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&boot_config), TAG, "configure BOOT");
    ESP_RETURN_ON_ERROR(
        esp_io_expander_set_dir(s_io_expander, IO_EXPANDER_PIN_NUM_4, IO_EXPANDER_INPUT),
        TAG, "configure PWR");
    return xTaskCreate(button_task, "buttons", 3072, NULL, 6, NULL) == pdPASS
        ? ESP_OK : ESP_ERR_NO_MEM;
}

static esp_err_t init_microphone(void)
{
    s_microphone = bsp_audio_codec_microphone_init();
    ESP_RETURN_ON_FALSE(s_microphone, ESP_FAIL, TAG, "microphone init failed");

    esp_codec_dev_sample_info_t sample = {
        .sample_rate = SAMPLE_RATE,
        .channel = 1,
        .bits_per_sample = 16,
        .channel_mask = 0,
        .mclk_multiple = 256,
    };
    ESP_RETURN_ON_FALSE(
        esp_codec_dev_open(s_microphone, &sample) == ESP_CODEC_DEV_OK,
        ESP_FAIL, TAG, "microphone open failed");
    ESP_RETURN_ON_FALSE(
        esp_codec_dev_set_in_gain(s_microphone, 30.0f) == ESP_CODEC_DEV_OK,
        ESP_FAIL, TAG, "microphone gain failed");

    s_audio_buffer = heap_caps_malloc(AUDIO_MAX_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_RETURN_ON_FALSE(s_audio_buffer, ESP_ERR_NO_MEM, TAG, "audio buffer allocation failed");
    return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* Audio upload                                                        */
/* ------------------------------------------------------------------ */

/* Returns false if the Mac stopped reading mid-transfer. */
static bool send_audio(size_t audio_bytes)
{
    static uint8_t line[6 + 4100 + 2];  /* "@DATA " + base64(3072) + "\n" */
    const size_t raw_chunk = 3072;
    const TickType_t timeout = pdMS_TO_TICKS(2000);
    bool ok = true;

    xSemaphoreTakeRecursive(s_serial_mutex, portMAX_DELAY);
    int length = snprintf((char *)line, sizeof(line), "@VOICE %u\n", (unsigned)audio_bytes);
    ok = serial_write(line, (size_t)length, timeout);
    for (size_t offset = 0; ok && offset < audio_bytes; offset += raw_chunk) {
        const size_t chunk = audio_bytes - offset > raw_chunk ? raw_chunk : audio_bytes - offset;
        size_t encoded_length = 0;
        memcpy(line, "@DATA ", 6);
        if (mbedtls_base64_encode(line + 6, sizeof(line) - 8, &encoded_length,
                                  s_audio_buffer + offset, chunk) != 0) {
            ok = false;
            break;
        }
        line[6 + encoded_length] = '\n';
        ok = serial_write(line, 6 + encoded_length + 1, timeout);
    }
    ok = ok && serial_write("@END\n", 5, timeout);
    xSemaphoreGiveRecursive(s_serial_mutex);
    return ok;
}

/* ------------------------------------------------------------------ */
/* Record transaction                                                  */
/* ------------------------------------------------------------------ */

static void record_task(void *arg)
{
    (void)arg;
    const size_t preroll_bytes = PREROLL_CHUNKS * AUDIO_CHUNK_BYTES;
    uint8_t *preroll = heap_caps_malloc(preroll_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    size_t preroll_pos = 0;
    bool preroll_full = false;

    while (true) {
        const app_state_t state = s_state;
        const bool can_record = state == APP_IDLE || state == APP_SHOWING;

        if (!s_record_requested || !can_record) {
            if (preroll != NULL && can_record && !s_screen_off) {
                /* Keep a rolling window of the last ~640 ms; the read itself
                   (32 ms of audio) paces this loop */
                if (esp_codec_dev_read(s_microphone, preroll + preroll_pos,
                                       AUDIO_CHUNK_BYTES) == ESP_CODEC_DEV_OK) {
                    preroll_pos = (preroll_pos + AUDIO_CHUNK_BYTES) % preroll_bytes;
                    preroll_full = preroll_full || preroll_pos == 0;
                }
            } else {
                vTaskDelay(pdMS_TO_TICKS(20));
            }
            continue;
        }

        /* A failed voice search lands on the listen screen, not the old
           card; the side buttons still bring the old results back */
        const app_state_t return_state = APP_IDLE;
        if (bsp_display_lock(0)) {
            s_state = APP_RECORDING;
            apply_recording_ui();
            bsp_display_unlock();
        }

        /* Start the clip with the pre-roll, oldest audio first */
        size_t bytes = 0;
        if (preroll != NULL) {
            if (preroll_full) {
                memcpy(s_audio_buffer, preroll + preroll_pos, preroll_bytes - preroll_pos);
                bytes = preroll_bytes - preroll_pos;
            }
            memcpy(s_audio_buffer + bytes, preroll, preroll_pos);
            bytes += preroll_pos;
            preroll_pos = 0;
            preroll_full = false;
        }
        const size_t preroll_used = bytes;

        ESP_LOGI(TAG, "Recording started (%u ms pre-roll)", (unsigned)(preroll_used / (SAMPLE_RATE * 2 / 1000)));
        while (s_record_requested && bytes + AUDIO_CHUNK_BYTES <= AUDIO_MAX_BYTES) {
            const int ret = esp_codec_dev_read(s_microphone, s_audio_buffer + bytes, AUDIO_CHUNK_BYTES);
            if (ret != ESP_CODEC_DEV_OK) {
                ESP_LOGE(TAG, "microphone read failed: %d", ret);
                break;
            }
            bytes += AUDIO_CHUNK_BYTES;
        }
        s_record_requested = false;
        const size_t held_bytes = bytes - preroll_used;
        ESP_LOGI(TAG, "Recording stopped: %u bytes", (unsigned)bytes);

        if (held_bytes < AUDIO_MIN_BYTES) {
            if (bsp_display_lock(0)) {
                s_wait_return_state = return_state;
                leave_waiting("TOO SHORT", "Too short\nHold the screen while you speak");
                bsp_display_unlock();
            }
            continue;
        }

        if (bsp_display_lock(0)) {
            enter_waiting(return_state, NULL);
            bsp_display_unlock();
        }
        if (!send_audio(bytes)) {
            ESP_LOGW(TAG, "audio upload stalled: companion not reading");
            if (bsp_display_lock(0)) {
                if (s_state == APP_WAITING) {
                    leave_waiting("NO COMPANION", "Mac not responding\nStart the companion and try again");
                }
                bsp_display_unlock();
            }
        }
        /* The reply (or the lookup watchdog) ends the WAITING state */
    }
}

/* ------------------------------------------------------------------ */
/* Result parsing                                                      */
/* ------------------------------------------------------------------ */

static void copy_json_string(const cJSON *object, const char *key, char *dest, size_t dest_size)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, key);
    if (item != NULL && cJSON_IsString(item) && item->valuestring != NULL) {
        strlcpy(dest, item->valuestring, dest_size);
    } else {
        dest[0] = '\0';
    }
}

/* Display lock held (runs on the control task). */
static void handle_result(const char *payload, size_t payload_length)
{
    if (s_state != APP_WAITING) {
        ESP_LOGW(TAG, "ignoring late result");
        return;
    }
    size_t decoded_length = 0;
    if (mbedtls_base64_decode((uint8_t *)s_result_decoded, sizeof(s_result_decoded) - 1,
                              &decoded_length,
                              (const uint8_t *)payload, payload_length) != 0) {
        ESP_LOGE(TAG, "result base64 decode failed (%u chars)", (unsigned)payload_length);
        leave_waiting("BAD REPLY", "Bad reply from the Mac\nTry again");
        return;
    }
    s_result_decoded[decoded_length] = '\0';

    cJSON *root = cJSON_Parse(s_result_decoded);
    if (root == NULL) {
        ESP_LOGE(TAG, "result JSON parse failed");
        leave_waiting("BAD REPLY", "Bad reply from the Mac\nTry again");
        return;
    }

    copy_json_string(root, "transcript", s_pending_transcript, sizeof(s_pending_transcript));

    /* Parse into a scratch list: the current results stay intact on failure */
    static card_match_t parsed[MAX_MATCHES];
    int count = 0;
    const cJSON *matches = cJSON_GetObjectItemCaseSensitive(root, "matches");
    const cJSON *match_item = NULL;
    if (cJSON_IsArray(matches)) {
        cJSON_ArrayForEach(match_item, matches) {
            if (count >= MAX_MATCHES) break;
            card_match_t *entry = &parsed[count];
            memset(entry, 0, sizeof(*entry));
            copy_json_string(match_item, "id", entry->id, sizeof(entry->id));
            copy_json_string(match_item, "name", entry->name, sizeof(entry->name));
            copy_json_string(match_item, "number", entry->number, sizeof(entry->number));
            copy_json_string(match_item, "set", entry->set_name, sizeof(entry->set_name));

            const cJSON *total = cJSON_GetObjectItemCaseSensitive(match_item, "total");
            entry->printed_total = cJSON_IsNumber(total) ? total->valueint : 0;

            const cJSON *price = cJSON_GetObjectItemCaseSensitive(match_item, "price");
            entry->price = cJSON_IsNumber(price) ? (float)price->valuedouble : 0.0f;

            const cJSON *owned = cJSON_GetObjectItemCaseSensitive(match_item, "owned");
            entry->owned = cJSON_IsTrue(owned);

            if (entry->id[0] != '\0') ++count;
        }
    }
    cJSON_Delete(root);

    if (count == 0) {
        /* Silence or unrecognized speech: keep whatever was on screen before */
        ESP_LOGW(TAG, "no matches for \"%s\"", s_pending_transcript);
        const bool heard_something = s_pending_transcript[0] != '\0';
        char message[160];
        if (heard_something) {
            snprintf(message, sizeof(message), "No vintage cards found\nfor \"%s\"", s_pending_transcript);
        } else {
            snprintf(message, sizeof(message), "Didn't catch that\nHold and say a card name");
        }
        leave_waiting(heard_something ? "NO MATCHES" : "NOT HEARD", message);
        return;
    }

    memcpy(s_matches, parsed, sizeof(card_match_t) * count);
    strlcpy(s_transcript, s_pending_transcript, sizeof(s_transcript));
    s_match_count = count;
    s_match_index = 0;
    s_state = APP_SHOWING;
    ESP_LOGI(TAG, "Got %d matches for \"%s\"", count, s_transcript);

    s_display_retries = 2;
    apply_showing_ui(true);
}

/* ------------------------------------------------------------------ */
/* Multi-tap keyboard                                                   */
/* ------------------------------------------------------------------ */

static void typed_render(void)
{
    lv_label_set_text(s_typed_label, s_typed[0] ? s_typed : " ");
}

static void typed_key_event(lv_event_t *event)
{
    const intptr_t key = (intptr_t)lv_event_get_user_data(event);

    if (key == -2) {  /* backspace */
        if (s_typed_len > 0) s_typed[--s_typed_len] = '\0';
        s_mt_last_key = -1;
        typed_render();
        return;
    }
    if (key == -1) {  /* space */
        if (s_typed_len > 0 && (size_t)s_typed_len < sizeof(s_typed) - 1) {
            s_typed[s_typed_len++] = ' ';
            s_typed[s_typed_len] = '\0';
        }
        s_mt_last_key = -1;
        typed_render();
        return;
    }

    const char *chars = kKeyChars[key];
    if (chars[0] == '\0') return;
    const int32_t now = lv_tick_get();
    if (key == s_mt_last_key && now - s_mt_last_ms < MULTITAP_WINDOW_MS && s_typed_len > 0) {
        /* cycle within the same key: b -> c -> a ... */
        s_mt_cycle_index = (s_mt_cycle_index + 1) % (int)strlen(chars);
        s_typed[s_typed_len - 1] = chars[s_mt_cycle_index];
    } else {
        if ((size_t)s_typed_len < sizeof(s_typed) - 1) {
            s_mt_cycle_index = 0;
            s_typed[s_typed_len++] = chars[0];
            s_typed[s_typed_len] = '\0';
        }
    }
    s_mt_last_key = (int)key;
    s_mt_last_ms = now;
    typed_render();
}

static void voice_key_event(lv_event_t *event)
{
    (void)event;
    set_keypad_mode(false);
}

/* Display lock held. */
static void send_typed_query(const char *text)
{
    char encoded[128];
    size_t encoded_length = 0;
    if (mbedtls_base64_encode((unsigned char *)encoded, sizeof(encoded) - 1, &encoded_length,
                              (const unsigned char *)text, strlen(text)) != 0) {
        return;
    }
    encoded[encoded_length] = '\0';

    char line[160];
    snprintf(line, sizeof(line), "@QUERY %s", encoded);
    serial_send_line(line);
    enter_waiting(s_state, text);
}

static void go_key_event(lv_event_t *event)
{
    (void)event;
    if (s_state != APP_IDLE || s_screen_off) return;
    if (s_typed_len == 0) {
        lv_label_set_text(s_hint_label, "Type a card name first");
        return;
    }

    send_typed_query(s_typed);
    s_typed_len = 0;
    s_typed[0] = '\0';
    s_mt_last_key = -1;
    typed_render();
}

static void ball_spin_timer(lv_timer_t *timer)
{
    (void)timer;
    static int angle;
    if (s_state != APP_WAITING || s_screen_off) return;
    angle = (angle + 6) % 3600;
    lv_image_set_rotation(s_ball, angle);
    lv_obj_invalidate(s_ball);
}

static void create_key(lv_obj_t *parent, const char *label_text, int x, int y,
                       lv_event_cb_t callback, intptr_t user_data)
{
    lv_obj_t *key = lv_button_create(parent);
    lv_obj_set_size(key, 112, 50);
    lv_obj_set_pos(key, x, y);
    lv_obj_set_style_radius(key, 10, LV_PART_MAIN);
    lv_obj_set_style_bg_color(key, lv_color_hex(0x171a2d), LV_PART_MAIN);
    lv_obj_set_style_border_color(key, lv_color_hex(0x6f5bd3), LV_PART_MAIN);
    lv_obj_set_style_border_width(key, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(key, 0, LV_PART_MAIN);
    /* The touch panel reports positions a touch higher than the finger:
       widen every hit area so keys register without aiming above them */
    lv_obj_set_ext_click_area(key, 14);
    lv_obj_add_event_cb(key, callback, LV_EVENT_CLICKED, (void *)user_data);

    lv_obj_t *label = lv_label_create(key);
    lv_label_set_text(label, label_text);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(label, lv_color_hex(0xd9c6ff), LV_PART_MAIN);
    lv_obj_center(label);
}

static void create_keypad(lv_obj_t *screen)
{
    s_keypad = lv_obj_create(screen);
    lv_obj_set_size(s_keypad, 368, 236);
    lv_obj_set_pos(s_keypad, 0, 212);
    lv_obj_set_style_bg_opa(s_keypad, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_keypad, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_keypad, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_keypad, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(s_keypad, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(s_keypad, LV_OBJ_FLAG_HIDDEN);  /* voice mode first */

    static const struct { int x, y; const char *text; intptr_t id; } keys[] = {
        {8,   4, LV_SYMBOL_AUDIO " VOICE", -3},
        {126, 4, "2 ABC", 2}, {244, 4, "3 DEF", 3},
        {8,  60, "4 GHI", 4}, {126, 60, "5 JKL", 5}, {244, 60, "6 MNO", 6},
        {8, 116, "7 PQRS", 7}, {126, 116, "8 TUV", 8}, {244, 116, "9 WXYZ", 9},
        {8, 172, LV_SYMBOL_LEFT " DEL", -2}, {126, 172, "0 _", -1},
        {244, 172, LV_SYMBOL_OK " GO", -4},
    };
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
        if (keys[i].id == -3) {
            create_key(s_keypad, keys[i].text, keys[i].x, keys[i].y, voice_key_event, 0);
        } else if (keys[i].id == -4) {
            create_key(s_keypad, keys[i].text, keys[i].x, keys[i].y, go_key_event, 0);
        } else {
            create_key(s_keypad, keys[i].text, keys[i].x, keys[i].y, typed_key_event, keys[i].id);
        }
    }
}

/* ------------------------------------------------------------------ */
/* Card image cache + streaming                                        */
/* ------------------------------------------------------------------ */

/* --- cache primitives: call with s_image_mutex held --- */

static int cache_find_slot(const char *card_id)
{
    for (int i = 0; i < IMG_CACHE_SLOTS; ++i) {
        if (s_img_slots[i].valid && strcmp(s_img_slots[i].id, card_id) == 0) return i;
    }
    return -1;
}

static int inflight_find(const char *card_id)
{
    for (int i = 0; i < IMG_INFLIGHT_MAX; ++i) {
        if (s_inflight[i].used && strcmp(s_inflight[i].id, card_id) == 0) return i;
    }
    return -1;
}

static void inflight_remove(const char *card_id)
{
    const int index = inflight_find(card_id);
    if (index >= 0) s_inflight[index].used = false;
}

/* True when the caller should send @GETIMG (not cached, not already asked) */
static bool inflight_add(const char *card_id)
{
    const int32_t now = lv_tick_get();
    int index = inflight_find(card_id);
    if (index >= 0) {
        if (lv_tick_elaps(s_inflight[index].since_ms) < IMG_REQUEST_TIMEOUT_MS) {
            return false;  /* already on its way */
        }
    } else {
        /* free entry, or recycle the oldest request */
        index = 0;
        for (int i = 0; i < IMG_INFLIGHT_MAX; ++i) {
            if (!s_inflight[i].used) { index = i; break; }
            if (s_inflight[i].since_ms - s_inflight[index].since_ms < 0) index = i;
        }
    }
    strlcpy(s_inflight[index].id, card_id, sizeof(s_inflight[index].id));
    s_inflight[index].since_ms = now;
    s_inflight[index].used = true;
    return true;
}

static int pick_victim_slot(void)
{
    int victim = -1;
    for (int i = 0; i < IMG_CACHE_SLOTS; ++i) {
        if (s_img_slots[i].pixels == NULL) continue;
        if (!s_img_slots[i].valid) return i;
        if (victim < 0 || s_img_slots[i].last_used < s_img_slots[victim].last_used) victim = i;
    }
    return victim;
}

/* --- LVGL side (display lock held) --- */

/* Ask the companion for a card's art unless it is cached or already coming */
static void request_card_image(const char *card_id)
{
    xSemaphoreTake(s_image_mutex, portMAX_DELAY);
    const bool send = cache_find_slot(card_id) < 0 && inflight_add(card_id);
    xSemaphoreGive(s_image_mutex);
    if (send) {  /* never hold the image mutex while writing to the host */
        char line[64];
        snprintf(line, sizeof(line), "@GETIMG %s", card_id);
        serial_send_line(line);
    }
}

/*
 * Make the canvas show the current card. Runs on every page change and from a
 * 30 ms timer, so art that arrives later (or needs a retry) appears on its own.
 */
static void sync_card_image(void)
{
    if (s_state != APP_SHOWING || s_match_count == 0 || s_image_buffer == NULL) return;
    const char *card_id = s_matches[s_match_index].id;
    if (strcmp(s_displayed_id, card_id) == 0) return;

    xSemaphoreTake(s_image_mutex, portMAX_DELAY);
    const int slot = cache_find_slot(card_id);
    bool retry = false;
    if (slot >= 0) {
        s_img_slots[slot].last_used = ++s_img_clock;
        memcpy(s_image_buffer, s_img_slots[slot].pixels, IMG_BYTES);
    } else {
        retry = inflight_find(card_id) < 0;  /* a transfer failed: ask again */
    }
    xSemaphoreGive(s_image_mutex);

    if (slot < 0) {
        if (retry && s_display_retries-- > 0) request_card_image(card_id);
        return;
    }
    strlcpy(s_displayed_id, card_id, sizeof(s_displayed_id));
    lv_obj_clear_flag(s_canvas, LV_OBJ_FLAG_HIDDEN);
    lv_obj_invalidate(s_canvas);
    ESP_LOGI(TAG, "card on screen: %s", card_id);

    /* Warm both neighbours so flipping is instant */
    if (s_match_index + 1 < s_match_count) request_card_image(s_matches[s_match_index + 1].id);
    if (s_match_index > 0) request_card_image(s_matches[s_match_index - 1].id);
}

static void image_sync_timer(lv_timer_t *timer)
{
    (void)timer;
    sync_card_image();
}

/* --- serial reader side: s_image_mutex only, never the display lock --- */

static void begin_image(const char *card_id, int width, int height)
{
    xSemaphoreTake(s_image_mutex, portMAX_DELAY);
    if (s_stream_slot >= 0) {
        inflight_remove(s_stream_id);  /* previous transfer never finished */
    }
    s_stream_slot = -1;
    if (width == IMG_WIDTH && height == IMG_HEIGHT) {
        /* A re-sent card replaces its own slot; otherwise evict the LRU slot */
        int slot = cache_find_slot(card_id);
        if (slot < 0) slot = pick_victim_slot();
        if (slot >= 0) {
            s_img_slots[slot].valid = false;
            s_stream_slot = slot;
            strlcpy(s_stream_id, card_id, sizeof(s_stream_id));
            s_stream_received = 0;
        }
    }
    xSemaphoreGive(s_image_mutex);
    if (s_stream_slot < 0) {
        ESP_LOGE(TAG, "cannot take image %s (%dx%d)", card_id, width, height);
    }
}

static void feed_image_chunk(const char *payload, size_t payload_length)
{
    xSemaphoreTake(s_image_mutex, portMAX_DELAY);
    bool rejected = false;
    if (s_stream_slot >= 0) {
        size_t decoded_length = 0;
        uint8_t *destination = s_img_slots[s_stream_slot].pixels + s_stream_received;
        /* Decode straight into the slot; the length check bounds the write */
        if (mbedtls_base64_decode(destination, IMG_BYTES - s_stream_received, &decoded_length,
                                  (const uint8_t *)payload, payload_length) == 0) {
            s_stream_received += decoded_length;
        } else {
            rejected = true;
            s_stream_slot = -1;
            inflight_remove(s_stream_id);
        }
    }
    xSemaphoreGive(s_image_mutex);
    if (rejected) {
        ESP_LOGE(TAG, "image chunk for %s rejected at %u bytes", s_stream_id, (unsigned)s_stream_received);
    }
}

static void finish_image(const char *card_id)
{
    xSemaphoreTake(s_image_mutex, portMAX_DELAY);
    const int slot = s_stream_slot;
    const bool complete = slot >= 0 && strcmp(card_id, s_stream_id) == 0 &&
                          s_stream_received == IMG_BYTES;
    s_stream_slot = -1;
    inflight_remove(card_id);
    if (complete) {
        strlcpy(s_img_slots[slot].id, card_id, sizeof(s_img_slots[slot].id));
        s_img_slots[slot].valid = true;
        s_img_slots[slot].last_used = ++s_img_clock;
    }
    const size_t received = s_stream_received;
    xSemaphoreGive(s_image_mutex);

    if (complete) {
        ESP_LOGI(TAG, "image cached: %s", card_id);  /* sync_card_image shows it */
    } else {
        ESP_LOGW(TAG, "image %s incomplete (%u/%u)", card_id, (unsigned)received, (unsigned)IMG_BYTES);
    }
}

static void image_failed(const char *card_id)
{
    xSemaphoreTake(s_image_mutex, portMAX_DELAY);
    inflight_remove(card_id);
    xSemaphoreGive(s_image_mutex);
    ESP_LOGW(TAG, "no artwork for %s", card_id);
}

/* ------------------------------------------------------------------ */
/* Serial receive                                                      */
/* ------------------------------------------------------------------ */

static void send_snapshot(void);

static void test_release_timer(lv_timer_t *timer)
{
    (void)timer;  /* one-shot: LVGL deletes it after this run */
    s_record_requested = false;
}

/*
 * Drive the UI from the Mac for automated hardware tests (host/test_board.py):
 *   @TEST QUERY <text>   same as typing <text> and pressing GO
 *   @TEST NAV <1|-1>     same as pressing PWR (next) / BOOT (previous)
 *   @TEST HOLD <ms>      same as holding the screen for <ms> (real microphone)
 *   @TEST STATE          logs "@STATE ..." for the test to check
 *   @TEST SNAPSHOT       sends the screen's pixels (see send_snapshot)
 */
static void handle_test_command(const char *command)
{
    if (strncmp(command, "QUERY ", 6) == 0) {
        if (s_state == APP_IDLE || s_state == APP_SHOWING) send_typed_query(command + 6);
    } else if (strncmp(command, "NAV ", 4) == 0) {
        navigate(atoi(command + 4) < 0 ? -1 : 1);
    } else if (strncmp(command, "HOLD ", 5) == 0) {
        request_record_start();
        lv_timer_t *release = lv_timer_create(test_release_timer, atoi(command + 5), NULL);
        lv_timer_set_repeat_count(release, 1);
    } else if (strcmp(command, "SNAPSHOT") == 0) {
        send_snapshot();
    } else if (strcmp(command, "STATE") == 0) {
        char line[160];
        snprintf(line, sizeof(line), "@STATE %d %d/%d %s ram_min=%u canvas=%d",
                 (int)s_state, s_match_index + 1, s_match_count,
                 s_match_count > 0 ? s_matches[s_match_index].id : "-",
                 (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                 !lv_obj_has_flag(s_canvas, LV_OBJ_FLAG_HIDDEN));
        serial_send_line(line);
    }
}

/*
 * Pixel-exact capture of what is on the panel (docs, videos):
 *   @SNAP <w> <h> <stride> / @SNAPDATA <b64 RGB565>... / @SNAPEND
 * Runs on the control task with the display lock held.
 */
static void send_snapshot(void)
{
    static lv_draw_buf_t snap;
    static uint8_t *pixels;
    lv_display_t *display = lv_display_get_default();
    const uint32_t w = lv_display_get_horizontal_resolution(display);
    const uint32_t h = lv_display_get_vertical_resolution(display);
    const uint32_t stride = lv_draw_buf_width_to_stride(w, LV_COLOR_FORMAT_RGB565);
    if (pixels == NULL) {
        pixels = heap_caps_malloc(stride * h, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (pixels == NULL ||
            lv_draw_buf_init(&snap, w, h, LV_COLOR_FORMAT_RGB565, stride, pixels, stride * h) != LV_RESULT_OK) {
            pixels = NULL;
            serial_send_line("@SNAPERR");
            return;
        }
    }
    if (lv_snapshot_take_to_draw_buf(lv_screen_active(), LV_COLOR_FORMAT_RGB565, &snap) != LV_RESULT_OK) {
        serial_send_line("@SNAPERR");
        return;
    }

    static uint8_t line[10 + 4100 + 2];  /* "@SNAPDATA " + base64(3072) + "\n" */
    const size_t total = stride * h, raw_chunk = 3072;
    const TickType_t timeout = pdMS_TO_TICKS(2000);
    xSemaphoreTakeRecursive(s_serial_mutex, portMAX_DELAY);
    int length = snprintf((char *)line, sizeof(line), "@SNAP %u %u %u\n", (unsigned)w, (unsigned)h, (unsigned)stride);
    bool ok = serial_write(line, (size_t)length, timeout);
    for (size_t offset = 0; ok && offset < total; offset += raw_chunk) {
        const size_t chunk = total - offset > raw_chunk ? raw_chunk : total - offset;
        size_t encoded = 0;
        memcpy(line, "@SNAPDATA ", 10);
        if (mbedtls_base64_encode(line + 10, sizeof(line) - 12, &encoded, pixels + offset, chunk) != 0) break;
        line[10 + encoded] = '\n';
        ok = serial_write(line, 10 + encoded + 1, timeout);
    }
    serial_write("@SNAPEND\n", 9, timeout);
    xSemaphoreGiveRecursive(s_serial_mutex);
}

static bool decode_b64_text(const char *payload, char *out, size_t out_size)
{
    size_t decoded_length = 0;
    if (mbedtls_base64_decode((uint8_t *)out, out_size - 1, &decoded_length,
                              (const uint8_t *)payload, strlen(payload)) != 0) {
        return false;
    }
    out[decoded_length] = '\0';
    return true;
}

/* Control messages: display lock held (runs on the control task). */
static void handle_control_line(char *line, size_t length)
{
    if (strncmp(line, "@TEXT ", 6) == 0) {
        char text[sizeof(s_pending_transcript)];
        if (decode_b64_text(line + 6, text, sizeof(text))) {
            strlcpy(s_pending_transcript, text, sizeof(s_pending_transcript));
            ESP_LOGI(TAG, "transcript: %s", s_pending_transcript);
            if (s_state == APP_WAITING) apply_waiting_ui(s_pending_transcript);
        }
    } else if (strncmp(line, "@RESULT ", 8) == 0) {
        handle_result(line + 8, length - 8);
    } else if (strncmp(line, "@ERROR ", 7) == 0) {
        char message[128];
        if (decode_b64_text(line + 7, message, sizeof(message))) {
            ESP_LOGW(TAG, "companion error: %s", message);
            if (s_state == APP_WAITING) {
                leave_waiting("LOOKUP FAILED", message);
            } else if (s_state == APP_SHOWING && s_match_count > 0) {
                flash_message_over_results(message);
            }
        }
    } else if (strncmp(line, "@TEST ", 6) == 0) {
        handle_test_command(line + 6);
    } else if (strncmp(line, "@READY", 6) == 0) {
        const int version = line[6] == ' ' ? atoi(line + 7) : 1;
        if (version != PROTOCOL_VERSION) {
            ESP_LOGE(TAG, "companion speaks protocol %d, firmware %d", version, PROTOCOL_VERSION);
            if (s_state == APP_IDLE) apply_idle_ui("Companion out of date\nUpdate host/pokemon_bridge.py");
            return;
        }
        ESP_LOGI(TAG, "companion ready");
        if (s_state == APP_IDLE) apply_idle_ui(s_keypad_mode ? "Companion ready\nType a card name, then GO"
                                                             : "Companion ready\nHold the screen and speak");
    }
}

static void control_task(void *arg)
{
    (void)arg;
    char *line = NULL;
    while (true) {
        if (xQueueReceive(s_control_queue, &line, portMAX_DELAY) != pdTRUE) continue;
        if (bsp_display_lock(0)) {
            handle_control_line(line, strlen(line));
            bsp_display_unlock();
        }
        free(line);
    }
}

/* Image lines are handled right here; everything else is queued so this
   task never blocks on the display and the RX ring never overflows. */
static void dispatch_line(char *line, size_t length)
{
    if (strncmp(line, "@DATA ", 6) == 0) {  /* hot path: ~30 lines per image */
        feed_image_chunk(line + 6, length - 6);
    } else if (strncmp(line, "@IMG ", 5) == 0) {
        char card_id[40] = {0};
        int width = 0, height = 0;
        if (sscanf(line + 5, "%39s %d %d", card_id, &width, &height) == 3) {
            begin_image(card_id, width, height);
        }
    } else if (strncmp(line, "@IMGEND ", 8) == 0) {
        finish_image(line + 8);
    } else if (strncmp(line, "@IMGERR ", 8) == 0) {
        image_failed(line + 8);
    } else if (line[0] == '@') {
        char *copy = heap_caps_malloc(length + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (copy == NULL) return;
        memcpy(copy, line, length + 1);
        if (xQueueSend(s_control_queue, &copy, pdMS_TO_TICKS(50)) != pdTRUE) {
            ESP_LOGW(TAG, "control queue full; dropped %.12s", line);
            free(copy);
        }
    }
}

static void serial_receive_task(void *arg)
{
    (void)arg;
    static char line[SERIAL_LINE_MAX];
    static uint8_t rx_buffer[2048];
    size_t length = 0;
    bool overflow = false;

    /* Announce ourselves: the companion answers with @READY, so it does not
       matter which side started first */
    char hello[24];
    snprintf(hello, sizeof(hello), "@HELLO %d", PROTOCOL_VERSION);
    serial_send_line(hello);

    while (true) {
        const int received = usb_serial_jtag_read_bytes(rx_buffer, sizeof(rx_buffer), portMAX_DELAY);
        for (int i = 0; i < received; ++i) {
            const char input = (char)rx_buffer[i];
            if (input != '\r' && input != '\n') {
                if (length + 1 < sizeof(line)) {
                    line[length++] = input;
                } else {
                    overflow = true;
                }
                continue;
            }
            if (length > 0 && !overflow) {
                line[length] = '\0';
                dispatch_line(line, length);
            } else if (overflow) {
                ESP_LOGW(TAG, "dropped over-long serial line");
            }
            length = 0;
            overflow = false;
        }
    }
}

/* ------------------------------------------------------------------ */
/* Touch: right-edge strips ONLY flip pages; hold the center to record. */
/* Driven by LVGL press/move/release events so coordinates are always    */
/* fresh (a polling timer raced the input pipeline and missed taps).     */
/* ------------------------------------------------------------------ */

/* Display lock held. After a failed voice search the old results wait
   behind the listen screen: flipping brings them back. */
static void navigate(int direction)
{
    if (s_state == APP_WAITING || s_state == APP_RECORDING) return;
    if (s_match_count == 0) {
        /* Nothing to flip through yet: say so instead of staying silent */
        lv_label_set_text(s_hint_label, "No results yet\n\nHold the screen and\nsay a card name");
        return;
    }
    if (s_state == APP_IDLE) {
        s_state = APP_SHOWING;
        s_display_retries = 2;
        apply_showing_ui(true);
        return;
    }

    const int target = s_match_index + direction;
    if (target < 0 || target >= s_match_count) {
        ESP_LOGI(TAG, "edge of list; staying on %d/%d", s_match_index + 1, s_match_count);
        return; /* no wrap-around: 1/5 stays put on "previous" */
    }
    s_match_index = target;
    ESP_LOGI(TAG, "navigate to match %d: %s %s #%s", s_match_index,
             s_matches[s_match_index].name, s_matches[s_match_index].set_name,
             s_matches[s_match_index].number);

    s_display_retries = 2;
    apply_showing_ui(true);
}

/*
 * Voice mode: the screen is a push-to-talk button. Touching it starts
 * listening at once (the pre-roll keeps the first syllable), lifting the
 * finger searches. Keypad mode: the keys handle their own taps, and a tap on
 * the results goes back to the keypad.
 */
static void screen_touch_event_cb(lv_event_t *event)
{
    const lv_event_code_t code = lv_event_get_code(event);

    if (s_screen_off) return;  /* only a double jerk (or a side button) wakes it */

    if (s_ignore_touch) {
        if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
            s_ignore_touch = false;  /* clean release: touch trusted again */
            ESP_LOGI(TAG, "touch re-armed after wake");
        }
        return;
    }

    if (code == LV_EVENT_PRESSED) {
        /* Re-assert backlight: panel can drop brightness while idle.
           (No full-screen invalidate here: it redrew all 448 lines per tap.) */
        ESP_ERROR_CHECK_WITHOUT_ABORT(bsp_display_brightness_set(s_brightness));
        if (!s_keypad_mode) {
            request_record_start();
            if (s_record_requested) apply_recording_ui();
        }
    } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
        s_record_requested = false;  /* release ends the recording */
        if (s_keypad_mode && s_state == APP_SHOWING) {
            s_state = APP_IDLE;
            apply_idle_ui(idle_hint());
        }
    }
}

/* ------------------------------------------------------------------ */
/* UI construction                                                     */
/* ------------------------------------------------------------------ */

static void brightness_keepalive_timer(lv_timer_t *timer)
{
    (void)timer;
    if (s_screen_off) return;  /* the user turned it off on purpose */

    /* Re-assert display power rails: a dropped expander output blacks the
       panel out in a way only a replug used to fix */
    const uint32_t power_rails =
        IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2;
    esp_io_expander_set_level(s_io_expander, power_rails, 1);

    ESP_ERROR_CHECK_WITHOUT_ABORT(bsp_display_brightness_set(s_brightness));
    lv_obj_invalidate(lv_screen_active());  /* guarantees fresh panel traffic */
}

static void create_ui(void)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x080b18), LV_PART_MAIN);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

    /* Full-screen capture zone: created first so every widget sits above it.
       Push-to-talk hangs off its events. */
    lv_obj_t *touch_zone = lv_obj_create(screen);
    lv_obj_set_size(touch_zone, 368, 448);
    lv_obj_set_pos(touch_zone, 0, 0);
    lv_obj_set_style_bg_opa(touch_zone, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(touch_zone, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(touch_zone, 0, LV_PART_MAIN);
    lv_obj_clear_flag(touch_zone, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(touch_zone, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(touch_zone, screen_touch_event_cb, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(touch_zone, screen_touch_event_cb, LV_EVENT_RELEASED, NULL);
    lv_obj_add_event_cb(touch_zone, screen_touch_event_cb, LV_EVENT_PRESS_LOST, NULL);

    s_name_label = lv_label_create(screen);
    lv_label_set_text(s_name_label, "POKEDEX");
    lv_obj_set_style_text_font(s_name_label, &lv_font_montserrat_24, LV_PART_MAIN);
    lv_obj_set_style_text_color(s_name_label, lv_color_hex(0xa78bfa), LV_PART_MAIN);
    lv_obj_set_width(s_name_label, 270);
    lv_label_set_long_mode(s_name_label, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(s_name_label, LV_TEXT_ALIGN_LEFT, LV_PART_MAIN);
    lv_obj_align(s_name_label, LV_ALIGN_TOP_LEFT, 14, 10);

    s_page_label = lv_label_create(screen);
    lv_obj_set_style_text_font(s_page_label, &lv_font_montserrat_18, LV_PART_MAIN);
    lv_obj_set_style_text_color(s_page_label, lv_color_hex(0x8b93b5), LV_PART_MAIN);
    lv_obj_align(s_page_label, LV_ALIGN_TOP_RIGHT, -14, 14);
    lv_obj_add_flag(s_page_label, LV_OBJ_FLAG_HIDDEN);

    s_hint_panel = lv_obj_create(screen);
    lv_obj_set_size(s_hint_panel, 340, 96);
    lv_obj_align(s_hint_panel, LV_ALIGN_TOP_MID, 0, 100);
    lv_obj_set_style_radius(s_hint_panel, 16, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_hint_panel, lv_color_hex(0x171a2d), LV_PART_MAIN);
    lv_obj_set_style_border_color(s_hint_panel, lv_color_hex(0x6f5bd3), LV_PART_MAIN);
    lv_obj_set_style_border_width(s_hint_panel, 1, LV_PART_MAIN);
    lv_obj_clear_flag(s_hint_panel, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(s_hint_panel, LV_OBJ_FLAG_CLICKABLE);  /* let presses reach the zone */

    s_hint_label = lv_label_create(s_hint_panel);
    lv_label_set_text(s_hint_label, "Hold the screen and\nsay a card name");
    lv_obj_set_style_text_color(s_hint_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_style_text_font(s_hint_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_align(s_hint_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_center(s_hint_label);

    s_typed_label = lv_label_create(screen);
    lv_label_set_text(s_typed_label, " ");
    lv_obj_set_style_text_font(s_typed_label, &lv_font_montserrat_18, LV_PART_MAIN);
    lv_obj_set_style_text_color(s_typed_label, lv_color_hex(0xfbbf24), LV_PART_MAIN);
    lv_obj_set_width(s_typed_label, 340);
    lv_label_set_long_mode(s_typed_label, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(s_typed_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_align(s_typed_label, LV_ALIGN_TOP_MID, 0, 74);

    s_image_buffer = heap_caps_malloc(IMG_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_image_buffer != NULL) {
        s_canvas = lv_canvas_create(screen);
        lv_canvas_set_buffer(s_canvas, s_image_buffer, IMG_WIDTH, IMG_HEIGHT, LV_COLOR_FORMAT_RGB565);
        lv_obj_align(s_canvas, LV_ALIGN_TOP_MID, 0, 44);
        lv_obj_clear_flag(s_canvas, LV_OBJ_FLAG_CLICKABLE);  /* let presses reach the zone */
        lv_obj_add_flag(s_canvas, LV_OBJ_FLAG_HIDDEN);
    } else {
        ESP_LOGE(TAG, "could not allocate image buffer");
    }

    for (int i = 0; i < IMG_CACHE_SLOTS; ++i) {
        s_img_slots[i].pixels = heap_caps_malloc(IMG_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_img_slots[i].pixels == NULL) {
            ESP_LOGW(TAG, "image cache slot %d unavailable", i);
        }
    }

    s_number_label = lv_label_create(screen);
    lv_label_set_recolor(s_number_label, true);
    lv_obj_set_style_text_font(s_number_label, &lv_font_montserrat_24, LV_PART_MAIN);
    lv_obj_set_style_text_color(s_number_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_width(s_number_label, 340);
    lv_label_set_long_mode(s_number_label, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(s_number_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_align(s_number_label, LV_ALIGN_TOP_MID, 0, 322);
    lv_obj_add_flag(s_number_label, LV_OBJ_FLAG_HIDDEN);

    s_set_label = lv_label_create(screen);
    lv_obj_set_style_text_font(s_set_label, &lv_font_montserrat_18, LV_PART_MAIN);
    lv_obj_set_style_text_color(s_set_label, lv_color_hex(0x8b93b5), LV_PART_MAIN);
    lv_obj_set_style_text_align(s_set_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_align(s_set_label, LV_ALIGN_TOP_MID, -28, 358);
    lv_obj_add_flag(s_set_label, LV_OBJ_FLAG_HIDDEN);

    s_price_label = lv_label_create(screen);
    lv_obj_set_style_text_font(s_price_label, &lv_font_montserrat_24, LV_PART_MAIN);
    lv_obj_set_style_text_color(s_price_label, lv_color_hex(0xfbbf24), LV_PART_MAIN);
    lv_obj_set_style_text_align(s_price_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_align(s_price_label, LV_ALIGN_TOP_MID, -28, 396);
    lv_obj_add_flag(s_price_label, LV_OBJ_FLAG_HIDDEN);

    create_keypad(screen);

    memset(&s_ball_descriptor, 0, sizeof(s_ball_descriptor));
    s_ball_descriptor.header.magic = LV_IMAGE_HEADER_MAGIC;
    s_ball_descriptor.header.cf = LV_COLOR_FORMAT_RGB565;
    s_ball_descriptor.header.w = BALL_SIZE;
    s_ball_descriptor.header.h = BALL_SIZE;
    s_ball_descriptor.header.stride = BALL_SIZE * 2;
    s_ball_descriptor.data_size = ball_end - ball_start;
    s_ball_descriptor.data = ball_start;
    s_ball = lv_image_create(screen);
    lv_image_set_src(s_ball, &s_ball_descriptor);
    lv_image_set_pivot(s_ball, BALL_SIZE / 2, BALL_SIZE / 2);
    lv_obj_align(s_ball, LV_ALIGN_TOP_MID, -28, 120);
    lv_obj_add_flag(s_ball, LV_OBJ_FLAG_HIDDEN);

    s_analyzing_label = lv_label_create(screen);
    lv_label_set_text(s_analyzing_label, "ANALYZING...");
    lv_obj_set_style_text_font(s_analyzing_label, &lv_font_montserrat_18, LV_PART_MAIN);
    lv_obj_set_style_text_color(s_analyzing_label, lv_color_hex(0xfbbf24), LV_PART_MAIN);
    lv_obj_align(s_analyzing_label, LV_ALIGN_TOP_MID, -28, 262);
    lv_obj_add_flag(s_analyzing_label, LV_OBJ_FLAG_HIDDEN);

    lv_timer_create(brightness_keepalive_timer, 5000, NULL);
    lv_timer_create(ball_spin_timer, 33, NULL);
    lv_timer_create(lookup_watchdog_timer, 500, NULL);
    lv_timer_create(image_sync_timer, 30, NULL);
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

void app_main(void)
{
    ESP_ERROR_CHECK(init_serial());
    s_image_mutex = xSemaphoreCreateMutex();
    s_control_queue = xQueueCreate(8, sizeof(char *));
    ESP_ERROR_CHECK(s_image_mutex && s_control_queue ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(prepare_v2_expander_power());

    lv_display_t *display = bsp_display_start();
    ESP_ERROR_CHECK(display ? ESP_OK : ESP_FAIL);
    s_touch_input = bsp_display_get_input_dev();
    ESP_ERROR_CHECK(s_touch_input ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(bsp_display_brightness_set(s_brightness));
    ESP_ERROR_CHECK(bsp_display_lock(2000) ? ESP_OK : ESP_ERR_TIMEOUT);
    create_ui();
    bsp_display_unlock();

    ESP_ERROR_CHECK(init_buttons());
    init_imu();
    ESP_ERROR_CHECK(init_microphone());
    ESP_ERROR_CHECK(xTaskCreate(record_task, "record", 16384, NULL, 7, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(xTaskCreate(control_task, "control", 8192, NULL, 5, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    /* Highest of the app tasks: it must always keep up with the USB RX ring */
    ESP_ERROR_CHECK(xTaskCreate(serial_receive_task, "serial_rx", 6144, NULL, 8, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_LOGI(TAG, "Pokedex v2.0 ready (%s %s), internal RAM free %u, PSRAM free %u",
             __DATE__, __TIME__,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

/*
 * Wi-Fi + secure WebSocket link to the companion (CONFIG_POKEDEX_WIFI).
 *
 * Joins the configured network (falling back to the second one, if set),
 * then keeps a WebSocket open to CONFIG_POKEDEX_SERVER_URL, presenting the
 * shared token in a header. Frames carry the same newline-separated protocol
 * as USB; the caller reassembles lines. Everything reconnects on its own.
 */
#include "wifi_link.h"

#include <string.h>
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "nvs_flash.h"

static const char *TAG = "wifi_link";

static wifi_link_callbacks_t s_callbacks;
static esp_websocket_client_handle_t s_client;
static volatile bool s_connected;
static int s_network;  /* 0 = first SSID, 1 = second */
static char s_headers[160];

static void status(const char *text)
{
    ESP_LOGI(TAG, "%s", text);
    if (s_callbacks.on_status) s_callbacks.on_status(text);
}

static bool has_second_network(void)
{
    return CONFIG_POKEDEX_WIFI_SSID2[0] != '\0';
}

static void join(int network)
{
    wifi_config_t config = {0};
    const char *ssid = network ? CONFIG_POKEDEX_WIFI_SSID2 : CONFIG_POKEDEX_WIFI_SSID;
    const char *password = network ? CONFIG_POKEDEX_WIFI_PASSWORD2 : CONFIG_POKEDEX_WIFI_PASSWORD;
    strlcpy((char *)config.sta.ssid, ssid, sizeof(config.sta.ssid));
    strlcpy((char *)config.sta.password, password, sizeof(config.sta.password));
    config.sta.threshold.authmode = password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    config.sta.pmf_cfg.capable = true;
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_config(WIFI_IF_STA, &config));
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_connect());
    char text[64];
    snprintf(text, sizeof(text), "Wi-Fi: joining %.32s", ssid);
    status(text);
}

static void websocket_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    const esp_websocket_event_data_t *event = data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        s_connected = true;
        status("Mac: connected over Wi-Fi");
        if (s_callbacks.on_connected) s_callbacks.on_connected();
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        if (s_connected) status("Mac: connection lost, retrying");
        s_connected = false;
        break;
    case WEBSOCKET_EVENT_DATA:
        /* Text frames (and their continuations) carry protocol bytes */
        if ((event->op_code == 0x1 || event->op_code == 0x0) && event->data_len > 0 && s_callbacks.on_bytes) {
            s_callbacks.on_bytes(event->data_ptr, (size_t)event->data_len);
        }
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGW(TAG, "websocket error");
        break;
    default:
        break;
    }
}

static void start_websocket(void)
{
    if (s_client != NULL) {
        esp_websocket_client_start(s_client);  /* no-op if already running */
        return;
    }
    snprintf(s_headers, sizeof(s_headers), "X-PokeDex-Token: %s\r\n", CONFIG_POKEDEX_TOKEN);
    const esp_websocket_client_config_t config = {
        .uri = CONFIG_POKEDEX_SERVER_URL,
        .headers = s_headers,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 8192,
        .task_stack = 8192,
        .reconnect_timeout_ms = 3000,
        .network_timeout_ms = 15000,
        .ping_interval_sec = 10,
    };
    s_client = esp_websocket_client_init(&config);
    if (s_client == NULL) {
        status("Mac: could not start the link");
        return;
    }
    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, websocket_event, NULL);
    status("Mac: connecting...");
    esp_websocket_client_start(s_client);
}

static void network_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        join(s_network);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        if (s_client != NULL) esp_websocket_client_stop(s_client);
        /* Alternate between the two networks until one answers */
        if (has_second_network()) s_network = !s_network;
        vTaskDelay(pdMS_TO_TICKS(1500));
        join(s_network);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        status("Wi-Fi: connected");
        start_websocket();
    }
}

void wifi_link_start(const wifi_link_callbacks_t *callbacks)
{
    s_callbacks = *callbacks;
    if (CONFIG_POKEDEX_WIFI_SSID[0] == '\0') {
        status("Wi-Fi: no network configured");
        return;
    }
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, network_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, network_event, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));
    ESP_ERROR_CHECK(esp_wifi_start());
}

bool wifi_link_connected(void)
{
    return s_connected;
}

bool wifi_link_write(const void *data, size_t length, TickType_t timeout)
{
    if (!s_connected || s_client == NULL) return false;
    return esp_websocket_client_send_text(s_client, data, (int)length, timeout) == (int)length;
}

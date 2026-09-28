#pragma once
/*
 * Optional network link (CONFIG_POKEDEX_WIFI): Wi-Fi + a secure WebSocket to
 * the companion, carrying the same line protocol as USB.
 */
#include <stdbool.h>
#include <stddef.h>
#include "freertos/FreeRTOS.h"

typedef struct {
    void (*on_bytes)(const char *data, size_t length); /* protocol bytes received */
    void (*on_status)(const char *status);             /* human-readable link state */
    void (*on_connected)(void);                        /* WebSocket up: say hello */
} wifi_link_callbacks_t;

void wifi_link_start(const wifi_link_callbacks_t *callbacks);
bool wifi_link_connected(void);
bool wifi_link_write(const void *data, size_t length, TickType_t timeout);

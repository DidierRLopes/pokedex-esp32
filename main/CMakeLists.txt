set(srcs "pokemon_lookup.c")
# The network components are always declared (requirements are resolved
# before sdkconfig is known) but only the Wi-Fi build (CONFIG_POKEDEX_WIFI,
# see tools/build_wifi.sh) compiles wifi_link.c, so the default USB build
# links none of it.
set(requires esp32_s3_touch_amoled_1_8 esp_codec_dev mbedtls esp_driver_gpio esp_driver_usb_serial_jtag json
             esp_wifi esp_netif esp_event nvs_flash esp-tls espressif__esp_websocket_client)
if(CONFIG_POKEDEX_WIFI)
    list(APPEND srcs "wifi_link.c")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES ${requires}
    EMBED_FILES "assets/pokeball.rgb565"
)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error=shift-count-negative)

idf_component_get_property(LVGL_LIB lvgl__lvgl COMPONENT_LIB)
if(TARGET ${LVGL_LIB})
    target_compile_options(${LVGL_LIB} PRIVATE -Wno-error=attributes)
endif()

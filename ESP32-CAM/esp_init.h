#ifndef ESP_INIT_H
#define ESP_INIT_H

#include <Arduino.h>
#include "esp_camera.h"

// FIRMWARE_VERSION is normally injected from ESP32-CAM/VERSION by:
//   * bash ESP32-CAM/build.sh  (arduino-cli release path, --build-property)
//   * pio run -e esp32cam      (PlatformIO via extra_scripts.py)
// This "dev-unset" fallback only fires when the sketch is compiled directly
// in Arduino IDE without going through either build path. The string surfaces
// in the boot log, telemetry sidecar, and heartbeat row, so a non-release
// build is recognisable at a glance — switch to build.sh for a real release.
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "dev-unset"
#endif


typedef struct {
  char SSID[64];
  char PASSWORD[64];
} wifi_configuration_t;

typedef struct {
  float latitude;
  float longitude;
  float accuracy;
} geolocation_t;

typedef struct {
  char CONFIG_FILE[32];

  /* esp module information */
  uint64_t esp_ID;
  char module_name[64];
  char email[128];
  uint8_t battery_level;
  bool is_configured;

  /* connectivity */
  wifi_configuration_t wifi_config;
  geolocation_t geolocation;
  char INIT_URL[128];
  char UPLOAD_URL[128];

  /* camera setup */
  framesize_t RESOLUTION;
  int CAPTURE_INTERVAL;
  int vertical_flip;
  int brightness;
  int saturation;
} esp_config_t;


bool isESPConfigured();
void setESPConfigured(bool value);

/* Settle delay between mutating NVS (e.g. setESPConfigured(false)) and
   ESP.restart(), so the flash write commits and the WiFi/HTTP stack can
   finish flushing FINs. Used by the auto-AP-fallback path in
   ESP32-CAM.ino's setup() and by the /factory_reset endpoint in
   host.cpp. */
#define FACTORY_RESET_SETTLE_MS 500UL

/* Persisted counter of consecutive WiFi-join timeouts. Cleared on a
   successful join; bumped from setupWifiConnection() each time the 30 s
   begin() loop times out. Used at boot to decide whether to drop back
   into AP-config mode automatically — the user can also trigger the
   same NVS mutation by hand via the captive portal's POST /factory_reset
   endpoint once the AP has reopened.

   Storage: NVS namespace "config", key "wifi_fails" (uint8). */
uint8_t getWifiFailCount();
void setWifiFailCount(uint8_t value);

/* Boot-time consecutive-fail threshold at which the firmware re-opens
   the captive portal automatically. Three failed boots × ~30 s ≈ 90 s
   before the AP returns. Read by setup() in ESP32-CAM.ino. */
#ifndef WIFI_FAIL_AP_FALLBACK_THRESH
#define WIFI_FAIL_AP_FALLBACK_THRESH 3
#endif
String generateModuleName();
bool loadConfig(esp_config_t *esp_config);
void initEspPinout();
void initEspCamera(framesize_t resolution);
void recoverCamera(framesize_t resolution);
void configure_camera_sensor(esp_config_t *esp_config);
void setupWifiConnection(wifi_configuration_t *wifi_config);
void getGeolocation(esp_config_t *esp_config);
void initNewModuleOnServer(esp_config_t *esp_config);

/* Telemetry: reset-reason + boot count persistence + WiFi recovery */
uint32_t incrementBootCount();
bool reconnectWifi(wifi_configuration_t *wifi_config);

#endif
#ifndef ESP_INIT_H
#define ESP_INIT_H

#include "esp_camera.h"

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "1.0.0"
#endif


// SSID: IEEE 802.11 caps at 32 octets, so 64 has comfortable headroom.
// PASSWORD: WPA2-PSK accepts up to 63 ASCII chars OR exactly 64 hex chars
// (raw PSK). The previous 64-byte buffer silently truncated 64-char raw-PSK
// values via strlcpy, producing a credential that bricked the onboarding
// flow with no surfaced error. 96 keeps a safe margin and is enforced both
// here and in the wizard's pre-flight check.
typedef struct {
  char SSID[64];
  char PASSWORD[96];
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
bool loadConfig(esp_config_t *esp_config);
void initEspPinout();
void initEspCamera(framesize_t resolution);
void configure_camera_sensor(esp_config_t *esp_config);
void setupWifiConnection(wifi_configuration_t *wifi_config);
void getGeolocation(esp_config_t *esp_config);
void initNewModuleOnServer(esp_config_t *esp_config);

/* Telemetry: reset-reason + boot count persistence + WiFi recovery */
uint32_t incrementBootCount();
bool reconnectWifi(wifi_configuration_t *wifi_config);

#endif
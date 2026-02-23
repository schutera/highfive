#ifndef ESP_INIT_H
#define ESP_INIT_H

#include "esp_camera.h"


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

#endif
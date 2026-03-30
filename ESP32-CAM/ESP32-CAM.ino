#include "esp_camera.h"
#include "esp_init.h"
#include "host.h"
#include "client.h"
#include <Arduino.h>
#include <SPIFFS.h>


#define CONFIG_BUTTON 0

const char *CONFIG_FILE_PATH = "/config.json";
esp_config_t esp_config;
int counter = 0;
bool firstCaptureDone = false;
int lastCaptureDay = -1;




/*
 * ------------------------------------------------------------------------------
 * PROGRAM START
 * ------------------------------------------------------------------------------
*/
void setup() {
  Serial.begin(115200);

  pinMode(CONFIG_BUTTON, INPUT_PULLUP);

  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS Mount Failed");
    return;
  }

  Serial.setDebugOutput(true);
  Serial.println();
  delay(200);

  Serial.println("------ ESP STARTED ------");

  strlcpy(esp_config.CONFIG_FILE, CONFIG_FILE_PATH, sizeof(esp_config.CONFIG_FILE));

  // Check for config reset: hold GPIO0 LOW for 5 seconds at boot
  // Must happen before camera init claims GPIO0 for XCLK
  if (digitalRead(CONFIG_BUTTON) == LOW) {
    Serial.println("CONFIG button held at boot - hold for 5s to reset...");
    unsigned long start = millis();
    while (digitalRead(CONFIG_BUTTON) == LOW) {
      if (millis() - start > 5000) {
        Serial.println("Long press detected - resetting config");
        setESPConfigured(false);
        delay(500);
        ESP.restart();
      }
      delay(50);
    }
    Serial.println("Button released, continuing normal boot");
  }

  /*
    ESP opens WiFi access point to receive the configuration from user input

    Once connected go to:

          ==============================
          ===== http://192.168.4.1 ===== -> ESP softAP() endpoint
          ==============================

    to type in WiFi credentials, endpoint URL and camera settings
  */
  Serial.println("[ESP] OPENING ACCESS POINT");
  Serial.println("------ Connect on http://192.168.4.1 to configure ------");

  if (!isESPConfigured()) {
    Serial.println("-- ESP not yet configured. Opening ESP access point...");
    setupAccessPoint();
  } else {
    Serial.println("-- ESP already configured. To reconfigure, hold CONFIG button (GPIO0) while pressing RESET. Keep holding for 5 seconds until you see the reset message.");
  }

  Serial.println("[ESP] INITIALIZING ESP");

  if (!loadConfig(&esp_config)) {
    Serial.println("-- Failed to configure ESP");
  }

  /*
    initialization of ESP + cam
  */
  initEspPinout();
  initEspCamera(esp_config.RESOLUTION);
  configure_camera_sensor(&esp_config);

  Serial.printf("[ESP] CONFIGURING WIFI CONNECTION TO %s\n", esp_config.wifi_config.SSID);
  setupWifiConnection(&esp_config.wifi_config);


  // GEOLOCATION [TEST]
  getGeolocation(&esp_config);

  Serial.print("Latitude: ");
  Serial.println(esp_config.geolocation.latitude, 6);

  Serial.print("Longitude: ");
  Serial.println(esp_config.geolocation.longitude, 6);

  Serial.print("Accuracy (m): ");
  Serial.println(esp_config.geolocation.accuracy);

  // ---- Initialize new module on server ---- //
  initNewModuleOnServer(&esp_config);

  Serial.println("[ESP] SETUP COMPLETE");

  // Flush stale frame buffer accumulated during WiFi/geolocation operations
  camera_fb_t *stale = esp_camera_fb_get();
  if (stale) esp_camera_fb_return(stale);
  delay(1000); // Let camera sensor stabilize after RF operations

  Serial.println("");
  Serial.println("---------------------");
  Serial.println("");
  Serial.println("STARTING CAMERA STREAM");
}


void captureAndUpload() {
  Serial.println("");
  Serial.printf("-- Trying to capture and post image number %d\n", counter++);

  int httpCode = -1;
  for (int attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      Serial.printf("---- Retry attempt %d/3\n", attempt + 1);
      delay(2000);
    }
    httpCode = postImage(&esp_config);
    if (httpCode != -1) break;
  }

  if (httpCode == -1) {
    Serial.println("---- Camera error. Could not capture image after 3 attempts");
    return;
  } else if (httpCode == -2) {
    Serial.println("---- Network error. Could not start the host connection");
    return;
  }  else if (httpCode == -3) {
    Serial.println("---- Data error. Could not send the complete image");
    return;
  } else if (httpCode == -4) {
    Serial.println("---- HTTP error. Invalid or missing HTTP response");
    return;
  }

  Serial.printf("---- %s responded with status: %d\n", esp_config.UPLOAD_URL, httpCode);

  switch (httpCode) {
    case 200:
    case 201:
        Serial.println("------ Success");
        break;

    case 400:
        Serial.println("------ Bad Request");
        break;

    case 401:
    case 403:
        Serial.println("------ Unauthorized or Forbidden");
        break;

    case 404:
        Serial.println("------ URL Not Found");
        break;

    case 500:
    case 502:
    case 503:
        Serial.println("------ Server-side error");
        break;

    default:
        Serial.printf("------ Unexpected response code: %d\n", httpCode);
        break;
  }

  Serial.printf("-- Finished capturing and posting image %d\n", counter);
}

void loop() {
  // NOTE: GPIO0 config button check moved to setup() — it cannot be read
  // reliably here because the camera XCLK drives GPIO0 after init.

  // First capture immediately after boot
  if (!firstCaptureDone) {
    Serial.println("-- First capture after boot");
    captureAndUpload();
    firstCaptureDone = true;
  }

  // Daily capture at noon (local time via NTP)
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 200)) {
    if (timeinfo.tm_hour == 12 && timeinfo.tm_yday != lastCaptureDay) {
      Serial.println("-- Noon capture");
      captureAndUpload();
      lastCaptureDay = timeinfo.tm_yday;
    }
  }

  delay(30000);  // check every 30 seconds
}

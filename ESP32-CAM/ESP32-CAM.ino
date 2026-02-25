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

// CONFIG button params
unsigned long pressStart = 0;
bool pressed = false;



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
    Serial.println("-- ESP already configured. Press and hold CONFIG button (GPIO0) on ESP for 10-15 seconds to restart and reconfigure through the ESP access point. Do not press RESET button during this period as this will enter flash mode.");
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
  Serial.println("");
  Serial.println("---------------------");
  Serial.println("");
  Serial.println("STARTING CAMERA STREAM");
}


void loop() {

  if (digitalRead(CONFIG_BUTTON) == LOW) {
    if (!pressed) {
      pressStart = millis();
      pressed = true;
    }

    if (millis() - pressStart > 7000) {  // 7 seconds
      Serial.println("Long press detected - resetting config");
      setESPConfigured(false);
      delay(500);
      ESP.restart();
    }
  } else {
      pressed = false;
  }

  Serial.println("");
  Serial.printf("-- Trying to capture and post image number %d\n", counter++);

  int httpCode = postImage(&esp_config);
  if (httpCode == -1) {
    Serial.println("---- Camera error. Could not capture image");
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

  delay(esp_config.CAPTURE_INTERVAL);
}

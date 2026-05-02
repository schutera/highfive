#include "esp_camera.h"
#include "esp_init.h"
#include "host.h"
#include "client.h"
#include <Arduino.h>
#include <SPIFFS.h>
#include <Preferences.h>


#define CONFIG_BUTTON 0
#define HEARTBEAT_INTERVAL_MS (60UL * 60UL * 1000UL)  // 1 hour
#define DAILY_REBOOT_MS       (24UL * 3600UL * 1000UL)

const char *CONFIG_FILE_PATH = "/config.json";
esp_config_t esp_config;
int counter = 0;
bool firstCaptureDone = false;
int lastCaptureDay = -1;
unsigned long lastHeartbeatMs = 0;




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
    WiFi + network operations BEFORE camera init.
    Camera and WiFi share DMA channels / PSRAM on ESP32 —
    initializing the camera first and then doing heavy RF work
    corrupts the camera's DMA buffers, causing esp_camera_fb_get() to return NULL.
  */
  initEspPinout();

  Serial.printf("[ESP] CONFIGURING WIFI CONNECTION TO %s\n", esp_config.wifi_config.SSID);
  setupWifiConnection(&esp_config.wifi_config);

  getGeolocation(&esp_config);

  Serial.print("Latitude: ");
  Serial.println(esp_config.geolocation.latitude, 6);

  Serial.print("Longitude: ");
  Serial.println(esp_config.geolocation.longitude, 6);

  Serial.print("Accuracy (m): ");
  Serial.println(esp_config.geolocation.accuracy);

  // ---- Initialize new module on server ---- //
  initNewModuleOnServer(&esp_config);

  /*
    Camera init AFTER all WiFi/network operations to avoid DMA conflicts
  */
  Serial.println("[ESP] INITIALIZING CAMERA");
  initEspCamera(esp_config.RESOLUTION);
  configure_camera_sensor(&esp_config);

  // Warm up: sensor needs a few frames to auto-expose before producing valid JPEGs
  Serial.println("-- warming up camera sensor");
  for (int i = 0; i < 3; i++) {
    delay(500);
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) {
      esp_camera_fb_return(fb);
      Serial.printf("---- warm-up frame %d OK (%u bytes)\n", i + 1, fb->len);
    } else {
      Serial.printf("---- warm-up frame %d skipped (NULL)\n", i + 1);
    }
  }

  // If this boot was triggered by our 24h daily-reboot path, skip the
  // first-capture-on-boot. Hard resets / crashes / fresh flashes still
  // get a boot image (useful smoke test); only the routine daily wake
  // is silent so we don't double the daily image cost.
  {
    Preferences bootPrefs;
    bootPrefs.begin("boot", false);
    if (bootPrefs.getBool("daily_reboot", false)) {
      Serial.println("[BOOT] daily-reboot wake — skipping first capture");
      firstCaptureDone = true;
      bootPrefs.putBool("daily_reboot", false);
    }
    bootPrefs.end();
  }

  Serial.println("[ESP] SETUP COMPLETE");

  Serial.println("");
  Serial.println("---------------------");
  Serial.println("");
  Serial.println("STARTING CAMERA STREAM");
}


bool captureAndUpload() {
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

  // Circuit breaker: too many consecutive failures (any kind — camera NULL,
  // network error, or non-2xx HTTP) and we ESP.restart(). Caller gates on
  // the bool return so a failed first-capture-on-boot is retried on the
  // next loop iteration (30s later), giving the breaker a chance to fire.
  static uint8_t consecutiveFailures = 0;
  bool uploadOk = false;

  if (httpCode == -1) {
    Serial.println("---- Camera error. Could not capture image after 3 attempts");
  } else if (httpCode == -2) {
    Serial.println("---- Network error. Could not start the host connection");
  } else if (httpCode == -3) {
    Serial.println("---- Data error. Could not send the complete image");
  } else if (httpCode == -4) {
    Serial.println("---- HTTP error. Invalid or missing HTTP response");
  } else {
    // Real HTTP exchange happened — classify the status code.
    Serial.printf("---- %s responded with status: %d\n", esp_config.UPLOAD_URL, httpCode);
  }

  // Only run the HTTP-status switch for actual HTTP codes (>=100). Sentinel
  // values from postImage (-1, -2, -3, -4) are not response codes and would
  // print the misleading "Unexpected response code: -1" line.
  if (httpCode >= 100) {
  switch (httpCode) {
    case 200:
    case 201:
        Serial.println("------ Success");
        uploadOk = true;
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
  }

  if (uploadOk) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    Serial.printf("---- upload failure streak: %u/5\n", consecutiveFailures);
    if (consecutiveFailures >= 5) {
      Serial.println("[!] 5 consecutive upload failures — restarting");
      delay(1000);
      ESP.restart();
    }
  }

  Serial.printf("-- Finished capturing and posting image %d\n", counter);
  return uploadOk;
}

void loop() {
  // NOTE: GPIO0 config button check moved to setup() — it cannot be read
  // reliably here because the camera XCLK drives GPIO0 after init.

  // Daily reboot safety net: prevents long-running drift (lwIP state, NVS
  // wear oddities, slow heap fragmentation). Triggers once at 24h uptime
  // and never again until the next boot resets millis(). Sets an NVS flag
  // so setup() on the next boot can skip first-capture-on-boot — saves
  // one image/day.
  if (millis() > DAILY_REBOOT_MS) {
    Serial.println("[REBOOT] daily reboot");
    Preferences bootPrefs;
    bootPrefs.begin("boot", false);
    bootPrefs.putBool("daily_reboot", true);
    bootPrefs.end();
    delay(500);
    ESP.restart();
  }

  // Hourly heartbeat so the dashboard knows the module is alive between
  // images. Tiny payload, no camera work, fails-quiet — never restarts.
  if (millis() - lastHeartbeatMs > HEARTBEAT_INTERVAL_MS || lastHeartbeatMs == 0) {
    sendHeartbeat(&esp_config);
    lastHeartbeatMs = millis();
  }

  // First capture immediately after boot. Retry every loop iteration on
  // failure (camera NULL, network drop, non-2xx) so the circuit breaker
  // in captureAndUpload() can actually fire — it counts attempts, and
  // before this fix we only ever attempted once per boot, so the breaker
  // never reached its threshold even with a totally broken camera.
  if (!firstCaptureDone) {
    Serial.println("-- First capture after boot");
    if (captureAndUpload()) {
      firstCaptureDone = true;
    }
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

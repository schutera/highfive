#include "esp_camera.h"
#include "esp_wifi.h"
#include "esp_init.h"
#include "firmware_defaults.h" // hf::defaults::k*ProductionFallback (issue #66)
#include "form_query.h"        // hf::rewriteLegacyHighfiveUrl — issue #79
#include "led.h"
#include "module_id.h"
#include "module_name.h"       // hf::moduleNameFromMac — issue #92
#include "url.h"               // hf::parseUrl — scheme-aware TLS dispatch (#79)
#include "wifi_diag.h"
#include "breadcrumb.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <FS.h>
#include <SPIFFS.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include "tls_roots.h" // hf::tls::k{IsrgRootX1,GtsRootR1}Pem — issue #79


/* 
  pinouts defined based on the Arduino ESP CameraWebServer example
*/
#define CAMERA_MODEL_AI_THINKER // our ESP model

#if defined(CAMERA_MODEL_AI_THINKER)
#define PWDN_GPIO_NUM  32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  0
#define SIOD_GPIO_NUM  26
#define SIOC_GPIO_NUM  27

#define Y9_GPIO_NUM    35
#define Y8_GPIO_NUM    34
#define Y7_GPIO_NUM    39
#define Y6_GPIO_NUM    36
#define Y5_GPIO_NUM    21
#define Y4_GPIO_NUM    19
#define Y3_GPIO_NUM    18
#define Y2_GPIO_NUM    5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM  23
#define PCLK_GPIO_NUM  22
// On-board flash LED pin (`LED_PIN`) lives in `led.h` — single source of truth.
#else
#error "Pins not set for camera model"
#endif

/*
  POSIX timezone + NTP servers

  These are needed to set ESP local time after connecting to WiFi
*/
static const char* TZ_EU_CENTRAL = "CET-1CEST,M3.5.0,M10.5.0/3";
static const char* NTP1 = "pool.ntp.org";
static const char* NTP2 = "time.google.com";

/*
  camera types
*/
camera_config_t config;
sensor_t *sensor;
int initialized = 0;

/* global preferences functions */
Preferences preferences;

bool isESPConfigured() {
    preferences.begin("config", false);
    bool configured = preferences.getBool("configured", false);
    preferences.end();
    return configured;
}

void setESPConfigured(bool value) {
    preferences.begin("config", false);
    preferences.putBool("configured", value);
    preferences.end();
}

// NVS namespace "config", key "wifi_fails" (uint8). Renaming either side
// of this contract silently resets the counter and disables the AP-fallback
// — keep them in lockstep with esp_init.h's WIFI_FAIL_AP_FALLBACK_THRESH.
uint8_t getWifiFailCount() {
    preferences.begin("config", true);  // read-only
    uint8_t count = preferences.getUChar("wifi_fails", 0);
    preferences.end();
    return count;
}

void setWifiFailCount(uint8_t value) {
    preferences.begin("config", false);
    preferences.putUChar("wifi_fails", value);
    preferences.end();
}


/* -------------------------------- */
/* ---------- CAMERA SETUP ---------- */
/* -------------------------------- */
void configure_camera_sensor(esp_config_t *esp_config) {
  if (initialized) {
    sensor = esp_camera_sensor_get();

    sensor->set_vflip(sensor, esp_config->vertical_flip);                     // Flips the image vertically (some cameras mount upside-down)
    sensor->set_brightness(sensor, esp_config->brightness);           // Slightly increases brightness
    sensor->set_saturation(sensor, esp_config->saturation);           // Reduces color saturation (for less "washed-out" images)

    /* --- we can add more here --- */
    /* https://randomnerdtutorials.com/esp32-cam-ov2640-camera-settings/ */
  } else {
    Serial.println("---- Error when configuring camera sensor: Camera not initialized yet");
  }
}

void initEspCamera(framesize_t resolution) {
  // Loud diagnostic: print PSRAM state + camera-relevant settings up front so
  // we never have to guess what the runtime environment looks like.
  Serial.printf("-- PSRAM: found=%d size=%u bytes\n",
                (int)psramFound(),
                (unsigned)ESP.getPsramSize());

  // Explicit PWDN power-cycle on the OV2640 before init. The chip otherwise
  // inherits whatever power state it was in across a soft reset, and a
  // half-stuck sensor will respond to I2C config (init succeeds) but never
  // produce frames over the parallel data bus. This forces a clean cold-start.
  Serial.println("-- power-cycling camera via PWDN");
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);  // power off
  delay(50);
  digitalWrite(PWDN_GPIO_NUM, LOW);   // power on
  delay(50);

  config.frame_size = resolution;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  if (psramFound()) {
    config.jpeg_quality = 10;
    // Single buffer + GRAB_WHEN_EMPTY: camera captures one frame then waits.
    // GRAB_LATEST + fb_count=2 is for streaming — with infrequent captures
    // (boot + daily) the unused buffers overflow (FB-OVF) and the driver stalls.
    config.fb_count = 1;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  } else {
    // this is just a fallback... don't know if the psram will ever not be found
    Serial.println("---- PSRAM not found. Image quality will be reduced.");
    config.frame_size   = FRAMESIZE_VGA;
    config.jpeg_quality = 15;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }

  Serial.println("-- initializing ESP camera");
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    // Was `ESP.restart()` — but that produces reset_reason=SW on the
    // next boot, which `ESP32-CAM/ESP32-CAM.ino`'s
    // `forceRollbackIfPendingTooLong` deliberately ignores so transient
    // WiFi flakes (AP-fallback also uses SW) don't trip the rollback
    // threshold. The cost was that camera-init failures of a freshly
    // OTA'd slot also looked "clean" to the gate and would never
    // trigger rollback — module just reboot-loops with no recovery.
    // `abort()` runs the panic handler instead → reset_reason=PANIC →
    // the rollback counter sees this for what it is (a real failure of
    // this slot) and reverts to the previous slot after
    // HF_OTA_MAX_PENDING_BOOTS retries. Caught by senior-review of
    // PR-F #26. The 5 s delay + Serial.printf are preserved so the
    // operator-visible UX (error message + LED) is unchanged.
    Serial.printf("---- camera init failed: 0x%x. Aborting in 5s...\n", err);
    delay(5000);
    abort();
  } else {
    initialized = 1;
    Serial.println("---- camera initialized");
  }
}

// One-shot recovery: deinit + PWDN power-cycle + reinit. Called from setup()
// when the warm-up loop produces all-NULL frames despite a successful init.
// Same camera config — does not change quality or framesize.
void recoverCamera(framesize_t resolution) {
  Serial.println("[CAM] recovery: deinit + PWDN cycle + reinit");
  esp_camera_deinit();
  delay(200);
  digitalWrite(PWDN_GPIO_NUM, HIGH);
  delay(100);
  digitalWrite(PWDN_GPIO_NUM, LOW);
  delay(100);
  initialized = 0;
  initEspCamera(resolution);
}

/* -------------------------------- */
/* ---------- ESP SETUP ---------- */
/* -------------------------------- */
void initEspPinout() {
  Serial.println("-- configuring ESP pinout");
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  // LED pin (GPIO 4) is owned by ledInit() — already called from setup().
}

/* -------------------------------- */
/* ---------- WIFI SETUP ---------- */
/* -------------------------------- */
void setupTime() {
  /*
    Sets local time based on CEST from time servers (pool.ntp.org and time.google.com)
  */
  if (WiFi.status() == WL_CONNECTED) {
    configTzTime(TZ_EU_CENTRAL, NTP1, NTP2);

    // Issue #42 instrumentation: breadcrumb the NTP poll loop. The
    // 5 s outer cap means this is unlikely to be the WDT culprit, but
    // the breadcrumb costs nothing and rules it out cleanly.
    hf::breadcrumbSet("setupTime:ntp_poll");
    struct tm tmcheck;
    const uint32_t start = millis();
    while (!getLocalTime(&tmcheck, 500 /*ms timeout*/)) {
      if (millis() - start > 5000) {
        Serial.println("------ WARNING: NTP time sync timed out.");
        Serial.println("------ Could not sync time from NTP servers. Local time will be unavailable.");
        break;
      }
    }
  } else {
    Serial.println("------ WiFi not available, could not sync time from NTP servers. Local time will be unavailable.");
  }
}

void tuneWifiForLatency() {
  WiFi.setSleep(false);                    // Disable modem sleep (lowers jitter)
  esp_wifi_set_ps(WIFI_PS_NONE);           // Same idea at IDF level
  WiFi.setTxPower(WIFI_POWER_19_5dBm);     // Max TX power (if allowed)
}

// Auto-reconnect handler: triggers a full re-association (and DHCP renew)
// on any disconnect, including stale-lease and AP-rotation cases that
// WiFi.setAutoReconnect alone won't recover from.
static void onWifiEvent(WiFiEvent_t event) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    Serial.println("[WIFI] disconnected — reconnecting");
    WiFi.reconnect();
  } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.printf("[WIFI] (re)connected, IP: %s\n", WiFi.localIP().toString().c_str());
  }
}

void setupWifiConnection(wifi_configuration_t *wifi_config) {

  // Anyone with USB access (5 s with a serial monitor) used to walk away with
  // the WiFi password — the live-review demo of feat/onboarding-feedback put
  // it in chat transcripts. Redacted by default; rebuild with -DDEBUG_WIFI
  // when copy-paste corruption is the suspect.
#ifdef DEBUG_WIFI
  Serial.printf("connect to SSID: %s with pw: %s\n", wifi_config->SSID, wifi_config->PASSWORD);
#else
  Serial.printf("connect to SSID: %s (pw redacted; build with -DDEBUG_WIFI to log)\n",
                wifi_config->SSID);
#endif
  Serial.printf("SSID length: %d\n", strlen(wifi_config->SSID));
  Serial.printf("PW length: %d\n", strlen(wifi_config->PASSWORD));

  //tuneWifiForLatency();

  WiFi.disconnect();
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(true);
  WiFi.setAutoReconnect(true);
  WiFi.onEvent(onWifiEvent);
  WiFi.begin(wifi_config->SSID, wifi_config->PASSWORD);
  //WiFi.begin("Vodafone-CAKE", "tYsjat-gakke8-kephaw");
  Serial.printf("---- connecting to %s\n", wifi_config->SSID);
  ledSetMode(hf::LedMode::Connecting);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - wifiStart > 30000) {
      uint8_t fails = getWifiFailCount() + 1;
      setWifiFailCount(fails);
      Serial.printf("\n------ WiFi connection timed out after 30s "
                    "(SSID=%s, status=%s, fails=%u). Restarting...\n",
                    wifi_config->SSID, hf::wifiStatusName(WiFi.status()), fails);
      // Fire the "Failed" three-pulse pattern (~450 ms total) and hold
      // for ~1 s so the user reliably sees it before the reboot. Pattern
      // auto-completes; the LED is silent for the remainder of the hold.
      // Watchdog (60 s) is fed each iteration.
      ledSetMode(hf::LedMode::Failed);
      for (int i = 0; i < 10; ++i) {
        ledTick();
        esp_task_wdt_reset();
        delay(100);
      }
      ESP.restart();
    }
    ledTick();
    esp_task_wdt_reset();
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n---- Connected. IP: %s\n", WiFi.localIP().toString().c_str());
  // Successful join clears the AP-fallback counter and parks the LED on
  // the steady "Connected" pattern; uploads will overlay their own
  // single-flash on top of this.
  if (getWifiFailCount() != 0) setWifiFailCount(0);
  ledSetMode(hf::LedMode::Connected);

  setupTime();
}

/* ---------------------------------------- */
/* ---------- MODULE NAME GENERATOR ---------- */
/* ---------------------------------------- */
// The word lists and the byte-mixing logic live in lib/module_name/ so
// they are host-testable independent of the Arduino runtime — see
// ADR-002 and issue #92 (same-batch MAC collision incident). The
// wrapper here is the only place that touches ESP.getEfuseMac().
String generateModuleName() {
  uint64_t mac = ESP.getEfuseMac();
  return String(hf::moduleNameFromMac(reinterpret_cast<const uint8_t*>(&mac)).c_str());
}

/* -------------------------------- */
/* ---------- ESP CONFIG ---------- */
/* -------------------------------- */
framesize_t getResolutionFromString(String resolutionString) {
    resolutionString.toLowerCase();
    if (resolutionString == "qvga") { return FRAMESIZE_QVGA; }
    if (resolutionString == "vga") { return FRAMESIZE_VGA; }
    if (resolutionString == "svga") { return FRAMESIZE_SVGA; }
    if (resolutionString == "sxga") { return FRAMESIZE_SXGA; }
    if (resolutionString == "uxga") { return FRAMESIZE_UXGA; }

    /* fallback */
    Serial.printf("------ Resolution '%s' is not supported. Using Default resolution VGA.\n",
                  resolutionString.c_str());
    return FRAMESIZE_VGA;
}

bool loadConfig(esp_config_t *esp_config) {

  // ---- setting unique ID (esp mac address) ---- //
  esp_config->esp_ID = ESP.getEfuseMac();
  Serial.printf("------ ESP module identifier: %llu\n",
                (unsigned long long)esp_config->esp_ID);

  // ---- set initial battery level ---- //
  esp_config->battery_level = 90;
  esp_config->email[0] = '\0';

  /* DEFAULTS — production fallbacks for the "no config file at all" path.
     Same named constants are reused below as the `|` fallbacks for the
     "config file present but key missing" path, so both paths produce the
     same value per field. See lib/firmware_defaults/firmware_defaults.h. */
  esp_config->RESOLUTION    = static_cast<framesize_t>(hf::defaults::kResolutionProductionFallback);
  esp_config->vertical_flip = hf::defaults::kVerticalFlipProductionFallback;
  esp_config->brightness    = hf::defaults::kBrightnessProductionFallback;
  esp_config->saturation    = hf::defaults::kSaturationProductionFallback;

  esp_config->geolocation.latitude  = 0.0f;
  esp_config->geolocation.longitude = 0.0f;
  esp_config->geolocation.accuracy  = 0.0f;

  if (!SPIFFS.begin(true)) {
    Serial.println("-- SPIFFS mount failed");
    return false;
  }


  File file = SPIFFS.open(esp_config->CONFIG_FILE, "r");
  if (!file) {
    Serial.printf("%s not found\n", esp_config->CONFIG_FILE);
    return false;
  }

  StaticJsonDocument<1024> esp_config_doc;
  DeserializationError err = deserializeJson(esp_config_doc, file);
  file.close();
  if (err) {
    Serial.println("JSON parse error");
    return false;
  }

  // SPIFFS-first read for MODULE_NAME so the operator's captive-portal
  // choice survives reboots (issue #91 — the read was missing entirely,
  // so every boot overwrote the saved name with a fresh auto-generated
  // one). Auto-generation is the fallback for first boot / cleared
  // config. Saved by host.cpp::saveConfig at the same JSON key path.
  const char* savedModuleName = esp_config_doc["NETWORK"]["MODULE_NAME"] | "";
  if (strlen(savedModuleName) > 0) {
    strlcpy(esp_config->module_name, savedModuleName, sizeof(esp_config->module_name));
    Serial.printf("------ Loaded module name from SPIFFS: %s\n", esp_config->module_name);
  } else {
    String autoName = generateModuleName();
    strlcpy(esp_config->module_name, autoName.c_str(), sizeof(esp_config->module_name));
    Serial.printf("------ Auto-generated module name: %s\n", esp_config->module_name);
  }

  strlcpy(
    esp_config->wifi_config.SSID,
    esp_config_doc["NETWORK"]["SSID"] | "",
    sizeof(esp_config->wifi_config.SSID)
  );
  strlcpy(
    esp_config->wifi_config.PASSWORD,
    esp_config_doc["NETWORK"]["PASSWORD"] | "",
    sizeof(esp_config->wifi_config.PASSWORD)
  );
  // Pre-#79 modules baked `http://highfive.schutera.com/*` into
  // SPIFFS. The first boot after the #79 OTA migrates the SPIFFS
  // values to `https://` so all downstream call sites speak TLS
  // against the same origin Mark's nginx already serves over 443.
  // Idempotent: the helper is a no-op on a fresh https:// config,
  // and the SPIFFS re-save below only fires if the value actually
  // changed. See hf::rewriteLegacyHighfiveUrl in lib/form_query/
  // for the exact prefix-match rule.
  std::string uploadFromDisk = (const char*)(esp_config_doc["NETWORK"]["UPLOAD_URL"] | "");
  std::string initFromDisk   = (const char*)(esp_config_doc["NETWORK"]["INIT_URL"]   | "");
  const std::string uploadMigrated = hf::rewriteLegacyHighfiveUrl(uploadFromDisk);
  const std::string initMigrated   = hf::rewriteLegacyHighfiveUrl(initFromDisk);
  const bool urlMigrated =
      (uploadMigrated != uploadFromDisk) || (initMigrated != initFromDisk);

  strlcpy(esp_config->UPLOAD_URL, uploadMigrated.c_str(), sizeof(esp_config->UPLOAD_URL));
  strlcpy(esp_config->INIT_URL,   initMigrated.c_str(),   sizeof(esp_config->INIT_URL));
  strlcpy(
    esp_config->email,
    esp_config_doc["NETWORK"]["EMAIL"] | "",
    sizeof(esp_config->email)
  );

  //Serial.printf("SSID: %s\n", esp_config->wifi_config.SSID);
  //Serial.printf("PASSWORD: %s\n", esp_config->wifi_config.PASSWORD);

  // RESOLUTION uses an enum on the production side and a string in SPIFFS,
  // so the `| <fallback>` shorthand the other camera fields use isn't a
  // clean fit (the conversion fn would have to accept the string fallback
  // and produce a different enum than the no-JSON-at-all path uses). Branch
  // on key presence so missing-key reads land on the same production
  // fallback the default-init block applies — see firmware_defaults.h.
  if (esp_config_doc["CAMERA"].containsKey("RESOLUTION")) {
    esp_config->RESOLUTION = getResolutionFromString(esp_config_doc["CAMERA"]["RESOLUTION"]);
  } else {
    esp_config->RESOLUTION = static_cast<framesize_t>(hf::defaults::kResolutionProductionFallback);
  }

  // Missing-key fallbacks for the three integer camera fields. Without the
  // `|` ArduinoJson silently returns 0 for a missing key, which would
  // overwrite the production fallback set in the default-init block above
  // — exactly the dual-reader-asymmetry trap chapter-11 warned about.
  esp_config->vertical_flip = esp_config_doc["CAMERA"]["VERTICAL_FLIP"] | hf::defaults::kVerticalFlipProductionFallback;
  esp_config->brightness    = esp_config_doc["CAMERA"]["BRIGHTNESS"]    | hf::defaults::kBrightnessProductionFallback;
  esp_config->saturation    = esp_config_doc["CAMERA"]["SATURATION"]    | hf::defaults::kSaturationProductionFallback;
  
  if (strlen(esp_config->wifi_config.SSID) == 0) {
    Serial.println("------ Could not read SSID from config file.");
    return false;
  } else if (strlen(esp_config->wifi_config.PASSWORD) == 0) {
    Serial.println("------ Could not read PASSWORD from config file.");
    return false;
  } else if (strlen(esp_config->UPLOAD_URL) == 0) {
    Serial.println("------ Could not read UPLOAD_URL from config file.");
    return false;
  } else if (strlen(esp_config->INIT_URL) == 0) {
    Serial.println("------ Could not read INIT_URL from config file.");
    return false;
  }

  // Persist the URL migration to SPIFFS once. We do this AFTER the
  // strlen checks above so a malformed config (missing SSID etc.)
  // is not silently overwritten with a partial-migration state. The
  // saveConfig in host.cpp uses the same StaticJsonDocument<1024>
  // shape; we mutate the already-loaded doc in-place rather than
  // re-reading from disk so a brief power-loss between read and
  // write doesn't corrupt the config.
  if (urlMigrated) {
    Serial.println("------ loadConfig: migrating saved URLs to https:// (issue #79)");
    esp_config_doc["NETWORK"]["UPLOAD_URL"] = uploadMigrated;
    esp_config_doc["NETWORK"]["INIT_URL"]   = initMigrated;
    File out = SPIFFS.open(esp_config->CONFIG_FILE, "w");
    if (out) {
      const size_t bytesWritten = serializeJson(esp_config_doc, out);
      out.close();
      if (bytesWritten == 0) {
        // Truncation gate, same shape as host.cpp::saveConfig — see #19.
        // The file has already been truncated to zero by SPIFFS.open("w");
        // we cannot un-truncate. Without intervention the next boot would
        // call this `loadConfig`, hit the JSON parse error on the empty
        // file, return false, and the setup path would take roughly
        // `WIFI_FAIL_AP_FALLBACK_THRESH` failed WiFi joins (~3 boots,
        // each ~30 s) before flipping `setESPConfigured(false)` and
        // opening the captive portal. To collapse that latency to a
        // single reboot, we clear the configured flag ourselves here:
        // the captive portal will open on the very next boot. RAM-side
        // `esp_config` retains the migrated values for this boot so the
        // current run still talks to the right URLs over TLS.
        Serial.println("------ loadConfig: serializeJson wrote 0 bytes — clearing NVS configured flag so captive portal opens on next boot");
        setESPConfigured(false);
      }
    } else {
      Serial.println("------ loadConfig: failed to open config.json for migration re-save");
    }
  }
  return true;
}


// GEOLOCATION (uses Google Geolocation API and stores latitdue and longitude)
void getGeolocation(esp_config_t *esp_config) {

  // GEO_API_KEY is injected at build time by extra_scripts.py (PlatformIO)
  // or build.sh (arduino-cli). Fallback to empty string so raw Arduino IDE
  // builds compile; the runtime guard below makes the missing-key case
  // observable instead of producing a broken HTTPS request to Google.
  #ifndef GEO_API_KEY
  #define GEO_API_KEY ""
  #endif
  const char* apiKey = GEO_API_KEY;

  if (apiKey[0] == '\0') {
    Serial.println("getGeolocation: GEO_API_KEY not set at build time — skipping geolocation lookup.");
    return;
  }

  // Issue #42 instrumentation: breadcrumb each blocking call inside
  // getGeolocation. The HTTPClient calls below have NO explicit
  // setTimeout(), so a slow Google response can block past the 60 s
  // TASK_WDT budget undetected. If the WDT fires, the next boot's
  // last_stage_before_reboot field will name the section.
  hf::breadcrumbSet("getGeolocation:wifi_scan");
  // Scan WiFi networks
  int n = WiFi.scanNetworks();
  Serial.println("Scan complete");

  if (n <= 0) {
    Serial.println("No networks found");
    return;
  }

  DynamicJsonDocument doc(4096);

  JsonArray wifiArray = doc.createNestedArray("wifiAccessPoints");

  for (int i = 0; i < min(n, 7); i++) {  // send up to 7 networks
    JsonObject wifiObj = wifiArray.createNestedObject();
    wifiObj["macAddress"] = WiFi.BSSIDstr(i);
    wifiObj["signalStrength"] = WiFi.RSSI(i);
  }

  String requestBody;
  serializeJson(doc, requestBody);

  // Verified TLS to googleapis.com. Pin against GTS Root R1 (the
  // self-signed Google trust anchor; chain on the wire today is
  // googleapis.com -> WR2 -> GTS Root R1). Without setCACert the
  // HTTPClient would still negotiate TLS but skip peer verification,
  // which leaks the WiFi-BSSID list to any MITM with a self-signed
  // cert. Issue #79.
  WiFiClientSecure secureClient;
  secureClient.setCACert(hf::tls::kGtsRootR1Pem);

  HTTPClient http;
  String url = String("https://www.googleapis.com/geolocation/v1/geolocate?key=") + apiKey;
  http.begin(secureClient, url);
  http.addHeader("Content-Type", "application/json");

  hf::breadcrumbSet("getGeolocation:http_post");
  int httpResponseCode = http.POST(requestBody);

  if (httpResponseCode > 0) {

    hf::breadcrumbSet("getGeolocation:get_string");
    String response = http.getString();
    //Serial.println("Response:");
    //Serial.println(response);

    DynamicJsonDocument responseDoc(2048);
    DeserializationError error = deserializeJson(responseDoc, response);

    if (!error) {
      esp_config->geolocation.latitude = responseDoc["location"]["lat"];
      esp_config->geolocation.longitude = responseDoc["location"]["lng"];
      esp_config->geolocation.accuracy = responseDoc["accuracy"];
    } else {
      Serial.println("failed to parse JSON to get the geolocation.");
    }

  } else {
    Serial.print("HTTP Error: ");
    Serial.println(httpResponseCode);
  }

  http.end();
}


/* INIT NEW MODULE ON SERVER */
void initNewModuleOnServer(esp_config_t *esp_config) {
  if (WiFi.status() == WL_CONNECTED) {
    // Scheme-aware client dispatch (issue #79). HTTPClient::begin(client, url)
    // uses whatever client you pass it — it does NOT auto-select based on
    // the URL scheme. So we parse the scheme ourselves and hold a reference
    // to either a WiFiClientSecure (pinned to ISRG Root X1) or a plain
    // WiFiClient. LAN-dev INIT_URLs (`http://10.0.0.5:8002/...`) need the
    // plain branch because duckdb-service doesn't terminate TLS. Same
    // pattern as `ota.cpp`'s `httpOtaCheckAndApply` and the heartbeat /
    // upload paths in `client.cpp`. Both storage objects must outlive
    // `http.end()` since HTTPClient stores `_client = &client`.
    hf::Url parsed = hf::parseUrl(std::string(esp_config->INIT_URL));
    const bool useTls = (parsed.scheme == "https");
    WiFiClientSecure tlsClient;
    WiFiClient plainClient;
    WiFiClient& netClient = useTls ? static_cast<WiFiClient&>(tlsClient)
                                   : plainClient;
    if (useTls) {
      tlsClient.setCACert(hf::tls::kIsrgRootX1Pem);
    }

    HTTPClient http;

    Serial.printf("------ MODULE NAME: %s\n", esp_config->module_name);

    http.begin(netClient, esp_config->INIT_URL);
    //http.begin("http://192.168.0.36:8002/new_module");
    http.addHeader("Content-Type", "application/json");

    // Canonical 12-char lowercase-hex module ID (same as /upload + /heartbeat).
    // Stringifying the uint64_t directly emitted a decimal that the
    // duckdb-service ModuleId validator rejects with HTTP 400. See issue #39.
    String macStr = String(hf::formatModuleId(esp_config->esp_ID).c_str());

    StaticJsonDocument<256> doc;
    doc["esp_id"] = macStr;
    doc["module_name"] = esp_config->module_name;
    doc["latitude"] = String(esp_config->geolocation.latitude);
    doc["longitude"] = String(esp_config->geolocation.longitude);
    doc["battery_level"] = String(esp_config->battery_level);
    if (strlen(esp_config->email) > 0) {
      doc["email"] = esp_config->email;
    }


    String jsonData;
    serializeJson(doc, jsonData);

    // Issue #42 instrumentation: same shape as getGeolocation —
    // HTTPClient with no explicit setTimeout, prime suspect for the
    // first-boot TASK_WDT reboot the issue describes.
    hf::breadcrumbSet("initNewModuleOnServer:http_post");
    int httpResponseCode = http.POST(jsonData);
    hf::breadcrumbSet("initNewModuleOnServer:get_string");
    String response = http.getString();
    if (httpResponseCode > 0) {
      Serial.println("Response: " + response);
    } else {
      Serial.println("[initNewoduleOnServer] Error on sending POST: " + String(httpResponseCode));
      Serial.println("Response: " + response);
    }

    http.end();
  }
}

/*
 * Boot counter — survives reboots via NVS. Incremented each boot in
 * setup(); the returned value is logged into the telemetry ring buffer
 * so a "stuck in boot loop" pattern shows up in the admin sidecar logs.
 */
uint32_t incrementBootCount() {
  preferences.begin("telemetry", false);
  uint32_t count = preferences.getUInt("boot_count", 0) + 1;
  preferences.putUInt("boot_count", count);
  preferences.end();
  return count;
}

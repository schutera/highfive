#include "esp_camera.h"
#include "esp_init.h"
#include "host.h"
#include "client.h"
#include "led.h"
#include "logbuf.h"
#include "breadcrumb.h"
#include <Arduino.h>
#include <SPIFFS.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>


#define HEARTBEAT_INTERVAL_MS (60UL * 60UL * 1000UL)  // 1 hour
#define DAILY_REBOOT_MS       (24UL * 3600UL * 1000UL)
// Watchdog timeout: budget = capture+upload+heartbeat (~10–25 s under
// retries) + 30 s sleep at end of loop = up to ~55 s between feeds in
// the worst case. 60 s gives a safety margin while still rebooting on
// genuine deadlocks within ~1 minute.
#define TASK_WDT_TIMEOUT_S    60
// FACTORY_RESET_SETTLE_MS and WIFI_FAIL_AP_FALLBACK_THRESH live in
// esp_init.h alongside the NVS helpers they gate on.

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

  // Read+clear the previous boot's breadcrumb FIRST, before any
  // breadcrumbSet in this boot can clobber the slot. logbuf isn't
  // initialised yet (the in-RAM ring doesn't exist), so buffer the
  // recovered value into a local and emit the [BOOT] log line a few
  // statements down once logbufInit() has run.
  char recoveredCrumb[64] = {0};
  bool hadRecoveredCrumb =
      hf::breadcrumbReadAndClear(recoveredCrumb, sizeof(recoveredCrumb));

  pinMode(CONFIG_BUTTON, INPUT_PULLUP);

  // Issue #42: SPIFFS.begin(true) auto-formats on a corrupted partition,
  // which can run for several seconds with no esp_task_wdt_reset. Set
  // the breadcrumb just before the call so a TASK_WDT here is
  // identifiable on the next boot — note the read+clear above ran
  // before this set, preserving the previous boot's last value.
  hf::breadcrumbSet("setup:spiffs_mount");
  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS Mount Failed");
    return;
  }

  Serial.setDebugOutput(true);
  Serial.println();
  delay(200);

  // Bring the on-board LED up early so every subsequent state change
  // (AP mode, WiFi connecting, failure) is reflected to the user.
  ledInit();

  // Telemetry: ring buffer + boot marker with reset reason
  logbufInit();
  uint32_t boot_count = incrementBootCount();
  logf("[BOOT] fw=%s reset_reason=%d boot_count=%u free_heap=%u",
       FIRMWARE_VERSION, (int)esp_reset_reason(), boot_count, ESP.getFreeHeap());

  // Surface the recovered breadcrumb (read at the very top of setup()
  // before any breadcrumbSet could overwrite it). A non-empty value
  // here means the previous boot did not exit setup() cleanly and the
  // breadcrumb survived a software reset (TASK_WDT, panic,
  // ESP.restart()). Issue #42 — the only way to identify which
  // long-running call was active when the watchdog fired in the field.
  // POR clears RTC slow memory, so first-boot-after-power-on always
  // returns false. Magic-guarded; 1-in-4-billion false-positive on POR.
  if (hadRecoveredCrumb) {
    logf("[BOOT] last_stage_before_reboot=%s", recoveredCrumb);
    noteLastStageBeforeReboot(recoveredCrumb);
  }

  // Task watchdog — if loop() (or AP server) hangs for >TASK_WDT_TIMEOUT_S,
  // reboot. host.cpp's runAccessPoint() also feeds it; loop() resets at top.
  esp_task_wdt_init(TASK_WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  Serial.println("------ ESP STARTED ------");

  strlcpy(esp_config.CONFIG_FILE, CONFIG_FILE_PATH, sizeof(esp_config.CONFIG_FILE));

  // Note: an earlier "hold IO0 for 5 s at boot to factory-reset" path used
  // to live here. It was unreachable on AI Thinker ESP32-CAM-MB because
  // GPIO0 is a strap pin — the ROM samples it at the moment EN releases,
  // so holding it LOW enters UART download mode and this firmware never
  // runs. Removed in #40. The supported reset paths are:
  //   1. The 3-WiFi-fail auto-fallback below (re-opens AP).
  //   2. POST /factory_reset on the captive portal (host.cpp).
  //   3. `pio run -t erase` over a serial cable.
  // See docs/troubleshooting.md "Factory reset" for details.

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
    ledSetMode(hf::LedMode::ApMode);
    setupAccessPoint();
  } else {
    // Auto-fallback: if previous boots have repeatedly failed to join the
    // saved network, clear the configured flag so the next boot re-opens
    // the captive portal. Same NVS mutation as POST /factory_reset on the
    // captive portal; this path triggers automatically without user input.
    uint8_t wifiFails = getWifiFailCount();
    if (wifiFails >= WIFI_FAIL_AP_FALLBACK_THRESH) {
      Serial.printf("-- %u consecutive WiFi join failures — re-entering AP mode\n",
                    (unsigned)wifiFails);
      setWifiFailCount(0);
      setESPConfigured(false);
      delay(FACTORY_RESET_SETTLE_MS);
      ESP.restart();
    }
    Serial.println("-- ESP already configured. To reconfigure:");
    Serial.println("   (1) Cause 3 consecutive WiFi-join failures (e.g. save wrong credentials) — board auto-reopens AP at http://192.168.4.1.");
    Serial.println("   (2) Once at the captive portal, expand 'Factory reset (advanced)' and submit.");
    Serial.println("   (3) Or via serial cable: cd ESP32-CAM && pio run -t erase && pio run -t upload");
  }

  Serial.println("[ESP] INITIALIZING ESP");

  // SPIFFS auto-format on a corrupted partition can run for several
  // seconds with no esp_task_wdt_reset in the loop, so it deserves its
  // own crumb even though it's a local FS call rather than a network
  // call. loadConfig also re-enters SPIFFS.begin internally.
  hf::breadcrumbSet("setup:loadConfig");
  unsigned long stageStartMs = millis();
  if (!loadConfig(&esp_config)) {
    Serial.println("-- Failed to configure ESP");
  }
  logf("[STAGE] loadConfig took=%lums", millis() - stageStartMs);

  /*
    WiFi + network operations BEFORE camera init.
    Camera and WiFi share DMA channels / PSRAM on ESP32 —
    initializing the camera first and then doing heavy RF work
    corrupts the camera's DMA buffers, causing esp_camera_fb_get() to return NULL.
  */
  initEspPinout();

  Serial.printf("[ESP] CONFIGURING WIFI CONNECTION TO %s\n", esp_config.wifi_config.SSID);
  // Issue #42 instrumentation: a breadcrumb per long-running setup
  // stage. If the watchdog fires inside one of these, the next boot's
  // [BOOT] line plus the telemetry sidecar's "last_stage_before_reboot"
  // field will name the offending stage. The exit-with-duration `logf`
  // line is also useful when WDT *doesn't* fire — surfaces stages
  // creeping toward the 60 s budget.
  hf::breadcrumbSet("setup:setupWifiConnection");
  stageStartMs = millis();
  setupWifiConnection(&esp_config.wifi_config);
  logf("[STAGE] setupWifiConnection took=%lums", millis() - stageStartMs);

  hf::breadcrumbSet("setup:getGeolocation");
  stageStartMs = millis();
  getGeolocation(&esp_config);
  logf("[STAGE] getGeolocation took=%lums", millis() - stageStartMs);

  Serial.print("Latitude: ");
  Serial.println(esp_config.geolocation.latitude, 6);

  Serial.print("Longitude: ");
  Serial.println(esp_config.geolocation.longitude, 6);

  Serial.print("Accuracy (m): ");
  Serial.println(esp_config.geolocation.accuracy);

  // ---- Initialize new module on server ---- //
  hf::breadcrumbSet("setup:initNewModuleOnServer");
  stageStartMs = millis();
  initNewModuleOnServer(&esp_config);
  logf("[STAGE] initNewModuleOnServer took=%lums", millis() - stageStartMs);

  /*
    Camera init AFTER all WiFi/network operations to avoid DMA conflicts
  */
  Serial.println("[ESP] INITIALIZING CAMERA");
  hf::breadcrumbSet("setup:initEspCamera");
  stageStartMs = millis();
  initEspCamera(esp_config.RESOLUTION);
  configure_camera_sensor(&esp_config);
  logf("[STAGE] initEspCamera took=%lums", millis() - stageStartMs);

  // Warm up: sensor needs a few frames to auto-expose before producing valid JPEGs
  Serial.println("-- warming up camera sensor");
  // Track NULL frames during warm-up so we can attempt one round of
  // recovery (deinit + PWDN cycle + reinit) before giving up. Same camera
  // config — quality unchanged.
  int warmupNulls = 0;
  for (int i = 0; i < 3; i++) {
    delay(500);
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) {
      size_t fb_len = fb->len;
      esp_camera_fb_return(fb);
      Serial.printf("---- warm-up frame %d OK (%u bytes)\n", i + 1, (unsigned)fb_len);
    } else {
      Serial.printf("---- warm-up frame %d skipped (NULL)\n", i + 1);
      warmupNulls++;
    }
  }

  if (warmupNulls == 3) {
    Serial.println("[CAM] all 3 warm-up frames NULL — attempting one recovery cycle");
    recoverCamera(esp_config.RESOLUTION);
    int recovNulls = 0;
    for (int i = 0; i < 3; i++) {
      delay(500);
      camera_fb_t *fb = esp_camera_fb_get();
      if (fb) {
        size_t fb_len = fb->len;
        esp_camera_fb_return(fb);
        Serial.printf("---- post-recovery frame %d OK (%u bytes)\n", i + 1, (unsigned)fb_len);
      } else {
        Serial.printf("---- post-recovery frame %d skipped (NULL)\n", i + 1);
        recovNulls++;
      }
    }
    if (recovNulls == 3) {
      Serial.println("[CAM] recovery did not help — sensor is likely hardware-faulty");
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

  // Clear the breadcrumb on clean exit from setup(). loop() will set
  // its own per-iteration breadcrumb. If the WDT fires inside setup()
  // we never reach this line and the breadcrumb survives the reboot.
  hf::breadcrumbClear();

  Serial.println("");
  Serial.println("---------------------");
  Serial.println("");
  Serial.println("STARTING CAMERA STREAM");
}


bool captureAndUpload() {
  Serial.println("");
  Serial.printf("-- Trying to capture and post image number %d\n", counter++);

  // Single 50 ms pulse on entry so the operator can see the board is
  // alive between long sleep intervals. Connected is silent; without
  // this pulse the board would emit no visible signal whatsoever.
  ledSetMode(hf::LedMode::Uploading);

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

  // Back to the silent Connected steady-state. Even on upload failure
  // WiFi itself is still up (a non-2xx is an application failure; the
  // circuit breaker above handles repeated failures by rebooting).
  ledSetMode(hf::LedMode::Connected);

  Serial.printf("-- Finished capturing and posting image %d\n", counter);
  return uploadOk;
}

void loop() {
  // Feed the task watchdog. If the loop hangs for >TASK_WDT_TIMEOUT_S,
  // the watchdog fires and reboots the device.
  esp_task_wdt_reset();
  ledTick();

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
    hf::breadcrumbSet("loop:sendHeartbeat");
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
    hf::breadcrumbSet("loop:captureAndUpload:first");
    if (captureAndUpload()) {
      firstCaptureDone = true;
    }
  }

  // Daily capture at noon (local time via NTP)
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 200)) {
    if (timeinfo.tm_hour == 12 && timeinfo.tm_yday != lastCaptureDay) {
      Serial.println("-- Noon capture");
      hf::breadcrumbSet("loop:captureAndUpload:noon");
      captureAndUpload();
      lastCaptureDay = timeinfo.tm_yday;
    }
  }

  // Feed the watchdog one more time before the long sleep so the 30 s
  // delay starts the timer fresh. Combined with TASK_WDT_TIMEOUT_S=60,
  // this guarantees the next loop iteration's work has at least 30 s
  // of slack before the watchdog can fire.
  // Set "loop:sleep" so a stuck delay() (impossible in practice but
  // included for completeness) is identifiable post-reboot.
  hf::breadcrumbSet("loop:sleep");
  esp_task_wdt_reset();
  delay(30000);  // check every 30 seconds
}

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

// FIRMWARE_SEQUENCE (#83) is normally injected from ESP32-CAM/SEQUENCE
// via the same two paths as FIRMWARE_VERSION above. The `0` fallback
// fires for raw Arduino IDE builds that go through neither path. Zero
// is the dev-build sentinel: `hf::shouldOtaUpdate` carries an
// explicit `current_sequence == 0 → refuse` guard so a hand-compiled
// binary cannot auto-OTA to a properly-built fleet release. (Without
// that guard, `manifest.sequence (1) > current_sequence (0)` would
// evaluate true and the dev binary would silently overwrite itself.)
// The right answer for "this binary was hand-compiled without
// provenance" is to require an explicit USB reflash before OTA
// participation. Pinned by
// `test_should_update_refuses_when_current_sequence_is_zero` in
// `ESP32-CAM/test/test_native_ota_version/test_ota_version.cpp`.
#ifndef FIRMWARE_SEQUENCE
#define FIRMWARE_SEQUENCE 0
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
// getGeolocation: 3-attempt retry at boot (PR II / issue #89). Returns
// true if the resulting fix is plausible (`hf::isPlausibleFix` over
// the populated esp_config->geolocation fields). False means the
// retry loop exhausted itself; caller can treat this as "no fix this
// boot, defer to heartbeat-side recovery".
bool getGeolocation(esp_config_t *esp_config);
void initNewModuleOnServer(esp_config_t *esp_config);

// Heartbeat-side geolocation recovery (PR II / issue #89). loop()
// schedules retries every HF_GEOLOCATION_DEFERRED_RETRY_MS while the
// boot fix is missing; on success the next heartbeat carries the
// fix to the server. Sendable-by-heartbeat state lives in
// `esp_init.cpp` as file-local globals; this set of accessors is the
// only API the heartbeat path needs.
//
// The peek/commit split (round-1 senior-review P1): a transient
// heartbeat POST failure used to lose the recovered fix entirely
// (consume-on-build cleared the flag before the POST landed). The
// new contract is "peek to build body, commit only after POST
// returns 2xx" — so a server outage just means the same fix rides
// the next heartbeat, and we don't fall back to a 24-h daily-reboot
// recovery latency on a 5-minute server hiccup.
bool hasPendingGeolocationFixToReport();
geolocation_t peekPendingGeolocationFixForHeartbeat();
void commitPendingGeolocationFixReported();
void markGeolocationFixNeedsRetry();
void tickGeolocationDeferredRetry(esp_config_t *esp_config);

// Retry cadence for the deferred-fix path. 30 minutes — long enough
// that we're not spamming Google's API on a captive-portal failure,
// short enough that the operator sees the module on the map within
// an hour of normal connectivity returning. Public so the loop()
// site in ESP32-CAM.ino can reuse it for breadcrumb labelling.
#define HF_GEOLOCATION_DEFERRED_RETRY_MS (30UL * 60UL * 1000UL)

/* Telemetry: reset-reason + boot count persistence + WiFi recovery */
uint32_t incrementBootCount();
bool reconnectWifi(wifi_configuration_t *wifi_config);

#endif
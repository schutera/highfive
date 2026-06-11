#include "esp_camera.h"
#include "esp_init.h"
#include "host.h"
#include "client.h"
#include "led.h"
#include "logbuf.h"
#include "breadcrumb.h"
#include "module_id.h"
#include "loop_health.h"
#include "ota_rollback.h"
#include "ota.h"
#include <Arduino.h>
#include <ArduinoOTA.h>
#include <SPIFFS.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <esp_ota_ops.h>


// Heartbeat cadence + retry-backoff and the WiFi-down reboot threshold now
// live in lib/loop_health (hf::kHeartbeatIntervalMs / kHeartbeatRetryMs /
// kWifiDownRebootMs) so the scheduling logic is host-testable (#149).
#define DAILY_REBOOT_MS       (24UL * 3600UL * 1000UL)
// Watchdog timeout: budget = capture+upload+heartbeat (~10–25 s under
// retries) + 30 s sleep at end of loop = up to ~55 s between feeds in
// the worst case. 60 s gives a safety margin while still rebooting on
// genuine deadlocks within ~1 minute.
//
// The 60 s floor was earned: raised from 30 s in commit ea7dc73 (PR-17
// review critical) after a deployed module reset-looped under degraded
// WiFi. The static_assert below makes "lower this to make local tests
// snappier" produce a build error instead of a field outage. ADR-007
// has the full rationale.
#define TASK_WDT_TIMEOUT_S    60
static_assert(TASK_WDT_TIMEOUT_S >= 60,
              "TASK_WDT_TIMEOUT_S must be >= 60 s — see ADR-007 and "
              "commit ea7dc73. Lowering this without re-running the "
              "worst-case captureAndUpload+heartbeat scenario is the "
              "regression that incident closed.");
// Max consecutive boots a slot can stay in ESP_OTA_IMG_PENDING_VERIFY
// before this firmware forces an app-side rollback. See
// `forceRollbackIfPendingTooLong()` below and the comment that calls
// it in setup() for the design context.
#define HF_OTA_MAX_PENDING_BOOTS 3
// Max consecutive boots a freshly-OTA'd ("unproven") slot may run WITHOUT ever
// making successful server contact before this firmware reverts it (#148
// Phase 3). The liveness watchdog reboots a mute slot every ~2 h, so 3 ≈ 6–8 h
// of total silence before rollback — long enough that a transient outage is an
// unlikely cause, short enough to self-heal a genuinely broken push same-day.
// Only ever consulted while the "unproven" flag is set, so a proven/factory
// slot is immune (see lib/ota_rollback and ADR-008 invariant #3).
#define HF_OTA_MAX_NOCONTACT_BOOTS 3
// FACTORY_RESET_SETTLE_MS and WIFI_FAIL_AP_FALLBACK_THRESH live in
// esp_init.h alongside the NVS helpers they gate on.

const char *CONFIG_FILE_PATH = "/config.json";
esp_config_t esp_config;
int counter = 0;
bool firstCaptureDone = false;
int lastCaptureDay = -1;
// Heartbeat retry scheduler + WiFi-health reboot watchdog (#149). Both hold
// only the small amount of timing state the loop()-health decisions need;
// the pure logic lives in lib/loop_health and is native-tested.
hf::HeartbeatScheduler hbScheduler;
hf::WifiHealthMonitor wifiHealth;
// Liveness self-heal watchdog (#148 Phase 3): reboots the module if NO server
// contact (2xx heartbeat or 2xx upload) succeeds for kNoContactRebootMs (2 h).
// Catches the "WiFi up, loop alive, but every call silently hangs/fails"
// zombie that wifiHealth (WiFi-down only) and the upload breaker (failed
// uploads only) both miss. Pure logic in lib/loop_health, native-tested.
hf::LivenessMonitor livenessMon;

// App-side OTA rollback (#26 / manual T4, extended for #148 Phase 3). Required
// because arduino-esp32's prebuilt bootloader does NOT enable
// CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE — without this app-side check a bad slot
// would reboot forever. Two NVS-backed rollback triggers, both reverting via
// esp_ota_mark_app_invalid_rollback_and_reboot():
//   pv_boots — consecutive faulty (panic/WDT/brownout) reboots (#26)
//   nc_boots — consecutive boots of an UNPROVEN (freshly-OTA'd) slot that never
//              made server contact (#148; never increments for a proven slot)
// Decision logic is the pure, native-tested state machine in lib/ota_rollback;
// this function is the NVS + esp_ota glue around it.
static void forceRollbackIfPendingTooLong() {
  // Why not gate on esp_ota_get_state_partition(): manual T4 showed it does not
  // work here — arduino-esp32's prebuilt loader leaves the ROM `app_state`
  // field untouched and can leave a newly-flashed slot reporting
  // ESP_OTA_IMG_VALID immediately, so a "return early if VALID" check silently
  // skips every bricked OTA. Hence the state-free counter design above.
  //
  // Reset-reason gate (load-bearing — ADR-008 invariant #1): count only boots
  // whose previous run died ungracefully (PANIC/TASK_WDT/INT_WDT/BROWNOUT).
  // Clean reboots (POWERON, EXT, SW, DEEPSLEEP) do NOT increment pv_boots — the
  // AP-fallback / WiFi-join-timeout and the liveness/WiFi-health watchdogs all
  // use ESP.restart() (reset_reason=SW), so e.g. three transient WiFi outages
  // (WIFI_FAIL_AP_FALLBACK_THRESH) can't trip the faulty counter. Collision
  // caught by senior-review before the #26 merge; see chapter-11.
  esp_reset_reason_t rr = esp_reset_reason();
  const bool faulty = (rr == ESP_RST_PANIC) || (rr == ESP_RST_TASK_WDT) ||
                      (rr == ESP_RST_INT_WDT) || (rr == ESP_RST_WDT) ||
                      (rr == ESP_RST_BROWNOUT);

  hf::OtaGateState st;
  Preferences p;
  p.begin("ota", false);
  st.unproven = p.getUChar("unproven", 0) != 0;
  st.pvBoots  = p.getUInt("pv_boots", 0);
  st.ncBoots  = p.getUInt("nc_boots", 0);

  const hf::OtaGateAction action = hf::otaBootGate(
      st, faulty, HF_OTA_MAX_PENDING_BOOTS, HF_OTA_MAX_NOCONTACT_BOOTS);

  if (action == hf::OtaGateAction::Rollback) {
    logf("[OTA] rollback (pv=%u/%u nc=%u/%u unproven=%d rr=%d) — reverting slot",
         (unsigned)st.pvBoots, (unsigned)HF_OTA_MAX_PENDING_BOOTS,
         (unsigned)st.ncBoots, (unsigned)HF_OTA_MAX_NOCONTACT_BOOTS,
         (int)st.unproven, (int)rr);
    // Persist a clean, proven state for the slot we revert TO (it was the
    // previously-good slot) so it can't immediately re-trip a rollback during
    // a prolonged outage, then force the bootloader-side revert.
    hf::otaResetForRollback(st);
    p.putUChar("unproven", st.unproven ? 1 : 0);
    p.putUInt("pv_boots", st.pvBoots);
    p.putUInt("nc_boots", st.ncBoots);
    p.end();
    delay(200);  // flush serial before reboot
    // App-initiated rollback works regardless of the bootloader's
    // CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE setting. Returns ESP_FAIL if there
    // is no previous valid slot (factory) — then we fall through and continue
    // setup; the slot keeps retrying until an operator intervenes via USB.
    esp_ota_mark_app_invalid_rollback_and_reboot();
    return;
  }

  // Persist only when a counter could have changed: a faulty reset bumped
  // pv_boots, or an unproven slot counted this boot in nc_boots. A clean boot
  // of a proven slot changes nothing, so skip the NVS write entirely — this
  // restores the old `if (!faulty) return;` fast-path explicitly rather than
  // leaning on NVS's identical-write dedup.
  if (faulty || st.unproven) {
    p.putUInt("pv_boots", st.pvBoots);
    p.putUInt("nc_boots", st.ncBoots);
    logf("[OTA] boot gate pv=%u/%u nc=%u/%u unproven=%d (reset_reason=%d)",
         (unsigned)st.pvBoots, (unsigned)HF_OTA_MAX_PENDING_BOOTS,
         (unsigned)st.ncBoots, (unsigned)HF_OTA_MAX_NOCONTACT_BOOTS,
         (int)st.unproven, (int)rr);
  }
  p.end();
}

// First-good-contact handler (#148 Phase 3). Called on every successful server
// contact (2xx heartbeat or upload). For a freshly-OTA'd ("unproven") slot the
// FIRST contact is the proof of health the no-contact rollback path waits for —
// so it clears `unproven` and zeroes the counters in NVS, which both satisfies
// the no-contact gate and lets the end-of-setup() block mark the slot valid.
//
// CRUCIALLY this does NOT itself call esp_ota_mark_app_valid_cancel_rollback().
// That IDF call is permanent — once a slot is ESP_OTA_IMG_VALID it can no
// longer be reverted by esp_ota_mark_app_invalid_rollback_and_reboot() — so it
// must stay at end-of-setup(), AFTER every stage that can panic (camera init).
// Calling it here, before camera init, would brick a slot that gets one good
// boot heartbeat and then panic-loops in initEspCamera (ADR-008's "every stage
// that can panic has succeeded" mark-valid placement; senior-review P0 on this
// PR). Clearing `unproven`
// here is safe: a camera-init panic before end-of-setup means mark-valid never
// fires, so the faulty-boot counter (pv_boots) still rolls the slot back.
//
// A static latch makes this an O(1) no-op once the slot is no longer unproven
// (or for a proven/factory slot), so it's cheap to call from the hot
// heartbeat/upload paths.
static void noteServerContactForOtaGate() {
  static bool settledThisBoot = false;
  if (settledThisBoot) return;
  hf::OtaGateState st;
  Preferences p;
  p.begin("ota", false);
  st.unproven = p.getUChar("unproven", 0) != 0;
  if (!st.unproven) {  // proven/factory — nothing to clear, latch and leave
    p.end();
    settledThisBoot = true;
    return;
  }
  st.pvBoots = p.getUInt("pv_boots", 0);
  st.ncBoots = p.getUInt("nc_boots", 0);
  if (hf::otaOnFirstContact(st)) {  // transitions unproven→false, zeroes counters
    p.putUChar("unproven", 0);
    p.putUInt("pv_boots", st.pvBoots);
    p.putUInt("nc_boots", st.ncBoots);
    logf("[OTA] first server contact — slot proven; mark-valid deferred to end of setup()");
  }
  p.end();
  settledThisBoot = true;
}

// A successful server contact feeds both loop()-health watchdogs: the liveness
// no-contact timer (#148 item 2) and the OTA mark-valid gate (#148 item 3).
static void onServerContact(uint32_t nowMs) {
  livenessMon.noteContact(nowMs);
  noteServerContactForOtaGate();
}




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
  //
  // Sequencing constraint: do NOT introduce blocking calls between
  // this read and the first breadcrumbSet below. The clobber window
  // is currently empty. A WDT firing in that window means the previous
  // boot's value is lost — minor diagnostic miss but acceptable.
  char recoveredCrumb[64] = {0};
  bool hadRecoveredCrumb =
      hf::breadcrumbReadAndClear(recoveredCrumb, sizeof(recoveredCrumb));

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
  // Gate on non-empty: the breadcrumb-set(nullptr) defensive path can
  // produce hadRecoveredCrumb=true with an empty string; logging
  // "[BOOT] last_stage_before_reboot=" with nothing after `=` is just
  // confusing noise, not useful diagnostic.
  if (hadRecoveredCrumb && recoveredCrumb[0] != '\0') {
    logf("[BOOT] last_stage_before_reboot=%s", recoveredCrumb);
    noteLastStageBeforeReboot(recoveredCrumb);
  }

  // Task watchdog — if loop() (or AP server) hangs for >TASK_WDT_TIMEOUT_S,
  // reboot. host.cpp's runAccessPoint() also feeds it; loop() resets at top.
  esp_task_wdt_init(TASK_WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  // OTA rollback (#26) — app-side recovery for failed slots.
  //
  // Why this is here, not in the bootloader: arduino-esp32's prebuilt
  // bootloader does NOT enable CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE,
  // so a slot that fails to call esp_ota_mark_app_valid_cancel_rollback()
  // will NOT be automatically rolled back by the ROM bootloader — it
  // will just keep booting the broken slot forever. Manual T4 verified
  // this: a setup()-time panic was retried 4+ times with no rollback.
  //
  // App-side fix: at the top of setup(), if the previous boot died
  // ungracefully (panic/WDT/brownout), increment an NVS counter. When
  // the counter crosses HF_OTA_MAX_PENDING_BOOTS, call
  // esp_ota_mark_app_invalid_rollback_and_reboot() — this is an
  // app-initiated rollback (works regardless of bootloader config). The
  // counter is reset to 0 at the end of setup() (so a healthy slot's
  // next boot starts fresh) and the fault gate prevents the counter
  // from incrementing on clean ESP.restart() paths (AP-fallback, daily
  // reboot, OTA post-flash boot) — see senior-review fix in the
  // function body for why the bare "increment every boot" was a
  // regression vector against transient WiFi outages.
  //
  // Hardware-faulty camera caveat: `initEspCamera`'s `abort()` on
  // `esp_camera_init` failure (after the round-2 senior-review fix)
  // also feeds this counter. A module with a physically broken camera
  // module — independent of any OTA — will therefore appear to
  // "spontaneously roll back" to its previous firmware after 3 boots.
  // The end-state panic-loop is the same as before, but the
  // operator-visible signals (fwVersion regression on the dashboard,
  // `[OTA] faulty-boot N/3` + `[OTA] threshold reached — forcing
  // rollback` on serial, even when no OTA was involved) may misdirect
  // a field-debug session into hunting an OTA issue. Disambiguate via
  // `esp_reset_reason()` value + the breadcrumb in the next telemetry
  // sidecar — a camera-init crash sets the breadcrumb to
  // `setup:initEspCamera`, an OTA-bricked slot to whichever stage
  // panicked.
  forceRollbackIfPendingTooLong();

  Serial.println("------ ESP STARTED ------");

  strlcpy(esp_config.CONFIG_FILE, CONFIG_FILE_PATH, sizeof(esp_config.CONFIG_FILE));

  // Note: an earlier "hold IO0 for 5 s at boot to factory-reset" path used
  // to live here. It was unreachable on AI Thinker ESP32-CAM-MB because
  // GPIO0 is a strap pin — the ROM samples it at the moment EN releases,
  // so holding it LOW enters UART download mode and this firmware never
  // runs. Removed in #40. The captive-portal factory-reset button was later
  // removed too; the supported reset/reconfigure paths are now:
  //   1. The 3-WiFi-fail auto-fallback below (re-opens the setup AP).
  //   2. Re-flash via the homepage wizard — the web installer erases NVS +
  //      SPIFFS, so the module boots back into the Wi-Fi setup page.
  //   3. `pio run -t erase` over a serial cable.
  // See docs/07-deployment-view/esp-flashing.md "Reconfiguration (re-flash)".

  /*
    ESP opens WiFi access point to receive the configuration from user input

    Once connected go to:

          ==============================
          ===== http://192.168.4.1 ===== -> ESP softAP() endpoint
          ==============================

    to type in your WiFi credentials (the only thing the page asks for —
    module name, server URLs and camera settings are set under the hood)
  */
  Serial.println("[ESP] OPENING ACCESS POINT");
  Serial.println("------ Connect on http://192.168.4.1 to configure ------");

  if (!isESPConfigured()) {
    Serial.println("-- ESP not yet configured. Opening ESP access point...");
    ledSetMode(hf::LedMode::ApMode);
    setupAccessPoint();
  } else {
    // Auto-fallback: if previous boots have repeatedly failed to join the
    // saved network, clear the NVS `configured` flag so the next boot
    // re-opens the captive portal. This triggers automatically without user
    // input — the supported recovery path when a module is moved to a new
    // network and the old SSID is gone.
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
    Serial.println("   (1) Re-flash via the homepage wizard Step 2 — flashing erases the saved config and reopens the WiFi setup page at http://192.168.4.1.");
    Serial.println("   (2) Over a serial cable: cd ESP32-CAM && pio run -t erase && pio run -t upload");
    Serial.println("   (3) Or cause 3 consecutive WiFi-join failures (e.g. move to a new network) — the board auto-reopens its setup AP at http://192.168.4.1.");
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

  // ArduinoOTA (#26 phase 1). LAN push from PlatformIO via
  // `pio run -t upload --upload-port=<module-ip>`. No auth — relies on
  // the WiFi segment's physical security. Hostname includes the module
  // ID so `pio device list` distinguishes modules on the same LAN.
  hf::breadcrumbSet("setup:arduino_ota_begin");
  stageStartMs = millis();
  {
    char otaHost[40];
    snprintf(otaHost, sizeof(otaHost), "hivehive-%s",
             hf::formatModuleId(esp_config.esp_ID).c_str());
    ArduinoOTA.setHostname(otaHost);
    ArduinoOTA.onStart([]() { logf("[OTA] LAN update start"); });
    // Feed the task watchdog from inside the ArduinoOTA upload loop.
    // ArduinoOTA.handle() is non-blocking on the no-upload path, but
    // once an upload is in progress it stays inside `handle()` for the
    // full transfer — at slow LAN speeds a 1 MB push can sit there
    // past TASK_WDT_TIMEOUT_S=60. onProgress fires per chunk, so this
    // is the canonical place to feed.
    ArduinoOTA.onProgress([](unsigned int, unsigned int) { esp_task_wdt_reset(); });
    ArduinoOTA.onError([](ota_error_t e) { logf("[OTA] LAN update error %u", (unsigned)e); });
    ArduinoOTA.begin();
  }
  logf("[STAGE] arduino_ota_begin took=%lums", millis() - stageStartMs);

  // HTTP OTA (#26 phase 2). Runs before getGeolocation/register so a
  // recovery binary lands without first having to survive the rest of
  // setup(). On success this call ESP.restart()s and never returns; on
  // any failure it logs and falls through.
  hf::breadcrumbSet("setup:http_ota_check");
  stageStartMs = millis();
  hf::httpOtaCheckAndApply(&esp_config);
  logf("[STAGE] http_ota_check took=%lums", millis() - stageStartMs);

  hf::breadcrumbSet("setup:getGeolocation");
  stageStartMs = millis();
  // #148 Phase 3: a nest doesn't move, so once we've resolved a plausible fix
  // we cache it in NVS and skip the heap-hungry boot-time Google TLS handshake
  // on every subsequent boot (the geo path was a standing contributor to the
  // longhorn heap leak, and re-running it each boot bought nothing). A cache
  // hit counts as a fix; a miss (first ever boot, or post-reflash NVS wipe)
  // falls through to the live call, and a fresh success is persisted.
  bool gotFix;
  if (loadCachedGeolocation(&esp_config.geolocation)) {
    gotFix = true;
    logf("[STAGE] getGeolocation skipped — NVS-cached fix lat=%.2f lng=%.2f acc=%.0f",
         esp_config.geolocation.latitude, esp_config.geolocation.longitude,
         esp_config.geolocation.accuracy);
  } else {
    gotFix = getGeolocation(&esp_config);
    logf("[STAGE] getGeolocation took=%lums fix=%s",
         millis() - stageStartMs, gotFix ? "ok" : "deferred");
    if (gotFix) {
      saveCachedGeolocation(esp_config.geolocation);
    }
  }

  Serial.print("Latitude: ");
  Serial.println(esp_config.geolocation.latitude, 6);

  Serial.print("Longitude: ");
  Serial.println(esp_config.geolocation.longitude, 6);

  Serial.print("Accuracy (m): ");
  Serial.println(esp_config.geolocation.accuracy);

  // ---- Initialize new module on server ---- //
  // We register UNCONDITIONALLY — even at the (0,0) sentinel when no
  // fix was obtained — so the module appears in the operator UI with
  // a "Location pending" pill (homepage-side, PR II / issue #49)
  // rather than being invisible until the next boot succeeds. The
  // heartbeat-side recovery path (loop()) will UPDATE the lat/lng
  // once a fix lands; duckdb-service only patches FROM (0,0), so a
  // deliberately-placed module is never clobbered.
  hf::breadcrumbSet("setup:initNewModuleOnServer");
  stageStartMs = millis();
  initNewModuleOnServer(&esp_config);
  logf("[STAGE] initNewModuleOnServer took=%lums", millis() - stageStartMs);

  // Arm the deferred-retry path if boot failed to obtain a fix.
  // loop() ticks the retry every iteration; once 30 minutes elapses
  // and a successful fix lands, the next heartbeat carries it.
  if (!gotFix) {
    markGeolocationFixNeedsRetry();
    Serial.println("[setup] no plausible geolocation fix this boot — armed deferred retry");
  }

  // Boot-time heartbeat (#15): plant freshness signal before slow
  // camera init so the dashboard reflects the post-reflash / daily-
  // reboot live state in seconds, not after the full setup pipeline.
  // Record the outcome with the scheduler so a failed boot POST schedules
  // a short retry (kHeartbeatRetryMs) rather than waiting a full hour, and
  // a never-primed scheduler still fires on the loop's first iteration.
  // `sendHeartbeat` fails quiet — chapter-11 "Post-reflash dashboard
  // latency" carries the full rationale.
  //
  // OTA interaction: this heartbeat fires BEFORE camera init and BEFORE
  // the mark-valid call at end-of-setup. On a first post-OTA boot, the
  // new slot's fwVersion briefly appears on the dashboard while the slot
  // is still pending-verify. If camera init then panics the slot rolls
  // back, and the NEXT boot's heartbeat corrects the displayed version.
  // Moving the heartbeat after mark-valid would fix the flicker but
  // defeat the "freshness before slow camera init" benefit — keep both
  // calls where they are and accept the cosmetic flicker as documented
  // in docs/06-runtime-view/ota-update-flow.md's Rollback section.
  hf::breadcrumbSet("setup:sendHeartbeat:boot");
  stageStartMs = millis();
  const bool bootHbOk = (sendHeartbeat(&esp_config) == 0);
  hbScheduler.recordResult(millis(), bootHbOk);
  // #148 Phase 3: a 2xx boot heartbeat is the earliest proof of live server
  // contact — it both seeds the liveness watchdog (item 2) and, on a freshly-
  // OTA'd slot, validates the slot + cancels rollback (item 3) before camera
  // init. So a good OTA image that can reach the server is confirmed within
  // seconds of boot, not deferred to the loop.
  if (bootHbOk) {
    onServerContact(millis());
  }
  logf("[STAGE] sendHeartbeat:boot took=%lums", millis() - stageStartMs);
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

  // OTA rollback gate (#26, narrowed by #148 Phase 3). Surviving setup() —
  // WiFi, registration, camera init, AND the warm-up loop — clears the
  // faulty-boot crash-loop counter for a proven/factory slot and (idempotently)
  // marks it valid. (This stage placement was earned: an earlier draft fired
  // before camera init, but senior-review caught that recoverCamera() does NOT
  // recover from a driver-level panic in initEspCamera/configure_camera_sensor,
  // so the right threshold is "every stage that can panic has succeeded".)
  //
  // For a freshly-OTA'd ("unproven") slot, surviving setup() is NO LONGER
  // proof of health: a boots-clean-but-can't-reach-the-server image used to
  // validate itself here and never roll back. otaOnSetupComplete() returns
  // false for such a slot, so mark-valid is DEFERRED to the first real server
  // contact (noteServerContactForOtaGate, fed by the boot heartbeat / loop
  // heartbeat / upload). A slot that never phones home is reverted by the
  // no-contact path in forceRollbackIfPendingTooLong(). See lib/ota_rollback
  // and ADR-008's #148 addendum.
  hf::breadcrumbSet("setup:ota_mark_valid");
  {
    hf::OtaGateState st;
    Preferences p;
    p.begin("ota", false);
    st.unproven = p.getUChar("unproven", 0) != 0;
    st.pvBoots  = p.getUInt("pv_boots", 0);
    st.ncBoots  = p.getUInt("nc_boots", 0);
    if (hf::otaOnSetupComplete(st)) {
      esp_ota_mark_app_valid_cancel_rollback();
      p.putUInt("pv_boots", st.pvBoots);  // reset to 0 — survived setup
    } else {
      logf("[OTA] setup complete but slot unproven — mark-valid deferred to first contact");
    }
    p.end();
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


// #143: re-prime the camera the way a fresh boot does, immediately before
// the scheduled daily capture. Field investigation found the daily noon
// image could come back near-black while a *restart* always produced a good
// frame. The restart path hands the OV2640 a clean cold-start — PWDN
// power-cycle, fresh esp_camera_init, sensor re-config, and a 3-frame
// auto-exposure warm-up — whereas the scheduled noon path was a bare single
// esp_camera_fb_get() after ~8 h of sensor idle.
//
// Honest caveat (see issue #143): a bench A/B on healthy hardware could NOT
// reproduce the black frame — neither the missing warm-up nor the VGA/DRAM
// fallback path reproduced it, which points the root cause at the specific
// field board's marginal PSRAM/power rather than firmware logic. This is
// therefore an UNVALIDATED mitigation: it routes the daily capture through the
// one path observed to always work, which is robust regardless of mechanism.
//
// Fail-safe by design: the re-init goes through recoverCameraSoft(), the
// NON-aborting variant. A capture-quality mitigation must never introduce a
// steady-state panic — on the marginal hardware this targets, an abort() here
// would risk a panic→reboot→(after 3) firmware rollback *every noon*. So on a
// re-init failure we log, skip this scheduled capture, and let loop() retry on
// the next iteration; the boot path keeps its own abort(), which is the
// load-bearing OTA-rollback trigger. The serial line + the
// `loop:primeCamera:noon` breadcrumb make it observable that this path ran
// (it can't be validated on the bench — see issue #143).
//
// Returns true iff the camera reinitialised AND at least one warm-up frame
// came back non-NULL — i.e. there is a live sensor for captureAndUpload() to
// grab from. On reinit failure OR all-3-NULL warm-up it returns false and the
// noon branch retries next loop instead of burning the day's slot on a dead
// sensor. Honest limit: this catches init failure and NULL frames, but NOT a
// valid-but-near-black frame — which is the actual #143 field symptom (init
// succeeds, a JPEG is produced, it's just near-black). Distinguishing that
// from a legitimately dark scene needs a fragile luminance/size heuristic we
// can't validate, so the near-black case is left to the cold-start itself to
// fix; this guard only stops us committing the day on a clearly-dead sensor.
static bool primeCameraLikeBoot() {
  Serial.println("-- priming camera (restart-equivalent cold-start) before scheduled capture");
  if (!recoverCameraSoft(esp_config.RESOLUTION)) {
    Serial.println("-- camera re-prime failed (reinit) — skipping this scheduled capture (will retry next loop)");
    return false;
  }
  configure_camera_sensor(&esp_config);   // re-apply brightness/saturation/vflip
  esp_task_wdt_reset();                    // the warm-up delays below don't feed the WDT
  int warmupNulls = 0;
  for (int i = 0; i < 3; i++) {
    delay(500);
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) {
      size_t fb_len = fb->len;
      esp_camera_fb_return(fb);
      Serial.printf("---- prime warm-up frame %d OK (%u bytes)\n", i + 1, (unsigned)fb_len);
    } else {
      Serial.printf("---- prime warm-up frame %d skipped (NULL)\n", i + 1);
      warmupNulls++;
    }
  }
  if (warmupNulls == 3) {
    Serial.println("-- all 3 prime warm-up frames NULL — skipping this scheduled capture (will retry next loop)");
    return false;
  }
  return true;
}

bool captureAndUpload() {
  Serial.println("");
  Serial.printf("-- Trying to capture and post image number %d\n", counter++);

  // The single 50 ms "alive + uploading" pulse is deliberately fired from
  // inside postImage() AFTER esp_camera_fb_get() returns the frame — NOT
  // here on entry. On this board the bright GPIO4 status LED *is* the camera
  // flash, and setting Uploading here lit it during the capture instant (a
  // needless energy cost and a flash in the operator's face). Moving the
  // pulse past the grab keeps the capture dark while preserving the upload
  // blink. See postImage() in client.cpp.
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

  // ArduinoOTA poll (#26 phase 1). Non-blocking; the 30 s `delay` at
  // the bottom of this loop caps the LAN-push responsiveness at 30 s,
  // well within PlatformIO's default upload retry budget.
  ArduinoOTA.handle();

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

  // WiFi-health reboot fallback (#149). The async path (onWifiEvent →
  // WiFi.reconnect() + setAutoReconnect) normally recovers a dropped link,
  // but under weak RSSI / AP rotation it can stall, leaving the module a
  // "WiFi zombie" (CPU fine, feeds the WDT, but offline) until the 24h
  // daily reboot — the silent-offline mode behind #143/#149. If WiFi stays
  // disconnected for > kWifiDownRebootMs (10 min), reboot to re-run the
  // full setup() WiFi join. This is a clean ESP.restart() (reset_reason =
  // ESP_RST_SW), so forceRollbackIfPendingTooLong() does NOT count it
  // toward the OTA faulty-boot rollback threshold. We deliberately do NOT
  // set the "boot"/daily_reboot NVS flag: a recovery reboot should take a
  // fresh boot image (a useful liveness smoke test), unlike the silent
  // daily wake. If WiFi is genuinely gone, setup()'s 30s join timeout will
  // escalate via wifiFailCount → AP-fallback captive portal.
  if (wifiHealth.shouldReboot(WiFi.status() == WL_CONNECTED, millis())) {
    hf::breadcrumbSet("loop:wifiHealthReboot");
    Serial.println("[REBOOT] WiFi down > 10 min — restarting to recover");
    delay(500);
    ESP.restart();
  }

  // Liveness self-heal reboot (#148 Phase 3). The guard above only fires when
  // WiFi is *down*; this one catches the nastier mode where WiFi is associated
  // and the loop is alive (WDT fed) but every server call silently hangs or
  // fails, so the module is mute yet looks healthy locally. If NO 2xx
  // heartbeat or upload has landed for kNoContactRebootMs (2 h) we restart to
  // re-run setup()'s clean WiFi join + TLS handshake. livenessMon.noteContact()
  // is called below on each successful heartbeat/upload; the first
  // shouldReboot() call anchors the clock so a just-booted module gets a full
  // 2 h window. Like the WiFi-health reboot this is a clean ESP.restart()
  // (ESP_RST_SW) — a server-side outage must not feed the OTA faulty-boot
  // rollback counter (a bad firmware *image* is handled by the mark-valid
  // gate, not by this watchdog). Distinct breadcrumb so the post-reboot
  // telemetry shows which guard fired.
  if (livenessMon.shouldReboot(millis())) {
    hf::breadcrumbSet("loop:livenessReboot");
    Serial.println("[REBOOT] no server contact > 2 h — restarting to recover");
    delay(500);
    ESP.restart();
  }

  // Geolocation deferred-retry tick (PR II / issue #89). Cheap call —
  // returns immediately unless the boot fix failed AND the 30-minute
  // backoff has elapsed. On a successful retry it queues the new fix
  // to be picked up by the next heartbeat.
  tickGeolocationDeferredRetry(&esp_config);

  // Telemetry heartbeat so the dashboard's lastSeenAt stays fresh between
  // captures. Tiny payload, no camera work, fails-quiet — never restarts.
  // The setup-time boot heartbeat (#15) primes hbScheduler before this
  // branch is ever reached; until then shouldSend() returns true so the
  // first loop iteration still plants the freshness signal. On a 2xx the
  // next attempt is one hour out; on a skip (WiFi down → -2) or non-2xx it
  // is only kHeartbeatRetryMs (5 min) out, so a transient blip costs ~5 min
  // of silence instead of a full hour (#149 — the timer no longer advances
  // a full interval on a failed/skipped ping).
  if (hbScheduler.shouldSend(millis())) {
    hf::breadcrumbSet("loop:sendHeartbeat");
    const int hbRc = sendHeartbeat(&esp_config);
    hbScheduler.recordResult(millis(), hbRc == 0);
    // #148 Phase 3: a 2xx heartbeat is the cheapest proof of live server
    // contact — keeps the liveness no-contact timer fresh (item 2) and
    // validates a freshly-OTA'd slot if the boot heartbeat hadn't already
    // (item 3).
    if (hbRc == 0) {
      onServerContact(millis());
    }
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
      onServerContact(millis());  // #148 Phase 3: 2xx upload == live contact (items 2+3)
    }
  }

  // Daily capture at noon (local time via NTP)
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 200)) {
    if (timeinfo.tm_hour == 12 && timeinfo.tm_yday != lastCaptureDay) {
      Serial.println("-- Noon capture");
      // #143: take the scheduled shot via the proven-good restart cold-start
      // (PWDN re-init + warm-up) rather than a bare single grab after hours
      // of sensor idle. See primeCameraLikeBoot() for the full rationale.
      // Mark today's slot done only when the re-prime AND the upload both
      // succeed — mirrors the first-capture-on-boot gate above. A failed
      // re-prime or a failed upload leaves lastCaptureDay unset so the next
      // loop iteration retries while it's still local noon, rather than
      // dropping today's image on a transient hiccup. captureAndUpload()'s
      // own circuit breaker still reboots after 5 consecutive failures.
      hf::breadcrumbSet("loop:primeCamera:noon");
      if (primeCameraLikeBoot()) {
        hf::breadcrumbSet("loop:captureAndUpload:noon");
        if (captureAndUpload()) {
          lastCaptureDay = timeinfo.tm_yday;
          onServerContact(millis());  // #148 Phase 3: 2xx upload == live contact (items 2+3)
        }
      }
    }
  }

  // The 30 s inter-capture sleep is implemented as a polling loop that
  // calls ArduinoOTA.handle() once per second instead of a single
  // delay(30000). Required for #26: espota.py opens a fresh UDP socket
  // per invitation retry and only waits 10 s for the OK reply, so if
  // handle() were called only once every 30 s the ESP's reply would
  // land on a socket espota had already closed — exactly what made
  // round-1 manual T6 fail with "No response from the ESP" even though
  // the serial log showed `[OTA] LAN update start` firing. Polling at
  // 1 Hz keeps the ESP responsive within espota's window; the loop
  // also feeds the watchdog each second so TASK_WDT_TIMEOUT_S=60 stays
  // valid. Set "loop:sleep" so a stuck poll (impossible in practice
  // but included for completeness) is identifiable post-reboot.
  hf::breadcrumbSet("loop:sleep");
  for (int i = 0; i < 30; ++i) {
    ArduinoOTA.handle();
    esp_task_wdt_reset();
    delay(1000);
  }
}

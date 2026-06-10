#pragma once

#include <cstdint>

// Pure, host-testable decision logic for the two loop()-level self-healing
// behaviours added for issue #149 (modules going silently offline within
// ~1 h of a restart, surfaced during the #143 investigation):
//
//   1. WifiHealthMonitor — reboot the module if WiFi stays disconnected for
//      longer than a threshold, so a stalled async auto-reconnect (a known
//      ESP32 failure mode under weak RSSI / AP rotation) can't leave the
//      module a "WiFi zombie" (CPU fine, feeds the WDT, but offline) until
//      the 24 h daily reboot.
//
//   2. HeartbeatScheduler — when a heartbeat is skipped/failed, schedule the
//      next attempt after a short retry backoff instead of advancing a full
//      hour, so a transient blip costs ~5 min of dashboard silence, not 60.
//
// Following the firmware's established pattern (see lib/led_state and
// lib/wifi_diag): all time and connectivity state is passed in as plain
// integers/bools so this logic compiles and is exercised on the native test
// target with no Arduino/WiFi/ESP dependency. The .ino owns the hardware
// glue (millis(), WiFi.status(), ESP.restart()).

namespace hf {

// 10 min: long enough for onWifiEvent's WiFi.reconnect() + setAutoReconnect
// to recover a transient drop, far short of the 2 h dashboard-offline mark
// and the 24 h daily reboot. The recovery reboot is ESP.restart()
// (reset_reason = ESP_RST_SW), which is exempt from the OTA faulty-boot
// rollback counter — see forceRollbackIfPendingTooLong() in the .ino.
constexpr uint32_t kWifiDownRebootMs = 10UL * 60UL * 1000UL;

// 1 h: the steady-state heartbeat cadence (the dashboard's lastSeenAt
// freshness window is 2 h, so hourly leaves a comfortable margin).
constexpr uint32_t kHeartbeatIntervalMs = 60UL * 60UL * 1000UL;

// 5 min: retry cadence after a skipped/failed heartbeat. Chosen over
// "retry on the very next ~30 s loop iteration" so a flaky or slow server
// is not hammered, while still beating the old full-hour gap by 12x.
constexpr uint32_t kHeartbeatRetryMs = 5UL * 60UL * 1000UL;

// 2 h: if NOTHING the module sends has reached the server for this long — no
// successful heartbeat AND no successful image upload — force a recovery
// reboot (issue #148 Phase 3). This is the gap the other two guards miss:
// WifiHealthMonitor only fires when WiFi is *down*, and the upload circuit
// breaker only counts *failed* uploads (which happen ~daily) — neither
// catches a "WiFi up, loop alive, but every server call silently hangs or
// fails" zombie, which otherwise stays mute until the 24 h daily reboot.
// 2 h matches the dashboard's offline window and gives the hourly heartbeat
// + 5 min retries two full cycles to make contact before we give up. The
// reboot is ESP.restart() (ESP_RST_SW) — deliberately NOT a panic, so a mere
// server-side outage cannot feed the OTA faulty-boot rollback counter (a bad
// *firmware* image is handled by the mark-valid gate, not here).
constexpr uint32_t kNoContactRebootMs = 2UL * 60UL * 60UL * 1000UL;

// Tracks how long WiFi has been continuously disconnected and decides when
// a recovery reboot is due. Stateless w.r.t. the clock: the caller passes
// the current millis() value and the current connectivity each tick.
class WifiHealthMonitor {
 public:
  explicit WifiHealthMonitor(uint32_t rebootAfterMs = kWifiDownRebootMs)
      : rebootAfterMs_(rebootAfterMs) {}

  // Call once per loop iteration with the live WiFi state and clock.
  // Returns true exactly when WiFi has been continuously disconnected for
  // strictly longer than the threshold — the caller should then reboot.
  // A reconnect at any point resets the down-timer, so a recovered blip
  // never triggers a reboot.
  bool shouldReboot(bool wifiConnected, uint32_t nowMs);

 private:
  uint32_t rebootAfterMs_;
  bool tracking_ = false;     // are we currently timing a disconnect?
  uint32_t downSinceMs_ = 0;  // millis() at which the current outage began
};

// Decides when the next heartbeat is due, applying a short retry backoff
// after a failure instead of the full steady-state interval. This is the
// fix for the "timer advances even when the ping was skipped/failed" gap:
// the timer always advances (so the loop never busy-spins on heartbeats),
// but a failure schedules the next attempt only kHeartbeatRetryMs out.
class HeartbeatScheduler {
 public:
  explicit HeartbeatScheduler(uint32_t intervalMs = kHeartbeatIntervalMs,
                              uint32_t retryMs = kHeartbeatRetryMs)
      : intervalMs_(intervalMs), retryMs_(retryMs) {}

  // True if a heartbeat should be attempted now. Always true until the
  // first recordResult() (so the boot/first-iteration heartbeat fires),
  // then gated by the interval that corresponds to the last outcome.
  bool shouldSend(uint32_t nowMs) const;

  // Record the outcome of an attempt. `ok` is true only for a real 2xx
  // (sendHeartbeat() returning 0); a skip (WiFi down, -2) or non-2xx is a
  // failure and schedules the shorter retry interval.
  void recordResult(uint32_t nowMs, bool ok);

 private:
  uint32_t intervalMs_;
  uint32_t retryMs_;
  bool primed_ = false;       // has at least one attempt been recorded?
  uint32_t lastAttemptMs_ = 0;
  bool lastOk_ = false;
};

// Liveness self-heal watchdog (issue #148 Phase 3). Tracks the last time the
// module had SUCCESSFUL contact with the server — a 2xx heartbeat OR a 2xx
// image upload — and asks for a recovery reboot once that goes stale. This
// catches the silent-hang failure mode (WiFi associated, task-WDT fed, loop
// running, but every server call hangs/fails) that neither WifiHealthMonitor
// (WiFi-down only) nor the upload circuit breaker (failed-uploads only, and
// uploads are ~daily) detects. Stateless w.r.t. the clock, like the monitors
// above: the caller injects millis() and reports each success.
class LivenessMonitor {
 public:
  explicit LivenessMonitor(uint32_t rebootAfterMs = kNoContactRebootMs)
      : rebootAfterMs_(rebootAfterMs) {}

  // Report a successful server contact (sendHeartbeat() == 0, or a 2xx
  // upload). Resets the staleness timer.
  void noteContact(uint32_t nowMs);

  // Call once per loop iteration. Returns true exactly when there has been NO
  // successful contact for strictly longer than the threshold. The FIRST call
  // anchors the clock (so a freshly-booted module that hasn't yet reached the
  // server gets a full threshold window, and nowMs == 0 on the first tick does
  // not instantly trip) — same bool-flag anchoring as WifiHealthMonitor.
  bool shouldReboot(uint32_t nowMs);

 private:
  uint32_t rebootAfterMs_;
  bool primed_ = false;        // has the clock been anchored / a contact seen?
  uint32_t lastContactMs_ = 0; // millis() of the most recent successful contact
};

}  // namespace hf

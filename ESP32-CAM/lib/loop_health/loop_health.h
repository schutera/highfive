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

}  // namespace hf

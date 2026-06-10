// Native (host) unit tests for the issue #149 loop()-health logic:
// WifiHealthMonitor (reboot after a sustained WiFi outage) and
// HeartbeatScheduler (short retry backoff after a skipped/failed ping).
//
// Time and connectivity are injected as plain values — no Arduino/WiFi/ESP
// dependency — so these run on the native target in milliseconds. The tests
// assert behaviour at concrete millisecond boundaries (10 min, 5 min, 1 h),
// not just that the structs exist: the thresholds are the contract.

#include <unity.h>

#include "loop_health.h"

using hf::HeartbeatScheduler;
using hf::LivenessMonitor;
using hf::WifiHealthMonitor;
using hf::kHeartbeatIntervalMs;
using hf::kHeartbeatRetryMs;
using hf::kNoContactRebootMs;
using hf::kWifiDownRebootMs;

void setUp() {}
void tearDown() {}

// ---- WifiHealthMonitor -----------------------------------------------------

static void test_wifi_connected_never_reboots(void) {
  WifiHealthMonitor mon;
  // Even at an uptime far beyond the threshold, a connected module never
  // asks to reboot.
  TEST_ASSERT_FALSE(mon.shouldReboot(true, 0));
  TEST_ASSERT_FALSE(mon.shouldReboot(true, kWifiDownRebootMs + 1));
  TEST_ASSERT_FALSE(mon.shouldReboot(true, 5UL * kWifiDownRebootMs));
}

static void test_wifi_down_below_threshold_no_reboot(void) {
  WifiHealthMonitor mon;
  // Outage anchors at t=1000; still under 10 min one tick later.
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 1000));
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 1000 + 9UL * 60UL * 1000UL));  // +9 min
}

static void test_wifi_down_at_exact_threshold_no_reboot(void) {
  WifiHealthMonitor mon;
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 0));
  // Exactly 10 min of outage is NOT yet "longer than" the threshold.
  TEST_ASSERT_FALSE(mon.shouldReboot(false, kWifiDownRebootMs));
}

static void test_wifi_down_past_threshold_reboots(void) {
  WifiHealthMonitor mon;
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 0));        // anchor outage at 0
  TEST_ASSERT_TRUE(mon.shouldReboot(false, 600001));    // 10 min + 1 ms
}

static void test_wifi_anchor_survives_first_tick_at_zero(void) {
  // Regression guard: nowMs == 0 on the first disconnected tick must anchor
  // the outage, not instantly trip a reboot (the reason we track a bool flag
  // instead of using 0 as a sentinel).
  WifiHealthMonitor mon;
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 0));
  TEST_ASSERT_FALSE(mon.shouldReboot(false, kWifiDownRebootMs));  // exactly 10 min
  TEST_ASSERT_TRUE(mon.shouldReboot(false, kWifiDownRebootMs + 1));
}

static void test_wifi_reconnect_resets_timer(void) {
  WifiHealthMonitor mon;
  mon.shouldReboot(false, 0);                           // outage starts at 0
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 540000));   // 9 min — still down
  TEST_ASSERT_FALSE(mon.shouldReboot(true, 560000));    // recovered before 10 min
  // A fresh outage must start counting from scratch, not from the old anchor.
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 600000));   // new outage anchors here
  TEST_ASSERT_FALSE(mon.shouldReboot(false, 600000 + kWifiDownRebootMs));  // +10 min exact
  TEST_ASSERT_TRUE(mon.shouldReboot(false, 600000 + kWifiDownRebootMs + 1));
}

// ---- HeartbeatScheduler ----------------------------------------------------

static void test_heartbeat_fires_before_first_attempt(void) {
  HeartbeatScheduler sched;
  // Until the first recordResult(), a heartbeat is always due — this is the
  // boot-heartbeat / first-loop-iteration priming path.
  TEST_ASSERT_TRUE(sched.shouldSend(0));
  TEST_ASSERT_TRUE(sched.shouldSend(123456));
}

static void test_heartbeat_success_waits_full_interval(void) {
  HeartbeatScheduler sched;
  sched.recordResult(1000, /*ok=*/true);
  TEST_ASSERT_FALSE(sched.shouldSend(1000));                          // just sent
  TEST_ASSERT_FALSE(sched.shouldSend(1000 + kHeartbeatIntervalMs));   // exactly 1 h
  TEST_ASSERT_TRUE(sched.shouldSend(1000 + kHeartbeatIntervalMs + 1));// 1 h + 1 ms
}

static void test_heartbeat_failure_uses_short_retry(void) {
  HeartbeatScheduler sched;
  sched.recordResult(1000, /*ok=*/false);
  // Must NOT wait the full hour after a failure...
  TEST_ASSERT_FALSE(sched.shouldSend(1000 + 4UL * 60UL * 1000UL));   // +4 min: not yet
  TEST_ASSERT_TRUE(sched.shouldSend(1000 + 5UL * 60UL * 1000UL + 1));// +5 min + 1 ms: due
  // Concretely far below the steady-state interval.
  TEST_ASSERT_TRUE(kHeartbeatRetryMs < kHeartbeatIntervalMs);
}

static void test_heartbeat_success_after_failure_restores_cadence(void) {
  HeartbeatScheduler sched;
  sched.recordResult(0, /*ok=*/false);                 // failed
  sched.recordResult(100, /*ok=*/true);                // then succeeded
  // Back to the hourly cadence: a retry-interval later is NOT yet due.
  TEST_ASSERT_FALSE(sched.shouldSend(100 + kHeartbeatRetryMs + 1));
  TEST_ASSERT_TRUE(sched.shouldSend(100 + kHeartbeatIntervalMs + 1));
}

// ---- LivenessMonitor (issue #148 Phase 3) ---------------------------------

static void test_liveness_first_tick_anchors_no_reboot(void) {
  // A freshly-booted module that hasn't reached the server yet must NOT
  // instantly reboot — the first shouldReboot() call anchors the clock and
  // grants a full threshold window. nowMs == 0 first tick must not trip.
  LivenessMonitor mon;
  TEST_ASSERT_FALSE(mon.shouldReboot(0));
  TEST_ASSERT_FALSE(mon.shouldReboot(kNoContactRebootMs));         // exactly 2 h
  TEST_ASSERT_TRUE(mon.shouldReboot(kNoContactRebootMs + 1));      // 2 h + 1 ms
}

static void test_liveness_contact_resets_timer(void) {
  LivenessMonitor mon;
  mon.shouldReboot(0);                  // anchor at 0
  mon.noteContact(60UL * 60UL * 1000UL);  // successful contact at 1 h
  // 2 h after the *contact* (not the anchor) is the deadline.
  TEST_ASSERT_FALSE(mon.shouldReboot(60UL * 60UL * 1000UL + kNoContactRebootMs));
  TEST_ASSERT_TRUE(mon.shouldReboot(60UL * 60UL * 1000UL + kNoContactRebootMs + 1));
}

static void test_liveness_healthy_hourly_contact_never_reboots(void) {
  // A healthy module contacts the server every hour, so the staleness timer
  // is never older than ~1 h and a reboot is never requested.
  LivenessMonitor mon;
  for (uint32_t h = 0; h <= 48; ++h) {
    const uint32_t t = h * 60UL * 60UL * 1000UL;
    TEST_ASSERT_FALSE(mon.shouldReboot(t));
    mon.noteContact(t);  // hourly 2xx heartbeat
  }
}

static void test_liveness_contact_just_before_deadline_resets(void) {
  // A contact arriving just before the 2 h mark must reset the window — a
  // module making slow-but-real progress is not rebooted.
  LivenessMonitor mon;
  mon.noteContact(1000);
  const uint32_t almost = 1000 + kNoContactRebootMs - 1;  // 1 ms before deadline
  TEST_ASSERT_FALSE(mon.shouldReboot(almost));
  mon.noteContact(almost);                                 // fresh contact
  TEST_ASSERT_FALSE(mon.shouldReboot(almost + kNoContactRebootMs));     // new 2 h
  TEST_ASSERT_TRUE(mon.shouldReboot(almost + kNoContactRebootMs + 1));
}

static void test_liveness_hung_after_contact_reboots(void) {
  // The actual failure mode the watchdog exists for: the module makes contact
  // (a 2xx heartbeat at 1 h), then every subsequent call silently hangs. Once
  // 2 h have elapsed since that last contact, a reboot is requested.
  LivenessMonitor mon;
  mon.shouldReboot(0);                          // anchor at boot
  mon.noteContact(60UL * 60UL * 1000UL);        // healthy 1 h heartbeat
  const uint32_t lastContact = 60UL * 60UL * 1000UL;
  // ...then silence. Still under 2 h since contact → no reboot.
  TEST_ASSERT_FALSE(mon.shouldReboot(lastContact + kNoContactRebootMs));     // exactly 2 h
  // Strictly past 2 h since the last contact → reboot.
  TEST_ASSERT_TRUE(mon.shouldReboot(lastContact + kNoContactRebootMs + 1));
}

static void test_liveness_handles_millis_rollover(void) {
  // loop_health.cpp claims "unsigned subtraction wraps correctly across the
  // millis() rollover" — pin it. Contact lands shortly before the uint32_t
  // wrap; the deadline falls just after wrap. The wrapped subtraction must
  // still measure a true ~2 h gap, not a spurious ~49-day one.
  LivenessMonitor mon;
  const uint32_t nearWrap = 0xFFFFFFFFUL - 1000UL;  // ~1 s before rollover
  mon.noteContact(nearWrap);
  // 2 h after nearWrap wraps past 0. Exactly 2 h is not yet "longer than".
  const uint32_t atDeadline = nearWrap + kNoContactRebootMs;       // wraps
  const uint32_t pastDeadline = nearWrap + kNoContactRebootMs + 1; // wraps
  TEST_ASSERT_FALSE(mon.shouldReboot(atDeadline));
  TEST_ASSERT_TRUE(mon.shouldReboot(pastDeadline));
}

static void test_liveness_threshold_is_two_hours(void) {
  // Pin the contract: the no-contact reboot window is 2 h, comfortably above
  // the 1 h heartbeat cadence and equal to the dashboard's offline window.
  TEST_ASSERT_EQUAL_UINT32(2UL * 60UL * 60UL * 1000UL, kNoContactRebootMs);
  TEST_ASSERT_TRUE(kNoContactRebootMs > kHeartbeatIntervalMs);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_wifi_connected_never_reboots);
  RUN_TEST(test_wifi_down_below_threshold_no_reboot);
  RUN_TEST(test_wifi_down_at_exact_threshold_no_reboot);
  RUN_TEST(test_wifi_down_past_threshold_reboots);
  RUN_TEST(test_wifi_anchor_survives_first_tick_at_zero);
  RUN_TEST(test_wifi_reconnect_resets_timer);
  RUN_TEST(test_heartbeat_fires_before_first_attempt);
  RUN_TEST(test_heartbeat_success_waits_full_interval);
  RUN_TEST(test_heartbeat_failure_uses_short_retry);
  RUN_TEST(test_heartbeat_success_after_failure_restores_cadence);
  RUN_TEST(test_liveness_first_tick_anchors_no_reboot);
  RUN_TEST(test_liveness_contact_resets_timer);
  RUN_TEST(test_liveness_healthy_hourly_contact_never_reboots);
  RUN_TEST(test_liveness_contact_just_before_deadline_resets);
  RUN_TEST(test_liveness_hung_after_contact_reboots);
  RUN_TEST(test_liveness_handles_millis_rollover);
  RUN_TEST(test_liveness_threshold_is_two_hours);
  return UNITY_END();
}

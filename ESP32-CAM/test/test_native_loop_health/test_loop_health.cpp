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
using hf::WifiHealthMonitor;
using hf::kHeartbeatIntervalMs;
using hf::kHeartbeatRetryMs;
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
  return UNITY_END();
}

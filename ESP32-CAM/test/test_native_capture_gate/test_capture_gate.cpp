// Native (host) unit tests for hf::captureGateShouldCapture / captureGateNote
// (issue #179, boot-capture rate-limit guardrail).
//
// On real ESP32 hardware the storage is `RTC_NOINIT_ATTR`, which survives
// software reboots (TASK_WDT, panic, ESP.restart() — including the
// `livenessReboot` that ends a #170 reboot-loop session) and is wiped on
// power-on. Native tests model this with file-static storage: state persists
// across calls within a single test process; setUp() resets between cases.
//
// The slot caps a reboot-loop image storm at one boot capture per window. If
// these tests drift (e.g. the gate stops failing open without a clock, or
// throttles a genuine power-cycle) we either lose the guardrail or, worse,
// silently drop legitimate boot images.

#include <unity.h>

#include "capture_gate.h"

using hf::captureGateClearForTest;
using hf::captureGateNote;
using hf::captureGateShouldCapture;
using hf::kBootCaptureWindowSec;
using hf::kMinPlausibleEpoch;

// A plausible synced-clock epoch (2026-06-01T00:00:00Z) used as the base.
static const std::uint32_t kNow = 1780272000u;

void setUp() {
    // RTC_NOINIT semantics survive soft-reboots but are wiped on power-on; a
    // single test process cannot model that, so reset to the power-on state.
    captureGateClearForTest();
}

void tearDown() {}

// Power-on / first boot: no anchor on record → capture. This is the genuine
// unplug/redeploy case that must ALWAYS image, and is exactly the state the
// RTC power-on wipe (modelled by setUp) leaves behind.
static void test_first_boot_captures(void) {
    TEST_ASSERT_TRUE(captureGateShouldCapture(kNow, kBootCaptureWindowSec));
}

// Within the window after a recorded capture → throttle. The reboot-loop case:
// a software reset re-runs setup() while the RTC slot survives.
static void test_within_window_throttles(void) {
    captureGateNote(kNow);
    // 40 s later (the documented storm cadence) — still inside the 30 min window.
    TEST_ASSERT_FALSE(captureGateShouldCapture(kNow + 40, kBootCaptureWindowSec));
    // Just before the boundary.
    TEST_ASSERT_FALSE(
        captureGateShouldCapture(kNow + kBootCaptureWindowSec - 1, kBootCaptureWindowSec));
}

// At/after the window boundary → capture again (≤1 image per window, not zero).
static void test_window_expired_captures(void) {
    captureGateNote(kNow);
    TEST_ASSERT_TRUE(
        captureGateShouldCapture(kNow + kBootCaptureWindowSec, kBootCaptureWindowSec));
    TEST_ASSERT_TRUE(
        captureGateShouldCapture(kNow + kBootCaptureWindowSec + 1, kBootCaptureWindowSec));
}

// No synced clock (pre-NTP epoch) → fail open (capture), even right after a
// note. Without a clock we can't measure the window; in the documented storm a
// successful upload (the thing throttled) required a working network anyway.
static void test_no_clock_fails_open(void) {
    captureGateNote(kNow);
    TEST_ASSERT_TRUE(captureGateShouldCapture(kMinPlausibleEpoch - 1, kBootCaptureWindowSec));
    TEST_ASSERT_TRUE(captureGateShouldCapture(0, kBootCaptureWindowSec));
}

// A bogus pre-NTP epoch must NOT be persisted as the window anchor: after such
// a note, a later plausible boot still sees "no anchor" and captures.
static void test_note_ignores_bogus_epoch(void) {
    captureGateNote(kMinPlausibleEpoch - 5);  // ignored
    TEST_ASSERT_TRUE(captureGateShouldCapture(kNow, kBootCaptureWindowSec));
}

// Clock moved backwards (NTP correction) → fail open rather than throttle on a
// nonsensical negative interval.
static void test_backwards_clock_fails_open(void) {
    captureGateNote(kNow);
    TEST_ASSERT_TRUE(captureGateShouldCapture(kNow - 100, kBootCaptureWindowSec));
}

// Re-noting moves the window anchor forward: two captures a full window apart
// both record, and the second window is measured from the second capture.
static void test_renote_advances_window(void) {
    captureGateNote(kNow);
    const std::uint32_t second = kNow + kBootCaptureWindowSec;
    TEST_ASSERT_TRUE(captureGateShouldCapture(second, kBootCaptureWindowSec));
    captureGateNote(second);
    // 40 s after the SECOND capture → throttled (anchor advanced).
    TEST_ASSERT_FALSE(captureGateShouldCapture(second + 40, kBootCaptureWindowSec));
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_first_boot_captures);
    RUN_TEST(test_within_window_throttles);
    RUN_TEST(test_window_expired_captures);
    RUN_TEST(test_no_clock_fails_open);
    RUN_TEST(test_note_ignores_bogus_epoch);
    RUN_TEST(test_backwards_clock_fails_open);
    RUN_TEST(test_renote_advances_window);
    return UNITY_END();
}

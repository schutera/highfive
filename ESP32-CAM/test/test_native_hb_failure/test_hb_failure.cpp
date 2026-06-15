// Native (host) unit tests for hf::hbFailureNote / hbFailureClear /
// hbFailurePeek (issue #172).
//
// On real ESP32 hardware the storage is `RTC_NOINIT_ATTR`, which survives
// software reboots (TASK_WDT, panic, ESP.restart() — including the
// `livenessReboot` that ends a #170 reboot-loop session) and is wiped on
// power-on. Native tests model this with file-static storage: state persists
// across calls within a single test process; setUp() resets between cases.
//
// The slot is what carries "why did the previous session's hourly heartbeats
// fail" to the server on the next 2xx heartbeat. If these tests drift (e.g. a
// change makes peek fail-open on indeterminate memory, or note add to RTC
// garbage) we lose the remote-diagnosis signal #172 exists to provide.

#include <unity.h>

#include "hb_failure.h"

using hf::HbFailure;
using hf::hbFailureClear;
using hf::hbFailureNote;
using hf::hbFailurePeek;

void setUp() {
    // RTC_NOINIT semantics survive soft-reboots; a single test process cannot
    // model that natively, so we explicitly reset between cases.
    hbFailureClear();
}

void tearDown() {}

// After a clear the streak reads {0, 0}. `hbFailureClear` INVALIDATES the
// magic guard (it does not leave a valid zero-count slot), so this peek goes
// through the exact same fail-closed branch as cold-boot RTC garbage — i.e.
// this case pins the magic-guard fail-closed property, the one safety net that
// keeps indeterminate RTC contents on a cold boot from masquerading as a
// real reboot-loop streak. setUp() leaves us in precisely that invalid-magic
// state before every case.
static void test_clear_reads_zero_via_failclosed_path(void) {
    HbFailure f = hbFailurePeek();
    TEST_ASSERT_EQUAL_INT(0, f.code);
    TEST_ASSERT_EQUAL_UINT32(0, f.count);
}

// Explicit fail-closed pin: arm a real streak (valid magic), then clear, then
// peek. If clear ever regressed to leaving the magic valid, a future cold boot
// with stale RTC contents would surface a phantom streak; this asserts the
// post-clear slot is genuinely the {0, 0} fail-closed state.
static void test_clear_invalidates_into_failclosed_state(void) {
    hbFailureNote(503);
    hbFailureNote(503);
    TEST_ASSERT_EQUAL_UINT32(2, hbFailurePeek().count);
    hbFailureClear();
    HbFailure f = hbFailurePeek();
    TEST_ASSERT_EQUAL_INT(0, f.code);
    TEST_ASSERT_EQUAL_UINT32(0, f.count);
}

// One failure: count 1, code recorded.
static void test_single_note(void) {
    hbFailureNote(-2);
    HbFailure f = hbFailurePeek();
    TEST_ASSERT_EQUAL_INT(-2, f.code);
    TEST_ASSERT_EQUAL_UINT32(1, f.count);
}

// Consecutive failures accumulate; code reflects the MOST RECENT failure.
// This is the reboot-loop signature: a streak that climbs across the hourly
// heartbeats of a single session.
static void test_streak_accumulates_latest_code_wins(void) {
    hbFailureNote(500);
    hbFailureNote(-2);
    hbFailureNote(403);
    HbFailure f = hbFailurePeek();
    TEST_ASSERT_EQUAL_INT(403, f.code);
    TEST_ASSERT_EQUAL_UINT32(3, f.count);
}

// Peek does not mutate — the boot heartbeat peeks to build its body, and the
// streak must survive until the 2xx response clears it (so a transient server
// outage on the boot heartbeat keeps the streak queued for the next one).
static void test_peek_is_non_mutating(void) {
    hbFailureNote(-2);
    hbFailureNote(-2);
    (void)hbFailurePeek();
    HbFailure f = hbFailurePeek();
    TEST_ASSERT_EQUAL_UINT32(2, f.count);
}

// A 2xx clears the streak: the server has seen it, so the next session starts
// from zero.
static void test_clear_resets_after_streak(void) {
    hbFailureNote(500);
    hbFailureNote(500);
    hbFailureClear();
    HbFailure f = hbFailurePeek();
    TEST_ASSERT_EQUAL_INT(0, f.code);
    TEST_ASSERT_EQUAL_UINT32(0, f.count);
}

// A note after a clear starts a fresh streak at 1 (not 3) — the clear zeroed
// the count, and the next failure begins a new streak rather than resuming
// the old one.
static void test_note_after_clear_starts_fresh(void) {
    hbFailureNote(500);
    hbFailureNote(500);
    hbFailureClear();
    hbFailureNote(-2);
    HbFailure f = hbFailurePeek();
    TEST_ASSERT_EQUAL_INT(-2, f.code);
    TEST_ASSERT_EQUAL_UINT32(1, f.count);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_clear_reads_zero_via_failclosed_path);
    RUN_TEST(test_clear_invalidates_into_failclosed_state);
    RUN_TEST(test_single_note);
    RUN_TEST(test_streak_accumulates_latest_code_wins);
    RUN_TEST(test_peek_is_non_mutating);
    RUN_TEST(test_clear_resets_after_streak);
    RUN_TEST(test_note_after_clear_starts_fresh);
    return UNITY_END();
}

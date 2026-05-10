// Native (host) unit tests for hf::breadcrumbSet / breadcrumbClear /
// breadcrumbReadAndClear.
//
// On real ESP32 hardware the storage is `RTC_NOINIT_ATTR`, which means
// it survives software reboots (TASK_WDT, panic, ESP.restart()) and is
// wiped on power-on. Native tests model this with file-static storage:
// state persists across calls within a single test process; setUp()
// resets between cases so tests don't contaminate each other.
//
// The slot is the only post-mortem signal we have for issue #42. If
// these tests drift (e.g. a future change makes the slot fail-open
// instead of fail-closed) we lose the ability to identify which stage
// was active when the watchdog fired in the field.

#include <unity.h>

#include <cstring>

#include "breadcrumb.h"

using hf::breadcrumbClear;
using hf::breadcrumbReadAndClear;
using hf::breadcrumbSet;

void setUp() {
    // RTC_NOINIT semantics survive soft-reboots; a single test process
    // cannot model that natively, so we explicitly reset between cases.
    breadcrumbClear();
}

void tearDown() {}

// Fresh state (no prior set) must read as "no breadcrumb". This is the
// fail-closed property — without it, random RTC contents on cold boot
// would surface as a fake stage name in the next upload sidecar.
static void test_fresh_state_returns_false(void) {
    char out[64];
    out[0] = 'X';
    out[1] = '\0';
    bool ok = breadcrumbReadAndClear(out, sizeof(out));
    TEST_ASSERT_FALSE(ok);
}

static void test_set_then_read_returns_true_with_value(void) {
    breadcrumbSet("setup:getGeolocation");
    char out[64];
    bool ok = breadcrumbReadAndClear(out, sizeof(out));
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_STRING("setup:getGeolocation", out);
}

// One-shot semantics: a successful read clears the slot so a clean
// second boot doesn't double-report the same stage as the prior crash.
static void test_read_is_one_shot(void) {
    breadcrumbSet("X");
    char first_out[64];
    char second_out[64];
    bool first = breadcrumbReadAndClear(first_out, sizeof(first_out));
    bool second = breadcrumbReadAndClear(second_out, sizeof(second_out));
    TEST_ASSERT_TRUE(first);
    TEST_ASSERT_EQUAL_STRING("X", first_out);
    TEST_ASSERT_FALSE(second);
}

static void test_long_string_is_truncated(void) {
    const char longStr[] =
        "this_is_a_very_long_stage_name_that_will_definitely_exceed_64_bytes";
    breadcrumbSet(longStr);
    char out[64];
    bool ok = breadcrumbReadAndClear(out, sizeof(out));
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_size_t(63, std::strlen(out));
    TEST_ASSERT_EQUAL_STRING_LEN(longStr, out, 63);
}

static void test_explicit_clear_wipes_prior_set(void) {
    breadcrumbSet("X");
    breadcrumbClear();
    char out[64];
    bool ok = breadcrumbReadAndClear(out, sizeof(out));
    TEST_ASSERT_FALSE(ok);
}

// Defensive: a nullptr stage still arms the slot (magic set) but with
// an empty value. Read returns true with empty out — caller can detect
// "the previous boot reached a hf::breadcrumbSet(nullptr) call site"
// without crashing on the strncpy.
static void test_null_set_is_defensive_empty_marker(void) {
    breadcrumbSet(nullptr);
    char out[64] = {'X', 'Y', 'Z', '\0'};
    bool ok = breadcrumbReadAndClear(out, sizeof(out));
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_STRING("", out);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_fresh_state_returns_false);
    RUN_TEST(test_set_then_read_returns_true_with_value);
    RUN_TEST(test_read_is_one_shot);
    RUN_TEST(test_long_string_is_truncated);
    RUN_TEST(test_explicit_clear_wipes_prior_set);
    RUN_TEST(test_null_set_is_defensive_empty_marker);
    return UNITY_END();
}

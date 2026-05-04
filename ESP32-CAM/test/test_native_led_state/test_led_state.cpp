// Native (host) unit tests for hf::ledOnAt. The patterns these pin are
// what a field operator sees on the board's on-board LED, so the duty
// cycles and period boundaries are load-bearing for diagnosing setup
// issues in the field.

#include <unity.h>

#include "led_state.h"

using hf::LedMode;
using hf::ledOnAt;

void setUp() {}
void tearDown() {}

static void test_off_is_always_off(void) {
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Off, 0));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Off, 1));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Off, 9999999));
}

static void test_connected_is_always_on(void) {
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connected, 0));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connected, 12345));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connected, 9999999));
}

static void test_connecting_is_1hz_50pct_duty(void) {
    // First 500 ms on, next 500 ms off, repeating.
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connecting, 0));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connecting, 1));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connecting, 499));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connecting, 500));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connecting, 999));
    // Period boundary.
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connecting, 1000));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Connecting, 1499));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connecting, 1500));
}

static void test_failed_is_5hz(void) {
    // 100 ms on, 100 ms off.
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 0));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 99));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 100));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 199));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 200));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 299));
    // 5 Hz means 5 on-pulses per second.
    int pulses = 0;
    bool prev = false;
    for (uint32_t t = 0; t < 1000; ++t) {
        bool on = ledOnAt(LedMode::Failed, t);
        if (on && !prev) ++pulses;
        prev = on;
    }
    TEST_ASSERT_EQUAL_INT(5, pulses);
}

static void test_apmode_is_heartbeat(void) {
    // 60 ms on, 100 ms off, 60 ms on, then off until 1600 ms.
    TEST_ASSERT_TRUE(ledOnAt(LedMode::ApMode, 0));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::ApMode, 59));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 60));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 159));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::ApMode, 160));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::ApMode, 219));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 220));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 800));   // long off period
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 1599));
    // Period restarts.
    TEST_ASSERT_TRUE(ledOnAt(LedMode::ApMode, 1600));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::ApMode, 1659));
}

static void test_uploading_is_short_flash_per_second(void) {
    // 50 ms flash at the top of every 1 s period.
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Uploading, 0));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Uploading, 49));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Uploading, 50));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Uploading, 999));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Uploading, 1000));
    // Exactly one pulse per 1000 ms window.
    int pulses = 0;
    bool prev = false;
    for (uint32_t t = 0; t < 5000; ++t) {
        bool on = ledOnAt(LedMode::Uploading, t);
        if (on && !prev) ++pulses;
        prev = on;
    }
    TEST_ASSERT_EQUAL_INT(5, pulses);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_off_is_always_off);
    RUN_TEST(test_connected_is_always_on);
    RUN_TEST(test_connecting_is_1hz_50pct_duty);
    RUN_TEST(test_failed_is_5hz);
    RUN_TEST(test_apmode_is_heartbeat);
    RUN_TEST(test_uploading_is_short_flash_per_second);
    return UNITY_END();
}

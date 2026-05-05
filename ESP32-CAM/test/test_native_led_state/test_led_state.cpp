// Native (host) unit tests for hf::ledOnAt.
//
// The on-board flash LED is the camera flash — bright enough to light a
// small room — so every pattern is designed to fire briefly and stay
// silent the rest of the time. These tests pin those guarantees:
//
//   * Steady-state modes (Off / ApMode / Connecting / Connected) MUST
//     never turn the LED on. The user complaint that landed this design
//     was a flashlight in their face during AP heartbeat.
//   * Failed must produce exactly three pulses, then stay off forever.
//   * Uploading must produce exactly one pulse, then stay off forever.
//
// All inputs are the "elapsed milliseconds since ledSetMode was called".

#include <unity.h>

#include "led_state.h"

using hf::LedMode;
using hf::ledOnAt;

void setUp() {}
void tearDown() {}

// --- Silent steady-state modes -------------------------------------------

static void test_off_is_always_off(void) {
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Off, 0));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Off, 100));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Off, 9999999));
}

static void test_apmode_is_always_off(void) {
    // Used to be a heartbeat; deliberately silenced.
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 0));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 50));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 1000));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::ApMode, 9999999));
}

static void test_connecting_is_always_off(void) {
    // Used to be a 1 Hz blink; silenced.
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connecting, 0));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connecting, 250));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connecting, 30000));
}

static void test_connected_is_always_off(void) {
    // Used to be solid-on; silenced. This is the user's primary complaint
    // — Connected was a literal flashlight pointed at them.
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connected, 0));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connected, 12345));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Connected, 9999999));
}

// --- Failed: three pulses then off ---------------------------------------

static void test_failed_pulse_1_at_start(void) {
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 0));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 49));
}

static void test_failed_off_between_1_and_2(void) {
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 50));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 199));
}

static void test_failed_pulse_2(void) {
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 200));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 249));
}

static void test_failed_off_between_2_and_3(void) {
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 250));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 399));
}

static void test_failed_pulse_3(void) {
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 400));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Failed, 449));
}

static void test_failed_off_after_pattern(void) {
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 450));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 1000));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 60000));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Failed, 9999999));
}

static void test_failed_pulse_count_is_exactly_three(void) {
    // Walk every millisecond of the first second and count rising edges.
    int pulses = 0;
    bool prev = false;
    for (uint32_t t = 0; t < 1000; ++t) {
        bool on = ledOnAt(LedMode::Failed, t);
        if (on && !prev) ++pulses;
        prev = on;
    }
    TEST_ASSERT_EQUAL_INT(3, pulses);
}

// --- Uploading: single pulse then off ------------------------------------

static void test_uploading_single_pulse_at_start(void) {
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Uploading, 0));
    TEST_ASSERT_TRUE(ledOnAt(LedMode::Uploading, 49));
}

static void test_uploading_off_after_pulse(void) {
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Uploading, 50));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Uploading, 1000));
    TEST_ASSERT_FALSE(ledOnAt(LedMode::Uploading, 9999999));
}

static void test_uploading_pulse_count_is_exactly_one(void) {
    int pulses = 0;
    bool prev = false;
    for (uint32_t t = 0; t < 5000; ++t) {
        bool on = ledOnAt(LedMode::Uploading, t);
        if (on && !prev) ++pulses;
        prev = on;
    }
    TEST_ASSERT_EQUAL_INT(1, pulses);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_off_is_always_off);
    RUN_TEST(test_apmode_is_always_off);
    RUN_TEST(test_connecting_is_always_off);
    RUN_TEST(test_connected_is_always_off);
    RUN_TEST(test_failed_pulse_1_at_start);
    RUN_TEST(test_failed_off_between_1_and_2);
    RUN_TEST(test_failed_pulse_2);
    RUN_TEST(test_failed_off_between_2_and_3);
    RUN_TEST(test_failed_pulse_3);
    RUN_TEST(test_failed_off_after_pattern);
    RUN_TEST(test_failed_pulse_count_is_exactly_three);
    RUN_TEST(test_uploading_single_pulse_at_start);
    RUN_TEST(test_uploading_off_after_pulse);
    RUN_TEST(test_uploading_pulse_count_is_exactly_one);
    return UNITY_END();
}

// Native (host) unit tests for hf::HttpCodeRing and hf::ReconnectCounter.
//
// These pin the chronological-order contract that the telemetry JSON
// payload depends on, plus the negative-sentinel passthrough that lets
// the field operator distinguish camera failures (-1) from connect
// failures (-2) from body-write failures (-3) from invalid HTTP
// responses (-4) when looking at logged uploads after the fact.

#include <unity.h>

#include "metrics.h"

using hf::HttpCodeRing;
using hf::ReconnectCounter;

void setUp() {}
void tearDown() {}

// --- HttpCodeRing ---------------------------------------------------------

static void test_initial_snapshot_is_empty(void) {
    int storage[4];
    HttpCodeRing ring(storage, 4);
    auto s = ring.snapshot();
    TEST_ASSERT_EQUAL_UINT(0u, s.size());
    TEST_ASSERT_EQUAL_UINT(0u, ring.size());
    TEST_ASSERT_EQUAL_UINT(4u, ring.capacity());
}

static void test_notes_within_capacity(void) {
    int storage[4];
    HttpCodeRing ring(storage, 4);
    ring.note(200);
    ring.note(201);
    ring.note(404);
    auto s = ring.snapshot();
    TEST_ASSERT_EQUAL_UINT(3u, s.size());
    TEST_ASSERT_EQUAL_INT(200, s[0]);
    TEST_ASSERT_EQUAL_INT(201, s[1]);
    TEST_ASSERT_EQUAL_INT(404, s[2]);
}

static void test_full_capacity_no_wrap(void) {
    int storage[3];
    HttpCodeRing ring(storage, 3);
    ring.note(200);
    ring.note(404);
    ring.note(500);
    auto s = ring.snapshot();
    TEST_ASSERT_EQUAL_UINT(3u, s.size());
    TEST_ASSERT_EQUAL_INT(200, s[0]);
    TEST_ASSERT_EQUAL_INT(404, s[1]);
    TEST_ASSERT_EQUAL_INT(500, s[2]);
}

static void test_wraps_to_keep_last_N(void) {
    int storage[3];
    HttpCodeRing ring(storage, 3);
    ring.note(200);
    ring.note(201);
    ring.note(202);
    ring.note(404);  // overwrites 200; oldest is now 201
    auto s = ring.snapshot();
    TEST_ASSERT_EQUAL_UINT(3u, s.size());
    TEST_ASSERT_EQUAL_INT(201, s[0]);
    TEST_ASSERT_EQUAL_INT(202, s[1]);
    TEST_ASSERT_EQUAL_INT(404, s[2]);
}

static void test_wraps_multiple_times(void) {
    int storage[2];
    HttpCodeRing ring(storage, 2);
    for (int i = 1; i <= 10; ++i) ring.note(i);
    auto s = ring.snapshot();
    TEST_ASSERT_EQUAL_UINT(2u, s.size());
    TEST_ASSERT_EQUAL_INT(9, s[0]);
    TEST_ASSERT_EQUAL_INT(10, s[1]);
}

static void test_negative_sentinels_round_trip(void) {
    // Firmware uses these sentinels for pre-HTTP failures (client.cpp):
    //   -1 = camera fb_get failed
    //   -2 = client.connect failed
    //   -3 = body write failed mid-stream
    //   -4 = response missing or unparseable
    int storage[5];
    HttpCodeRing ring(storage, 5);
    ring.note(-1);
    ring.note(-2);
    ring.note(200);
    ring.note(-4);
    auto s = ring.snapshot();
    TEST_ASSERT_EQUAL_UINT(4u, s.size());
    TEST_ASSERT_EQUAL_INT(-1, s[0]);
    TEST_ASSERT_EQUAL_INT(-2, s[1]);
    TEST_ASSERT_EQUAL_INT(200, s[2]);
    TEST_ASSERT_EQUAL_INT(-4, s[3]);
}

static void test_zero_capacity_is_safe(void) {
    HttpCodeRing ring(nullptr, 0);
    ring.note(200);
    ring.note(404);
    TEST_ASSERT_EQUAL_UINT(0u, ring.snapshot().size());
    TEST_ASSERT_EQUAL_UINT(0u, ring.size());
}

static void test_size_caps_at_capacity(void) {
    int storage[3];
    HttpCodeRing ring(storage, 3);
    for (int i = 0; i < 10; ++i) ring.note(i);
    TEST_ASSERT_EQUAL_UINT(3u, ring.size());
}

// --- ReconnectCounter -----------------------------------------------------

static void test_reconnect_counter_starts_at_zero(void) {
    ReconnectCounter c;
    TEST_ASSERT_EQUAL_UINT32(0u, c.value());
}

static void test_reconnect_counter_increments(void) {
    ReconnectCounter c;
    c.increment();
    c.increment();
    c.increment();
    TEST_ASSERT_EQUAL_UINT32(3u, c.value());
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_initial_snapshot_is_empty);
    RUN_TEST(test_notes_within_capacity);
    RUN_TEST(test_full_capacity_no_wrap);
    RUN_TEST(test_wraps_to_keep_last_N);
    RUN_TEST(test_wraps_multiple_times);
    RUN_TEST(test_negative_sentinels_round_trip);
    RUN_TEST(test_zero_capacity_is_safe);
    RUN_TEST(test_size_caps_at_capacity);
    RUN_TEST(test_reconnect_counter_starts_at_zero);
    RUN_TEST(test_reconnect_counter_increments);
    return UNITY_END();
}

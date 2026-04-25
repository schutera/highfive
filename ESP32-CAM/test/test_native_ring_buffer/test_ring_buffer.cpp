// Native (host) unit tests for hf::RingBuffer.
//
// These tests pin the exact wrap-around semantics that the existing
// firmware's logbuf.cpp relies on: once the buffer fills, snapshot()
// must return the most recent `capacity` bytes in chronological order.
// A regression here would silently corrupt the telemetry log that ships
// with every image upload.

#include <unity.h>

#include <cstring>

#include "ring_buffer.h"

using hf::RingBuffer;

void setUp() {}
void tearDown() {}

// --- empty / construction -------------------------------------------------

static void test_initial_state_is_empty(void) {
    char buf[8];
    RingBuffer rb(buf, sizeof(buf));
    TEST_ASSERT_EQUAL_STRING("", rb.snapshot().c_str());
    TEST_ASSERT_FALSE(rb.wrapped());
    TEST_ASSERT_EQUAL_UINT(0u, rb.head());
}

static void test_zero_capacity_does_nothing(void) {
    char buf[1];
    RingBuffer rb(buf, 0);
    rb.append("abc", 3);
    TEST_ASSERT_EQUAL_STRING("", rb.snapshot().c_str());
    TEST_ASSERT_FALSE(rb.wrapped());
}

// --- happy path: append within capacity -----------------------------------

static void test_append_within_capacity(void) {
    char buf[8];
    RingBuffer rb(buf, sizeof(buf));
    rb.append("abc", 3);
    TEST_ASSERT_EQUAL_STRING("abc", rb.snapshot().c_str());
    TEST_ASSERT_FALSE(rb.wrapped());
    TEST_ASSERT_EQUAL_UINT(3u, rb.head());
}

static void test_multiple_appends_no_wrap(void) {
    char buf[10];
    RingBuffer rb(buf, sizeof(buf));
    rb.append("hello ", 6);
    rb.append("hi", 2);
    TEST_ASSERT_EQUAL_STRING("hello hi", rb.snapshot().c_str());
    TEST_ASSERT_FALSE(rb.wrapped());
}

// --- wrap-around behaviour ------------------------------------------------

static void test_append_exactly_to_capacity_wraps(void) {
    // Existing logbuf.cpp semantic: writing exactly `capacity` bytes leaves
    // head=0 and wrapped=true. snapshot() returns all bytes in order.
    char buf[4];
    RingBuffer rb(buf, sizeof(buf));
    rb.append("abcd", 4);
    TEST_ASSERT_TRUE(rb.wrapped());
    TEST_ASSERT_EQUAL_UINT(0u, rb.head());
    TEST_ASSERT_EQUAL_STRING("abcd", rb.snapshot().c_str());
}

static void test_append_wraps_once(void) {
    char buf[4];
    RingBuffer rb(buf, sizeof(buf));
    rb.append("abcde", 5);  // 'a' is overwritten; oldest is now 'b'
    TEST_ASSERT_TRUE(rb.wrapped());
    TEST_ASSERT_EQUAL_STRING("bcde", rb.snapshot().c_str());
}

static void test_append_far_beyond_capacity_keeps_last_N(void) {
    char buf[4];
    RingBuffer rb(buf, sizeof(buf));
    rb.append("0123456789", 10);
    TEST_ASSERT_TRUE(rb.wrapped());
    TEST_ASSERT_EQUAL_STRING("6789", rb.snapshot().c_str());
}

static void test_multiple_appends_with_wrap(void) {
    // Total written = 8 bytes into a 6-byte ring. Oldest 2 bytes ("ab")
    // are overwritten; snapshot reads from the new oldest ("c") forward.
    char buf[6];
    RingBuffer rb(buf, sizeof(buf));
    rb.append("abc", 3);
    rb.append("def", 3);
    rb.append("gh", 2);
    TEST_ASSERT_TRUE(rb.wrapped());
    TEST_ASSERT_EQUAL_STRING("cdefgh", rb.snapshot().c_str());
}

// --- defensive ------------------------------------------------------------

static void test_append_zero_bytes_is_noop(void) {
    char buf[4];
    RingBuffer rb(buf, sizeof(buf));
    rb.append("ab", 2);
    rb.append("", 0);
    rb.append(nullptr, 5);  // null data must not crash
    TEST_ASSERT_EQUAL_STRING("ab", rb.snapshot().c_str());
    TEST_ASSERT_EQUAL_UINT(2u, rb.head());
}

static void test_snapshot_preserves_embedded_nulls(void) {
    // logf() output is text but the buffer is byte-oriented; embedded
    // nulls must round-trip through snapshot().
    char buf[6];
    RingBuffer rb(buf, sizeof(buf));
    const char data[] = {'a', '\0', 'b', '\0', 'c'};
    rb.append(data, sizeof(data));
    auto s = rb.snapshot();
    TEST_ASSERT_EQUAL_UINT(5u, s.size());
    TEST_ASSERT_EQUAL_CHAR('a',  s[0]);
    TEST_ASSERT_EQUAL_CHAR('\0', s[1]);
    TEST_ASSERT_EQUAL_CHAR('b',  s[2]);
    TEST_ASSERT_EQUAL_CHAR('\0', s[3]);
    TEST_ASSERT_EQUAL_CHAR('c',  s[4]);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_initial_state_is_empty);
    RUN_TEST(test_zero_capacity_does_nothing);
    RUN_TEST(test_append_within_capacity);
    RUN_TEST(test_multiple_appends_no_wrap);
    RUN_TEST(test_append_exactly_to_capacity_wraps);
    RUN_TEST(test_append_wraps_once);
    RUN_TEST(test_append_far_beyond_capacity_keeps_last_N);
    RUN_TEST(test_multiple_appends_with_wrap);
    RUN_TEST(test_append_zero_bytes_is_noop);
    RUN_TEST(test_snapshot_preserves_embedded_nulls);
    return UNITY_END();
}

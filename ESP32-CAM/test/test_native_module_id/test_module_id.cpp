// Native (host) unit tests for hf::formatModuleId.
//
// Run with:  pio test -e native
//
// These tests pin the canonical HiveHive module-ID shape — exactly 12
// lowercase hex characters, no separators, no prefix — so the bug where
// String(uint64_t) on Arduino silently emitted a decimal stringification
// of the eFuse MAC cannot regress.

#include <unity.h>

#include <cctype>
#include <cstdint>
#include <string>

#include "module_id.h"

using hf::formatModuleId;

void setUp() {}
void tearDown() {}

// --- exact-value cases ----------------------------------------------------

static void test_typical_mac(void) {
    TEST_ASSERT_EQUAL_STRING("aabbccddeeff",
                             formatModuleId(0xAABBCCDDEEFFULL).c_str());
}

static void test_min_nonzero_mac(void) {
    TEST_ASSERT_EQUAL_STRING("000000000001",
                             formatModuleId(0x000000000001ULL).c_str());
}

static void test_zero_mac(void) {
    TEST_ASSERT_EQUAL_STRING("000000000000",
                             formatModuleId(0x000000000000ULL).c_str());
}

static void test_all_ones_mac(void) {
    TEST_ASSERT_EQUAL_STRING("ffffffffffff",
                             formatModuleId(0xFFFFFFFFFFFFULL).c_str());
}

static void test_high_bits_are_truncated(void) {
    // The eFuse MAC value is a uint64_t but only the lower 48 bits are the
    // MAC. Any high bits the SDK happens to set must not leak into the ID.
    // 0xDEAD in the upper 16 bits, AABBCCDDEEFF in the lower 48.
    TEST_ASSERT_EQUAL_STRING("aabbccddeeff",
                             formatModuleId(0xDEADAABBCCDDEEFFULL).c_str());
}

// --- shape invariants -----------------------------------------------------

static void test_length_is_always_12(void) {
    TEST_ASSERT_EQUAL_size_t(12, formatModuleId(0x0ULL).size());
    TEST_ASSERT_EQUAL_size_t(12, formatModuleId(0x1ULL).size());
    TEST_ASSERT_EQUAL_size_t(12, formatModuleId(0xAABBCCDDEEFFULL).size());
    TEST_ASSERT_EQUAL_size_t(12, formatModuleId(0xFFFFFFFFFFFFULL).size());
}

static void test_chars_are_lowercase_hex_only(void) {
    // Sweep a handful of values and assert every character is in [0-9a-f].
    const uint64_t samples[] = {
        0x000000000000ULL,
        0x0123456789abULL,
        0xFEDCBA987654ULL,
        0xAABBCCDDEEFFULL,
        0xFFFFFFFFFFFFULL,
    };
    for (uint64_t v : samples) {
        std::string id = formatModuleId(v);
        TEST_ASSERT_EQUAL_size_t(12, id.size());
        for (char c : id) {
            bool isDigit = (c >= '0' && c <= '9');
            bool isLowerHex = (c >= 'a' && c <= 'f');
            TEST_ASSERT_TRUE_MESSAGE(isDigit || isLowerHex,
                "module ID must be lowercase hex only");
        }
    }
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_typical_mac);
    RUN_TEST(test_min_nonzero_mac);
    RUN_TEST(test_zero_mac);
    RUN_TEST(test_all_ones_mac);
    RUN_TEST(test_high_bits_are_truncated);
    RUN_TEST(test_length_is_always_12);
    RUN_TEST(test_chars_are_lowercase_hex_only);
    return UNITY_END();
}

// Native (host) unit test for hf::wifiStatusName. The strings the helper
// returns end up in the serial log on every WiFi connect timeout, so the
// values that map to the most-common failure modes (1, 4, 6) need to
// stay stable. Drift would make field diagnostics confusing.

#include <unity.h>
#include <cstring>

#include "wifi_diag.h"

using hf::wifiStatusName;

void setUp() {}
void tearDown() {}

static void test_known_codes_map_to_names(void) {
    TEST_ASSERT_EQUAL_STRING("WL_NO_SHIELD",      wifiStatusName(255));
    TEST_ASSERT_EQUAL_STRING("WL_IDLE_STATUS",    wifiStatusName(0));
    TEST_ASSERT_EQUAL_STRING("WL_NO_SSID_AVAIL",  wifiStatusName(1));
    TEST_ASSERT_EQUAL_STRING("WL_SCAN_COMPLETED", wifiStatusName(2));
    TEST_ASSERT_EQUAL_STRING("WL_CONNECTED",      wifiStatusName(3));
    TEST_ASSERT_EQUAL_STRING("WL_CONNECT_FAILED", wifiStatusName(4));
    TEST_ASSERT_EQUAL_STRING("WL_CONNECTION_LOST", wifiStatusName(5));
    TEST_ASSERT_EQUAL_STRING("WL_DISCONNECTED",   wifiStatusName(6));
}

static void test_unknown_codes_fall_through(void) {
    TEST_ASSERT_EQUAL_STRING("WL_UNKNOWN", wifiStatusName(-1));
    TEST_ASSERT_EQUAL_STRING("WL_UNKNOWN", wifiStatusName(99));
    TEST_ASSERT_EQUAL_STRING("WL_UNKNOWN", wifiStatusName(7));
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_known_codes_map_to_names);
    RUN_TEST(test_unknown_codes_fall_through);
    return UNITY_END();
}

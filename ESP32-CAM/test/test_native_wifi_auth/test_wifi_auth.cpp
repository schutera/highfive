// Native (host) unit tests for hf::wifiAuthMode / hf::wifiIsEnterprise.
//
// Run with:  pio test -e native
//
// These tests pin the WPA2-Enterprise-vs-PSK decision that gates the
// onboarding WiFi join (issue #63). The branch is load-bearing: every
// module already deployed in the field connects to a personal (PSK)
// network with an empty username, so a regression that flipped the
// default to "enterprise" would brick the entire fleet's WiFi join. The
// `esp_wpa2` calls themselves touch the radio and are not host-testable;
// this decision is the part that can — and must — be pinned in CI.

#include <unity.h>

#include "wifi_auth.h"

using hf::WifiAuthMode;
using hf::wifiAuthMode;
using hf::wifiIsEnterprise;

void setUp() {}
void tearDown() {}

// --- The PSK / backward-compat path (the one that must not regress) ------

static void test_null_username_is_personal(void) {
    // A zero-initialized config struct can hand us a null pointer; treat
    // it as "no username" rather than dereferencing into undefined land.
    TEST_ASSERT_TRUE(wifiAuthMode(nullptr) == WifiAuthMode::PersonalOrOpen);
    TEST_ASSERT_FALSE(wifiIsEnterprise(nullptr));
}

static void test_empty_username_is_personal(void) {
    // The dominant case: every existing module + every existing config.json
    // has no username. This MUST stay on the legacy PSK path.
    TEST_ASSERT_TRUE(wifiAuthMode("") == WifiAuthMode::PersonalOrOpen);
    TEST_ASSERT_FALSE(wifiIsEnterprise(""));
}

static void test_whitespace_only_username_is_personal(void) {
    // A stray space typed into the optional portal field must not silently
    // flip a personal-WiFi user onto the enterprise path (which would then
    // fail to join). Whitespace-only is treated as "no username".
    TEST_ASSERT_TRUE(wifiAuthMode("   ") == WifiAuthMode::PersonalOrOpen);
    TEST_ASSERT_TRUE(wifiAuthMode("\t") == WifiAuthMode::PersonalOrOpen);
    TEST_ASSERT_TRUE(wifiAuthMode(" \t\r\n ") == WifiAuthMode::PersonalOrOpen);
}

// --- The enterprise path -------------------------------------------------

static void test_plain_username_is_enterprise(void) {
    TEST_ASSERT_TRUE(wifiAuthMode("alice") == WifiAuthMode::Enterprise);
    TEST_ASSERT_TRUE(wifiIsEnterprise("alice"));
}

static void test_realm_username_is_enterprise(void) {
    // The eduroam shape — user@institution.tld.
    TEST_ASSERT_TRUE(wifiAuthMode("alice@uni-example.de") == WifiAuthMode::Enterprise);
}

static void test_username_with_surrounding_whitespace_is_enterprise(void) {
    // Has real content, so it selects enterprise. The credential itself is
    // passed to the WiFi stack verbatim (no trim) — same as SSID/password —
    // which this test documents as intentional.
    TEST_ASSERT_TRUE(wifiAuthMode("  alice  ") == WifiAuthMode::Enterprise);
}

static void test_single_non_whitespace_char_is_enterprise(void) {
    // Boundary: one real character is enough.
    TEST_ASSERT_TRUE(wifiAuthMode("x") == WifiAuthMode::Enterprise);
}

int main(int, char**) {
    UNITY_BEGIN();

    RUN_TEST(test_null_username_is_personal);
    RUN_TEST(test_empty_username_is_personal);
    RUN_TEST(test_whitespace_only_username_is_personal);

    RUN_TEST(test_plain_username_is_enterprise);
    RUN_TEST(test_realm_username_is_enterprise);
    RUN_TEST(test_username_with_surrounding_whitespace_is_enterprise);
    RUN_TEST(test_single_non_whitespace_char_is_enterprise);

    return UNITY_END();
}

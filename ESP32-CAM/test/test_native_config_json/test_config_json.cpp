// Native (host) unit tests for the pure /config.json read-modify-write helpers
// (issue #156, lib/config_json).
//
// Run with:  pio test -e native
//
// These are the host-testable core that host.cpp::saveConfig and
// esp_init.cpp's writeServerUrlsToConfig/clearServerUrlsFromConfig delegate to.
// The headline regression (R1): a Wi-Fi save must NOT drop an out-of-band
// INIT_URL/UPLOAD_URL an operator set via the serial console — the pre-#156
// saveConfig rebuilt the document from scratch and silently lost them.

#include <unity.h>

#include <string>

#include <ArduinoJson.h>

#include "config_json.h"

using hf::clearServerUrlsInConfigJson;
using hf::setServerUrlsInConfigJson;
using hf::setWifiCredsInConfigJson;

void setUp() {}
void tearDown() {}

// Helper: parse `json` and return NETWORK[key] (or "" / sentinel if absent).
static std::string field(const std::string &json, const char *key) {
    StaticJsonDocument<1024> doc;
    DeserializationError err = deserializeJson(doc, json);
    if (err) return std::string("<parse-error>");
    const char *v = doc["NETWORK"][key] | "<absent>";
    return std::string(v);
}

// --- setWifiCredsInConfigJson --------------------------------------------

static void test_wifi_on_empty_input_creates_config(void) {
    std::string out = setWifiCredsInConfigJson("", "MyNet", "secret");
    TEST_ASSERT_EQUAL_STRING("MyNet", field(out, "SSID").c_str());
    TEST_ASSERT_EQUAL_STRING("secret", field(out, "PASSWORD").c_str());
}

// R1 — the headline regression: saving Wi-Fi credentials must preserve a
// pre-existing server-URL override.
static void test_wifi_save_preserves_existing_init_url(void) {
    const std::string existing =
        "{\"NETWORK\":{\"SSID\":\"old\",\"PASSWORD\":\"oldpw\","
        "\"INIT_URL\":\"http://192.168.1.50:8002/new_module\","
        "\"UPLOAD_URL\":\"http://192.168.1.50:8000/upload\"}}";
    std::string out = setWifiCredsInConfigJson(existing, "newnet", "newpw");
    // Wi-Fi updated...
    TEST_ASSERT_EQUAL_STRING("newnet", field(out, "SSID").c_str());
    TEST_ASSERT_EQUAL_STRING("newpw", field(out, "PASSWORD").c_str());
    // ...but the out-of-band URLs survive.
    TEST_ASSERT_EQUAL_STRING("http://192.168.1.50:8002/new_module",
                             field(out, "INIT_URL").c_str());
    TEST_ASSERT_EQUAL_STRING("http://192.168.1.50:8000/upload",
                             field(out, "UPLOAD_URL").c_str());
}

static void test_wifi_save_preserves_module_name(void) {
    const std::string existing =
        "{\"NETWORK\":{\"SSID\":\"old\",\"PASSWORD\":\"pw\",\"MODULE_NAME\":\"bee-7\"}}";
    std::string out = setWifiCredsInConfigJson(existing, "n", "p");
    TEST_ASSERT_EQUAL_STRING("bee-7", field(out, "MODULE_NAME").c_str());
}

static void test_wifi_save_on_corrupt_input_rebuilds_fresh(void) {
    // Corrupt-but-present file: setWifiCreds rebuilds rather than refusing, so
    // first-time/recovery onboarding still succeeds.
    std::string out = setWifiCredsInConfigJson("}{ not json", "n", "p");
    TEST_ASSERT_EQUAL_STRING("n", field(out, "SSID").c_str());
    TEST_ASSERT_EQUAL_STRING("p", field(out, "PASSWORD").c_str());
}

// --- setServerUrlsInConfigJson -------------------------------------------

static void test_set_urls_preserves_wifi(void) {
    const std::string existing =
        "{\"NETWORK\":{\"SSID\":\"home\",\"PASSWORD\":\"pw\"}}";
    std::string out = setServerUrlsInConfigJson(
        existing, "http://10.0.0.5:8002/new_module", "http://10.0.0.5:8000/upload");
    TEST_ASSERT_EQUAL_STRING("home", field(out, "SSID").c_str());
    TEST_ASSERT_EQUAL_STRING("pw", field(out, "PASSWORD").c_str());
    TEST_ASSERT_EQUAL_STRING("http://10.0.0.5:8002/new_module",
                             field(out, "INIT_URL").c_str());
    TEST_ASSERT_EQUAL_STRING("http://10.0.0.5:8000/upload",
                             field(out, "UPLOAD_URL").c_str());
}

static void test_set_urls_overwrites_previous_override(void) {
    const std::string existing =
        "{\"NETWORK\":{\"SSID\":\"home\",\"PASSWORD\":\"pw\","
        "\"INIT_URL\":\"http://old:8002/new_module\"}}";
    std::string out = setServerUrlsInConfigJson(
        existing, "http://new:8002/new_module", "http://new:8000/upload");
    TEST_ASSERT_EQUAL_STRING("http://new:8002/new_module",
                             field(out, "INIT_URL").c_str());
}

static void test_set_urls_refuses_to_clobber_corrupt(void) {
    // A genuine parse error on a non-empty file must NOT be clobbered.
    std::string out = setServerUrlsInConfigJson("}{ not json", "a", "b");
    TEST_ASSERT_EQUAL_STRING("", out.c_str());
}

// --- clearServerUrlsInConfigJson -----------------------------------------

static void test_clear_removes_urls_keeps_wifi(void) {
    const std::string existing =
        "{\"NETWORK\":{\"SSID\":\"home\",\"PASSWORD\":\"pw\","
        "\"INIT_URL\":\"http://x:8002/new_module\","
        "\"UPLOAD_URL\":\"http://x:8000/upload\"}}";
    std::string out = clearServerUrlsInConfigJson(existing);
    TEST_ASSERT_EQUAL_STRING("home", field(out, "SSID").c_str());
    TEST_ASSERT_EQUAL_STRING("<absent>", field(out, "INIT_URL").c_str());
    TEST_ASSERT_EQUAL_STRING("<absent>", field(out, "UPLOAD_URL").c_str());
}

static void test_clear_on_config_without_urls_is_noop(void) {
    const std::string existing =
        "{\"NETWORK\":{\"SSID\":\"home\",\"PASSWORD\":\"pw\"}}";
    std::string out = clearServerUrlsInConfigJson(existing);
    TEST_ASSERT_EQUAL_STRING("home", field(out, "SSID").c_str());
    TEST_ASSERT_EQUAL_STRING("<absent>", field(out, "INIT_URL").c_str());
}

int main(int, char **) {
    UNITY_BEGIN();

    RUN_TEST(test_wifi_on_empty_input_creates_config);
    RUN_TEST(test_wifi_save_preserves_existing_init_url);
    RUN_TEST(test_wifi_save_preserves_module_name);
    RUN_TEST(test_wifi_save_on_corrupt_input_rebuilds_fresh);

    RUN_TEST(test_set_urls_preserves_wifi);
    RUN_TEST(test_set_urls_overwrites_previous_override);
    RUN_TEST(test_set_urls_refuses_to_clobber_corrupt);

    RUN_TEST(test_clear_removes_urls_keeps_wifi);
    RUN_TEST(test_clear_on_config_without_urls_is_noop);

    return UNITY_END();
}

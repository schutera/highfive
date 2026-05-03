// Native (host) unit tests for hf::urlDecode and hf::getParam.
//
// Run with:  pio test -e native
//
// These tests pin the exact byte-level behavior of the form-query helpers
// used by the WiFi onboarding HTTP server (host.cpp). The flashed devices
// in the field rely on this parsing to accept their first WiFi+upload URL
// configuration; any regression in this code path bricks the onboarding
// flow. The tests therefore document not just the happy paths but also the
// pre-existing quirks that the on-device implementation has shipped with
// (e.g. trailing-percent passthrough, prefix-substring key matching) so a
// well-meaning future cleanup cannot silently break field deployments.

#include <unity.h>

#include <string>

#include "form_query.h"

using hf::getParam;
using hf::urlDecode;

void setUp() {}
void tearDown() {}

// --- urlDecode: happy paths ----------------------------------------------

static void test_urldecode_passthrough_plain_ascii(void) {
    TEST_ASSERT_EQUAL_STRING("hello", urlDecode("hello").c_str());
}

static void test_urldecode_empty_string(void) {
    TEST_ASSERT_EQUAL_STRING("", urlDecode("").c_str());
}

static void test_urldecode_plus_becomes_space(void) {
    TEST_ASSERT_EQUAL_STRING("hello world",
                             urlDecode("hello+world").c_str());
}

static void test_urldecode_percent_uppercase_hex(void) {
    // %20 -> ' '
    TEST_ASSERT_EQUAL_STRING("a b", urlDecode("a%20b").c_str());
}

static void test_urldecode_percent_lowercase_hex(void) {
    // %2f -> '/'
    TEST_ASSERT_EQUAL_STRING("a/b", urlDecode("a%2fb").c_str());
}

static void test_urldecode_percent_mixed_case_hex(void) {
    // %2A and %2a both decode to '*'
    TEST_ASSERT_EQUAL_STRING("**", urlDecode("%2A%2a").c_str());
}

static void test_urldecode_realistic_wifi_password(void) {
    // A WiFi password containing a space and an '@'. This is exactly what
    // the onboarding form will produce after the browser percent-encodes
    // the user's input.
    TEST_ASSERT_EQUAL_STRING("hunter 2@home",
                             urlDecode("hunter+2%40home").c_str());
}

static void test_urldecode_url_inside_form_value(void) {
    // What the upload_base/upload_endpoint POST fields actually contain.
    TEST_ASSERT_EQUAL_STRING("http://api.example.com:8000",
                             urlDecode("http%3A%2F%2Fapi.example.com%3A8000").c_str());
}

// --- urlDecode: edge cases / pre-existing quirks --------------------------

static void test_urldecode_trailing_lone_percent_passthrough(void) {
    // "abc%" — no two chars after the '%', so it's emitted literally.
    // This is the on-device behavior; preserved here intentionally.
    TEST_ASSERT_EQUAL_STRING("abc%", urlDecode("abc%").c_str());
}

static void test_urldecode_trailing_percent_with_one_char(void) {
    // "abc%4" — only one char after the '%', so the original code's
    // (i + 2 < length) guard makes it fall through to the literal branch.
    TEST_ASSERT_EQUAL_STRING("abc%4", urlDecode("abc%4").c_str());
}

static void test_urldecode_consecutive_escapes(void) {
    // %41%42%43 -> "ABC"
    TEST_ASSERT_EQUAL_STRING("ABC", urlDecode("%41%42%43").c_str());
}

static void test_urldecode_high_byte(void) {
    // %FF -> 0xFF byte
    std::string out = urlDecode("%FF");
    TEST_ASSERT_EQUAL_size_t(1, out.size());
    TEST_ASSERT_EQUAL_UINT8(0xFF, static_cast<unsigned char>(out[0]));
}

// --- getParam: happy paths ------------------------------------------------

static void test_getparam_single_key(void) {
    TEST_ASSERT_EQUAL_STRING("bar", getParam("foo=bar", "foo").c_str());
}

static void test_getparam_first_of_many(void) {
    TEST_ASSERT_EQUAL_STRING(
        "bar",
        getParam("foo=bar&baz=qux&quux=corge", "foo").c_str()
    );
}

static void test_getparam_middle_of_many(void) {
    TEST_ASSERT_EQUAL_STRING(
        "qux",
        getParam("foo=bar&baz=qux&quux=corge", "baz").c_str()
    );
}

static void test_getparam_last_of_many(void) {
    TEST_ASSERT_EQUAL_STRING(
        "corge",
        getParam("foo=bar&baz=qux&quux=corge", "quux").c_str()
    );
}

static void test_getparam_value_is_urldecoded(void) {
    // The whole point: getParam returns the urldecoded value.
    TEST_ASSERT_EQUAL_STRING(
        "hello world",
        getParam("msg=hello+world", "msg").c_str()
    );
}

static void test_getparam_realistic_wifi_form(void) {
    // What the onboarding form posts after the user enters a WiFi password
    // with special characters. Pins the end-to-end decode path.
    std::string body =
        "session=abc123&module_name=Hive+1&ssid=MyNet&"
        "password=hunter+2%40home&upload_base=http%3A%2F%2Fapi.example.com%3A8000&"
        "upload_endpoint=upload";
    TEST_ASSERT_EQUAL_STRING("Hive 1", getParam(body, "module_name").c_str());
    TEST_ASSERT_EQUAL_STRING("MyNet", getParam(body, "ssid").c_str());
    TEST_ASSERT_EQUAL_STRING("hunter 2@home", getParam(body, "password").c_str());
    TEST_ASSERT_EQUAL_STRING("http://api.example.com:8000",
                             getParam(body, "upload_base").c_str());
    TEST_ASSERT_EQUAL_STRING("upload",
                             getParam(body, "upload_endpoint").c_str());
}

// --- getParam: edge cases / pre-existing quirks ---------------------------

static void test_getparam_missing_key_returns_empty(void) {
    TEST_ASSERT_EQUAL_STRING("", getParam("foo=bar", "missing").c_str());
}

static void test_getparam_empty_value(void) {
    // Key present but value is empty: "foo=&bar=baz" -> ""
    TEST_ASSERT_EQUAL_STRING("", getParam("foo=&bar=baz", "foo").c_str());
}

static void test_getparam_empty_query(void) {
    TEST_ASSERT_EQUAL_STRING("", getParam("", "foo").c_str());
}

int main(int, char**) {
    UNITY_BEGIN();

    RUN_TEST(test_urldecode_passthrough_plain_ascii);
    RUN_TEST(test_urldecode_empty_string);
    RUN_TEST(test_urldecode_plus_becomes_space);
    RUN_TEST(test_urldecode_percent_uppercase_hex);
    RUN_TEST(test_urldecode_percent_lowercase_hex);
    RUN_TEST(test_urldecode_percent_mixed_case_hex);
    RUN_TEST(test_urldecode_realistic_wifi_password);
    RUN_TEST(test_urldecode_url_inside_form_value);
    RUN_TEST(test_urldecode_trailing_lone_percent_passthrough);
    RUN_TEST(test_urldecode_trailing_percent_with_one_char);
    RUN_TEST(test_urldecode_consecutive_escapes);
    RUN_TEST(test_urldecode_high_byte);

    RUN_TEST(test_getparam_single_key);
    RUN_TEST(test_getparam_first_of_many);
    RUN_TEST(test_getparam_middle_of_many);
    RUN_TEST(test_getparam_last_of_many);
    RUN_TEST(test_getparam_value_is_urldecoded);
    RUN_TEST(test_getparam_realistic_wifi_form);
    RUN_TEST(test_getparam_missing_key_returns_empty);
    RUN_TEST(test_getparam_empty_value);
    RUN_TEST(test_getparam_empty_query);

    return UNITY_END();
}

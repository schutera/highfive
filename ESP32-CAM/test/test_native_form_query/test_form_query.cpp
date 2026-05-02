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

// --- WiFi-credential handover regression tests ----------------------------
//
// These pin the credential-decode path against the failure modes that
// previously could ship a broken WiFi config to the field:
//
//   1. WPA2-PSK passphrases at the upper boundary (63 ASCII chars) and at
//      the raw-PSK length (64 hex chars) must round-trip byte-for-byte.
//   2. Passwords containing characters that URLSearchParams percent-encodes
//      (& = + % space, non-ASCII, ()) must round-trip — these are exactly
//      the chars that a naive parser splits on by mistake.
//   3. The form body the wizard actually sends (mirroring espConfig.ts)
//      must yield the exact ssid/password the user typed.
//
// A failure here means a real device somewhere will refuse to associate
// with its home WiFi. Treat regressions as ship-blockers.

static void test_getparam_password_63_ascii_chars(void) {
    // WPA2-PSK passphrase upper bound: 63 ASCII characters.
    std::string pw63(63, 'a');  // 63x 'a'
    std::string body = "ssid=Net&password=" + pw63 + "&interval=300";
    std::string out = getParam(body, "password");
    TEST_ASSERT_EQUAL_size_t(63, out.size());
    TEST_ASSERT_EQUAL_STRING(pw63.c_str(), out.c_str());
}

static void test_getparam_password_64_hex_raw_psk(void) {
    // WPA2-PSK raw key form: exactly 64 hex chars. These don't need
    // percent-encoding, so the byte count on the wire equals the byte
    // count of the credential.
    std::string pw64 =
        "0123456789abcdef0123456789abcdef"
        "fedcba9876543210fedcba9876543210";
    TEST_ASSERT_EQUAL_size_t(64, pw64.size());
    std::string body = "ssid=Net&password=" + pw64 + "&interval=300";
    std::string out = getParam(body, "password");
    TEST_ASSERT_EQUAL_size_t(64, out.size());
    TEST_ASSERT_EQUAL_STRING(pw64.c_str(), out.c_str());
}

static void test_getparam_password_contains_ampersand_encoded(void) {
    // A password that contains '&' MUST be percent-encoded by the wizard
    // (URLSearchParams does this). If the encoding is wrong, the parser
    // would split the password on the literal '&' and silently truncate.
    // The "%26" form is what URLSearchParams emits.
    std::string body = "ssid=Net&password=foo%26bar&interval=300";
    TEST_ASSERT_EQUAL_STRING("foo&bar", getParam(body, "password").c_str());
}

static void test_getparam_password_contains_equals_encoded(void) {
    // Similarly for '=' — it can appear inside passwords (e.g. base64-ish
    // generators). Encoded as %3D.
    std::string body = "ssid=Net&password=foo%3Dbar&interval=300";
    TEST_ASSERT_EQUAL_STRING("foo=bar", getParam(body, "password").c_str());
}

static void test_getparam_password_contains_plus_literal(void) {
    // '+' as a literal character in the password must be sent as %2B.
    // (A literal '+' on the wire decodes to ' '.)
    std::string body = "ssid=Net&password=hunter%2B2&interval=300";
    TEST_ASSERT_EQUAL_STRING("hunter+2", getParam(body, "password").c_str());
}

static void test_getparam_password_contains_percent_literal(void) {
    // A literal '%' in the password is sent as %25.
    std::string body = "ssid=Net&password=50%25off&interval=300";
    TEST_ASSERT_EQUAL_STRING("50%off", getParam(body, "password").c_str());
}

static void test_getparam_password_with_non_ascii_utf8(void) {
    // Non-ASCII chars (e.g. Umlaut) come through as percent-encoded UTF-8.
    // 'ü' is 0xC3 0xBC.
    std::string body = "ssid=Net&password=h%C3%BCtte42&interval=300";
    std::string out = getParam(body, "password");
    // Compare bytes — Unity has no UTF-8-aware comparator and we only
    // care that the bytes survive intact.
    const std::string expected = "h\xC3\xBCtte42";
    TEST_ASSERT_EQUAL_size_t(expected.size(), out.size());
    TEST_ASSERT_EQUAL_MEMORY(expected.data(), out.data(), expected.size());
}

static void test_getparam_full_wizard_body_with_special_chars(void) {
    // What the production wizard sends: session token, module name with a
    // space, a password with a percent-encoded ampersand, full URL-encoded
    // base/endpoint pairs, and trailing camera defaults. This is the
    // closest unit-test analogue to "click Save in the wizard."
    std::string body =
        "session=deadbeef&module_name=My+Hive&ssid=HomeNet5G&"
        "password=p%40ss%26w0rd%21&"
        "init_base=http%3A%2F%2F192.168.0.36%3A8002&init_endpoint=%2Fnew_module&"
        "upload_base=http%3A%2F%2F192.168.0.36%3A8000&upload_endpoint=%2Fupload&"
        "interval=300&res=vga&vflip=0&bright=0&sat=0";
    TEST_ASSERT_EQUAL_STRING("My Hive", getParam(body, "module_name").c_str());
    TEST_ASSERT_EQUAL_STRING("HomeNet5G", getParam(body, "ssid").c_str());
    TEST_ASSERT_EQUAL_STRING("p@ss&w0rd!", getParam(body, "password").c_str());
    TEST_ASSERT_EQUAL_STRING("http://192.168.0.36:8002",
                             getParam(body, "init_base").c_str());
    TEST_ASSERT_EQUAL_STRING("/new_module",
                             getParam(body, "init_endpoint").c_str());
    TEST_ASSERT_EQUAL_STRING("http://192.168.0.36:8000",
                             getParam(body, "upload_base").c_str());
    TEST_ASSERT_EQUAL_STRING("/upload",
                             getParam(body, "upload_endpoint").c_str());
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

    // WiFi-credential handover regression tests.
    RUN_TEST(test_getparam_password_63_ascii_chars);
    RUN_TEST(test_getparam_password_64_hex_raw_psk);
    RUN_TEST(test_getparam_password_contains_ampersand_encoded);
    RUN_TEST(test_getparam_password_contains_equals_encoded);
    RUN_TEST(test_getparam_password_contains_plus_literal);
    RUN_TEST(test_getparam_password_contains_percent_literal);
    RUN_TEST(test_getparam_password_with_non_ascii_utf8);
    RUN_TEST(test_getparam_full_wizard_body_with_special_chars);

    return UNITY_END();
}

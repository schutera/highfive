// Native (host) unit tests for hf::urlDecode, hf::getParam, and
// hf::resolveKeepCurrentField.
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
using hf::isValidPortString;
using hf::joinUrlFromForm;
using hf::resolveKeepCurrentField;
using hf::rewriteLegacyHighfiveUrl;
using hf::splitUrlForForm;
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

// --- resolveKeepCurrentField ----------------------------------------------
//
// Pins the captive-portal /save "blank means keep current" contract for
// the password field (issue #46/#57). The HTML half tags the input with
// `data-keep-current-on-empty="1"` and the JS half skips validation when
// empty; this helper is the server-side third half. A regression that
// re-introduces unconditional assignment (or strips internal whitespace
// incorrectly) now fails CI rather than waiting for hardware testing.

static void test_resolvekeepcurrent_empty_submitted_returns_current(void) {
    TEST_ASSERT_EQUAL_STRING("old-secret",
        resolveKeepCurrentField("", "old-secret").c_str());
}

static void test_resolvekeepcurrent_whitespace_only_returns_current(void) {
    TEST_ASSERT_EQUAL_STRING("old-secret",
        resolveKeepCurrentField("   \t\n", "old-secret").c_str());
}

static void test_resolvekeepcurrent_nonempty_returns_trimmed_submitted(void) {
    TEST_ASSERT_EQUAL_STRING("hunter2",
        resolveKeepCurrentField("  hunter2  ", "old-secret").c_str());
}

static void test_resolvekeepcurrent_both_empty_returns_empty(void) {
    // First-boot path: no saved password, operator submits blank.
    TEST_ASSERT_EQUAL_STRING("",
        resolveKeepCurrentField("", "").c_str());
}

static void test_resolvekeepcurrent_nonempty_with_internal_whitespace_preserved(void) {
    // A WiFi password with internal spaces is legitimate; only leading
    // and trailing whitespace is trimmed.
    TEST_ASSERT_EQUAL_STRING("two words",
        resolveKeepCurrentField("  two words  ", "old").c_str());
}

// --- splitUrlForForm / joinUrlFromForm ------------------------------------
//
// Pins the captive-portal three-fields-per-URL contract introduced in
// issue #79. The captive portal renders three inputs per URL — base,
// port, endpoint — and the field shape itself is the contract: a
// regression that drops a field, mis-routes a value, or fails to
// roundtrip a URL through (split → render → submit → join) bricks the
// onboarding flow on any deployed module relying on the captive portal
// for re-onboarding.

static void test_split_production_https_url(void) {
    // The default the new firmware ships with — no explicit port.
    auto parts = splitUrlForForm("https://highfive.schutera.com/upload");
    TEST_ASSERT_EQUAL_STRING("https://highfive.schutera.com", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("upload", parts.endpoint.c_str());
}

static void test_split_lan_dev_url_with_explicit_port(void) {
    // The LAN-dev shape — explicit port, the form's whole point.
    auto parts = splitUrlForForm("http://192.168.0.36:8002/new_module");
    TEST_ASSERT_EQUAL_STRING("http://192.168.0.36", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("8002", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("new_module", parts.endpoint.c_str());
}

static void test_split_empty_input(void) {
    auto parts = splitUrlForForm("");
    TEST_ASSERT_EQUAL_STRING("", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.endpoint.c_str());
}

static void test_split_no_scheme_returns_all_empty(void) {
    // An operator typed a hostname without scheme. The form should
    // render blank fields rather than silently smearing the input
    // across the wrong fields — better that they see and fix it.
    auto parts = splitUrlForForm("highfive.schutera.com/upload");
    TEST_ASSERT_EQUAL_STRING("", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.endpoint.c_str());
}

static void test_split_no_path(void) {
    auto parts = splitUrlForForm("http://example.com");
    TEST_ASSERT_EQUAL_STRING("http://example.com", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.endpoint.c_str());
}

static void test_split_trailing_slash_no_endpoint(void) {
    auto parts = splitUrlForForm("http://example.com/");
    TEST_ASSERT_EQUAL_STRING("http://example.com", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.endpoint.c_str());
}

static void test_split_port_no_path(void) {
    auto parts = splitUrlForForm("http://example.com:8000");
    TEST_ASSERT_EQUAL_STRING("http://example.com", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("8000", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.endpoint.c_str());
}

static void test_split_multi_segment_endpoint(void) {
    // The path captures everything after the host(:port)/, including
    // additional slashes. Today's endpoints are single segments
    // (`upload`, `new_module`), but a future endpoint like `v1/upload`
    // should round-trip without surprise.
    auto parts = splitUrlForForm("https://example.com/api/v1/upload");
    TEST_ASSERT_EQUAL_STRING("https://example.com", parts.base.c_str());
    TEST_ASSERT_EQUAL_STRING("", parts.port.c_str());
    TEST_ASSERT_EQUAL_STRING("api/v1/upload", parts.endpoint.c_str());
}

static void test_join_production_https_omits_default_port(void) {
    // Operator types port "443" by hand on a https base — joinUrlFromForm
    // strips it so the saved URL matches the implicit form.
    TEST_ASSERT_EQUAL_STRING(
        "https://highfive.schutera.com/upload",
        joinUrlFromForm("https://highfive.schutera.com", "443", "upload").c_str());
}

static void test_join_lan_dev_keeps_explicit_port(void) {
    TEST_ASSERT_EQUAL_STRING(
        "http://192.168.0.36:8002/new_module",
        joinUrlFromForm("http://192.168.0.36", "8002", "new_module").c_str());
}

static void test_join_empty_port_omitted(void) {
    TEST_ASSERT_EQUAL_STRING(
        "https://highfive.schutera.com/upload",
        joinUrlFromForm("https://highfive.schutera.com", "", "upload").c_str());
}

static void test_join_strips_extra_slashes(void) {
    // Operator pastes "http://example.com/" + endpoint "/upload" —
    // joinUrlFromForm must not produce "http://example.com//upload".
    TEST_ASSERT_EQUAL_STRING(
        "http://example.com:8000/upload",
        joinUrlFromForm("http://example.com/", "8000", "/upload").c_str());
}

static void test_join_http_default_port_omitted(void) {
    TEST_ASSERT_EQUAL_STRING(
        "http://example.com/upload",
        joinUrlFromForm("http://example.com", "80", "upload").c_str());
}

static void test_join_empty_endpoint_no_trailing_slash(void) {
    // Empty endpoint should produce no trailing '/' — important so
    // round-trip stays a fixed point.
    TEST_ASSERT_EQUAL_STRING(
        "http://example.com:8080",
        joinUrlFromForm("http://example.com", "8080", "").c_str());
}

static void test_roundtrip_production(void) {
    const std::string original = "https://highfive.schutera.com/upload";
    auto parts = splitUrlForForm(original);
    TEST_ASSERT_EQUAL_STRING(
        original.c_str(),
        joinUrlFromForm(parts.base, parts.port, parts.endpoint).c_str());
}

static void test_roundtrip_lan_dev(void) {
    const std::string original = "http://192.168.0.36:8002/new_module";
    auto parts = splitUrlForForm(original);
    TEST_ASSERT_EQUAL_STRING(
        original.c_str(),
        joinUrlFromForm(parts.base, parts.port, parts.endpoint).c_str());
}

// --- rewriteLegacyHighfiveUrl ---------------------------------------------
//
// One-time http→https migration for SPIFFS configs written by pre-#79
// firmware. Idempotent. Targeted: only the literal
// `http://highfive.schutera.com` prefix is rewritten — LAN-dev URLs
// and hosts that merely contain the substring are left alone.

static void test_rewrite_legacy_upload(void) {
    TEST_ASSERT_EQUAL_STRING(
        "https://highfive.schutera.com/upload",
        rewriteLegacyHighfiveUrl("http://highfive.schutera.com/upload").c_str());
}

static void test_rewrite_legacy_new_module(void) {
    TEST_ASSERT_EQUAL_STRING(
        "https://highfive.schutera.com/new_module",
        rewriteLegacyHighfiveUrl("http://highfive.schutera.com/new_module").c_str());
}

static void test_rewrite_legacy_root_only(void) {
    TEST_ASSERT_EQUAL_STRING(
        "https://highfive.schutera.com",
        rewriteLegacyHighfiveUrl("http://highfive.schutera.com").c_str());
}

static void test_rewrite_already_https_unchanged(void) {
    const std::string already = "https://highfive.schutera.com/upload";
    TEST_ASSERT_EQUAL_STRING(already.c_str(),
                             rewriteLegacyHighfiveUrl(already).c_str());
}

static void test_rewrite_idempotent(void) {
    // The helper applied a second time must be a fixed point.
    const std::string once = rewriteLegacyHighfiveUrl(
        "http://highfive.schutera.com/upload");
    const std::string twice = rewriteLegacyHighfiveUrl(once);
    TEST_ASSERT_EQUAL_STRING(once.c_str(), twice.c_str());
}

static void test_rewrite_lan_dev_unchanged(void) {
    // Critical: LAN dev URLs must not be touched (no TLS available).
    const std::string lan = "http://192.168.0.36:8002/new_module";
    TEST_ASSERT_EQUAL_STRING(lan.c_str(),
                             rewriteLegacyHighfiveUrl(lan).c_str());
}

static void test_rewrite_substring_match_unchanged(void) {
    // The prefix match is anchored at byte 0; a URL that contains
    // the legacy host as a query argument or path component must
    // NOT be rewritten.
    const std::string proxied =
        "http://proxy.example.com/?upstream=highfive.schutera.com";
    TEST_ASSERT_EQUAL_STRING(proxied.c_str(),
                             rewriteLegacyHighfiveUrl(proxied).c_str());
}

static void test_rewrite_empty_unchanged(void) {
    TEST_ASSERT_EQUAL_STRING("", rewriteLegacyHighfiveUrl("").c_str());
}

static void test_rewrite_explicit_port_preserved(void) {
    // An operator who pasted "http://highfive.schutera.com:8080/upload"
    // (unusual but legal) gets the scheme flipped, port preserved.
    TEST_ASSERT_EQUAL_STRING(
        "https://highfive.schutera.com:8080/upload",
        rewriteLegacyHighfiveUrl("http://highfive.schutera.com:8080/upload").c_str());
}

// --- isValidPortString ----------------------------------------------------
//
// Server-side port validator (issue #79). The JS validator in the
// captive portal enforces the same rule, but a curl / JS-disabled
// submission must not bypass into SPIFFS. Tests pin the boundaries.

static void test_port_valid_empty(void) {
    // Empty = scheme default; production https URLs submit no port.
    TEST_ASSERT_TRUE(isValidPortString(""));
}

static void test_port_valid_low_boundary(void) {
    TEST_ASSERT_TRUE(isValidPortString("1"));
}

static void test_port_valid_typical_dev(void) {
    TEST_ASSERT_TRUE(isValidPortString("8000"));
    TEST_ASSERT_TRUE(isValidPortString("8002"));
}

static void test_port_valid_high_boundary(void) {
    TEST_ASSERT_TRUE(isValidPortString("65535"));
}

static void test_port_invalid_zero(void) {
    // Port 0 is reserved; not a legitimate operator choice.
    TEST_ASSERT_FALSE(isValidPortString("0"));
}

static void test_port_invalid_over_max(void) {
    TEST_ASSERT_FALSE(isValidPortString("65536"));
    TEST_ASSERT_FALSE(isValidPortString("99999"));
}

static void test_port_invalid_non_digit(void) {
    TEST_ASSERT_FALSE(isValidPortString("abc"));
    TEST_ASSERT_FALSE(isValidPortString("80a"));
    TEST_ASSERT_FALSE(isValidPortString("a80"));
}

static void test_port_invalid_negative(void) {
    TEST_ASSERT_FALSE(isValidPortString("-1"));
}

static void test_port_invalid_whitespace(void) {
    // Caller is expected to trim; a string that still has whitespace
    // after trim is operator error and we reject loudly.
    TEST_ASSERT_FALSE(isValidPortString(" 80"));
    TEST_ASSERT_FALSE(isValidPortString("80 "));
}

static void test_port_invalid_overflow_during_accumulation(void) {
    // Defense against integer overflow in a naive accumulator —
    // a very long digit string must not wrap and accidentally
    // produce an in-range value.
    TEST_ASSERT_FALSE(isValidPortString("9999999999999"));
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

    RUN_TEST(test_resolvekeepcurrent_empty_submitted_returns_current);
    RUN_TEST(test_resolvekeepcurrent_whitespace_only_returns_current);
    RUN_TEST(test_resolvekeepcurrent_nonempty_returns_trimmed_submitted);
    RUN_TEST(test_resolvekeepcurrent_both_empty_returns_empty);
    RUN_TEST(test_resolvekeepcurrent_nonempty_with_internal_whitespace_preserved);

    RUN_TEST(test_split_production_https_url);
    RUN_TEST(test_split_lan_dev_url_with_explicit_port);
    RUN_TEST(test_split_empty_input);
    RUN_TEST(test_split_no_scheme_returns_all_empty);
    RUN_TEST(test_split_no_path);
    RUN_TEST(test_split_trailing_slash_no_endpoint);
    RUN_TEST(test_split_port_no_path);
    RUN_TEST(test_split_multi_segment_endpoint);

    RUN_TEST(test_join_production_https_omits_default_port);
    RUN_TEST(test_join_lan_dev_keeps_explicit_port);
    RUN_TEST(test_join_empty_port_omitted);
    RUN_TEST(test_join_strips_extra_slashes);
    RUN_TEST(test_join_http_default_port_omitted);
    RUN_TEST(test_join_empty_endpoint_no_trailing_slash);
    RUN_TEST(test_roundtrip_production);
    RUN_TEST(test_roundtrip_lan_dev);

    RUN_TEST(test_rewrite_legacy_upload);
    RUN_TEST(test_rewrite_legacy_new_module);
    RUN_TEST(test_rewrite_legacy_root_only);
    RUN_TEST(test_rewrite_already_https_unchanged);
    RUN_TEST(test_rewrite_idempotent);
    RUN_TEST(test_rewrite_lan_dev_unchanged);
    RUN_TEST(test_rewrite_substring_match_unchanged);
    RUN_TEST(test_rewrite_empty_unchanged);
    RUN_TEST(test_rewrite_explicit_port_preserved);

    RUN_TEST(test_port_valid_empty);
    RUN_TEST(test_port_valid_low_boundary);
    RUN_TEST(test_port_valid_typical_dev);
    RUN_TEST(test_port_valid_high_boundary);
    RUN_TEST(test_port_invalid_zero);
    RUN_TEST(test_port_invalid_over_max);
    RUN_TEST(test_port_invalid_non_digit);
    RUN_TEST(test_port_invalid_negative);
    RUN_TEST(test_port_invalid_whitespace);
    RUN_TEST(test_port_invalid_overflow_during_accumulation);

    return UNITY_END();
}

// Native (host) unit tests for hf::shouldOtaUpdate and hf::parseOtaManifest.
//
// Run with:  pio test -e native
//
// Pins the wire-shape of the OTA manifest that build.sh writes into
// homepage/public/firmware.json. A drift between the build script's
// heredoc and the firmware's parser would silently break field OTA
// — these tests catch that.

#include <unity.h>

#include <cstdint>
#include <cstring>

#include "ota_version.h"

using hf::OtaManifest;
using hf::parseOtaManifest;
using hf::shouldOtaUpdate;

void setUp() {}
void tearDown() {}

// --- shouldOtaUpdate -------------------------------------------------------

static void test_should_update_returns_false_on_equal(void) {
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", "carpenter"));
}

static void test_should_update_returns_true_on_diff(void) {
    TEST_ASSERT_TRUE(shouldOtaUpdate("carpenter", "wallpaper"));
}

static void test_should_update_is_case_sensitive(void) {
    // Bee names are lowercase per ADR-006; case-mismatched manifest is a
    // drift signal, but treating it as "update" would re-flash on every
    // boot for no behaviour change. The conservative answer is "yes
    // they differ as strings, update" — operator can resolve drift.
    TEST_ASSERT_TRUE(shouldOtaUpdate("carpenter", "Carpenter"));
}

static void test_should_update_returns_false_on_null(void) {
    TEST_ASSERT_FALSE(shouldOtaUpdate(nullptr, "wallpaper"));
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", nullptr));
    TEST_ASSERT_FALSE(shouldOtaUpdate(nullptr, nullptr));
}

static void test_should_update_returns_false_on_empty(void) {
    TEST_ASSERT_FALSE(shouldOtaUpdate("", "wallpaper"));
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", ""));
}

// --- parseOtaManifest, happy path ------------------------------------------

static const char *kValidManifest =
    "{\"version\":\"wallpaper\",\"md5\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"built_at\":\"2026-05-13T10:00:00+00:00\","
    "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
    "\"app_size\":987654}";

static void test_parse_valid_manifest_populates_all_fields(void) {
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(kValidManifest, &m));
    TEST_ASSERT_EQUAL_STRING("wallpaper", m.version);
    TEST_ASSERT_EQUAL_STRING("0123456789abcdef0123456789abcdef", m.app_md5);
    TEST_ASSERT_EQUAL_UINT32(987654u, m.app_size);
}

static void test_parse_ignores_unrelated_top_level_fields(void) {
    // The web-installer consumer reads `md5` and `built_at`. Those must
    // not trip the OTA parser even if the version/app_md5/app_size
    // ordering or sibling-field set evolves.
    const char *json =
        "{\"built_at\":\"2026-05-13T10:00:00+00:00\","
        "\"app_size\":1024,"
        "\"version\":\"carpenter\","
        "\"md5\":\"ffffffffffffffffffffffffffffffff\","
        "\"app_md5\":\"deadbeefdeadbeefdeadbeefdeadbeef\"}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_EQUAL_STRING("carpenter", m.version);
    TEST_ASSERT_EQUAL_STRING("deadbeefdeadbeefdeadbeefdeadbeef", m.app_md5);
    TEST_ASSERT_EQUAL_UINT32(1024u, m.app_size);
}

// --- parseOtaManifest, malformed inputs ------------------------------------

static void test_parse_returns_false_on_null_inputs(void) {
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(nullptr, &m));
    TEST_ASSERT_FALSE(parseOtaManifest(kValidManifest, nullptr));
}

static void test_parse_returns_false_on_missing_version(void) {
    const char *json =
        "{\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_missing_app_md5(void) {
    const char *json =
        "{\"version\":\"wallpaper\",\"app_size\":1024}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_missing_app_size(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\"}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_short_md5(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef\","   // only 16 chars
        "\"app_size\":1024}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_uppercase_md5(void) {
    // Lowercase-hex shape is contractually pinned — `md5sum` always
    // emits lowercase, so an uppercase value signals manifest-corruption
    // or a generator drift the firmware shouldn't tolerate.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789ABCDEF0123456789abcdef\","
        "\"app_size\":1024}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_oversize_app(void) {
    // Anything larger than HF_OTA_MAX_APP_BYTES (1.9 MB) is rejected
    // before Update.begin() is reached on-device — manifest-side guard.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":9000000}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_zero_app_size(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":0}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_garbage_json(void) {
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest("not json at all", &m));
    TEST_ASSERT_FALSE(parseOtaManifest("", &m));
    TEST_ASSERT_FALSE(parseOtaManifest("{", &m));
}

static void test_parse_rejects_overlong_version(void) {
    // version[32] including NUL → 31 usable chars. A 40-char value
    // would either truncate (silent drift) or overflow (memory
    // corruption). The parser rejects rather than truncate so a
    // misconfigured manifest is loud, not silent.
    const char *json =
        "{\"version\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","  // 40 a's
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_does_not_false_match_substring_key(void) {
    // A field literally called "version_extra" must not match "version"
    // — the boundary search uses quote framing on both sides of the key.
    const char *json =
        "{\"version_extra\":\"ignored\","
        "\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_EQUAL_STRING("wallpaper", m.version);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_should_update_returns_false_on_equal);
    RUN_TEST(test_should_update_returns_true_on_diff);
    RUN_TEST(test_should_update_is_case_sensitive);
    RUN_TEST(test_should_update_returns_false_on_null);
    RUN_TEST(test_should_update_returns_false_on_empty);
    RUN_TEST(test_parse_valid_manifest_populates_all_fields);
    RUN_TEST(test_parse_ignores_unrelated_top_level_fields);
    RUN_TEST(test_parse_returns_false_on_null_inputs);
    RUN_TEST(test_parse_returns_false_on_missing_version);
    RUN_TEST(test_parse_returns_false_on_missing_app_md5);
    RUN_TEST(test_parse_returns_false_on_missing_app_size);
    RUN_TEST(test_parse_returns_false_on_short_md5);
    RUN_TEST(test_parse_returns_false_on_uppercase_md5);
    RUN_TEST(test_parse_returns_false_on_oversize_app);
    RUN_TEST(test_parse_returns_false_on_zero_app_size);
    RUN_TEST(test_parse_returns_false_on_garbage_json);
    RUN_TEST(test_parse_rejects_overlong_version);
    RUN_TEST(test_parse_does_not_false_match_substring_key);
    return UNITY_END();
}

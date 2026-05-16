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

// --- helpers --------------------------------------------------------------

static OtaManifest makeManifest(const char* version, uint32_t sequence,
                                bool allow_downgrade = false) {
    OtaManifest m{};
    std::strncpy(m.version, version, sizeof(m.version) - 1);
    std::strncpy(m.app_md5, "0123456789abcdef0123456789abcdef", sizeof(m.app_md5) - 1);
    m.app_size = 1024;
    m.sequence = sequence;
    m.allow_downgrade = allow_downgrade;
    return m;
}

// --- shouldOtaUpdate ------------------------------------------------------

static void test_should_update_returns_false_on_equal_version(void) {
    // Same version → no-op, regardless of sequence drift (a stale-but-same
    // manifest is not an OTA opportunity).
    OtaManifest m = makeManifest("carpenter", 5);
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", 5, m));
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", 1, m));
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", 99, m));
}

static void test_should_update_returns_true_on_higher_sequence(void) {
    // Different version AND higher sequence → the canonical upgrade.
    OtaManifest m = makeManifest("wallpaper", 6);
    TEST_ASSERT_TRUE(shouldOtaUpdate("carpenter", 5, m));
}

static void test_should_update_refuses_lower_sequence_no_flag(void) {
    // Different version, manifest sequence lower than running → the
    // downgrade-pingpong scenario from chapter-11. Without an explicit
    // `allow_downgrade: true` the firmware must refuse.
    OtaManifest m = makeManifest("leafcutter", 1);
    TEST_ASSERT_FALSE(shouldOtaUpdate("mason", 2, m));
}

static void test_should_update_refuses_equal_sequence_no_flag(void) {
    // A common operator mistake: ship a hot-fix binary under a new bee
    // name but forget to bump SEQUENCE. The new firmware refuses to
    // flash itself — loud-failure design.
    OtaManifest m = makeManifest("wallpaper", 5);
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", 5, m));
}

static void test_should_update_allows_lower_sequence_with_flag(void) {
    // Deliberate rollback wave: operator publishes the older binary
    // with allow_downgrade=true. New firmware honours the explicit
    // flag.
    OtaManifest m = makeManifest("leafcutter", 1, /*allow_downgrade=*/true);
    TEST_ASSERT_TRUE(shouldOtaUpdate("mason", 2, m));
}

static void test_should_update_allows_equal_sequence_with_flag(void) {
    // Edge case: rollback to the same-sequence sibling binary. Honour
    // the flag — operator knows what they're doing.
    OtaManifest m = makeManifest("wallpaper", 5, /*allow_downgrade=*/true);
    TEST_ASSERT_TRUE(shouldOtaUpdate("carpenter", 5, m));
}

static void test_should_update_is_case_sensitive(void) {
    // Bee names are lowercase per ADR-006; case-mismatched manifest is a
    // drift signal. Treating it as "update" requires the sequence to be
    // higher (or the flag set) — same rule as any other version change.
    OtaManifest m = makeManifest("Carpenter", 6);
    TEST_ASSERT_TRUE(shouldOtaUpdate("carpenter", 5, m));
    OtaManifest mEqualSeq = makeManifest("Carpenter", 5);
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", 5, mEqualSeq));
}

static void test_should_update_returns_false_on_null_current(void) {
    OtaManifest m = makeManifest("wallpaper", 6);
    TEST_ASSERT_FALSE(shouldOtaUpdate(nullptr, 5, m));
}

static void test_should_update_returns_false_on_empty_current(void) {
    OtaManifest m = makeManifest("wallpaper", 6);
    TEST_ASSERT_FALSE(shouldOtaUpdate("", 5, m));
}

static void test_should_update_returns_false_on_empty_manifest_version(void) {
    OtaManifest m = makeManifest("", 6);
    TEST_ASSERT_FALSE(shouldOtaUpdate("carpenter", 5, m));
}

// --- parseOtaManifest, happy path -----------------------------------------

static const char *kValidManifest =
    "{\"version\":\"wallpaper\",\"md5\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"built_at\":\"2026-05-13T10:00:00+00:00\","
    "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
    "\"app_size\":987654,"
    "\"sequence\":2,"
    "\"allow_downgrade\":false}";

static void test_parse_valid_manifest_populates_all_fields(void) {
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(kValidManifest, &m));
    TEST_ASSERT_EQUAL_STRING("wallpaper", m.version);
    TEST_ASSERT_EQUAL_STRING("0123456789abcdef0123456789abcdef", m.app_md5);
    TEST_ASSERT_EQUAL_UINT32(987654u, m.app_size);
    TEST_ASSERT_EQUAL_UINT32(2u, m.sequence);
    TEST_ASSERT_FALSE(m.allow_downgrade);
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
        "\"sequence\":3,"
        "\"app_md5\":\"deadbeefdeadbeefdeadbeefdeadbeef\"}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_EQUAL_STRING("carpenter", m.version);
    TEST_ASSERT_EQUAL_STRING("deadbeefdeadbeefdeadbeefdeadbeef", m.app_md5);
    TEST_ASSERT_EQUAL_UINT32(1024u, m.app_size);
    TEST_ASSERT_EQUAL_UINT32(3u, m.sequence);
}

// --- parseOtaManifest, malformed inputs -----------------------------------

static void test_parse_returns_false_on_null_inputs(void) {
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(nullptr, &m));
    TEST_ASSERT_FALSE(parseOtaManifest(kValidManifest, nullptr));
}

static void test_parse_returns_false_on_missing_version(void) {
    const char *json =
        "{\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024,\"sequence\":1}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_missing_app_md5(void) {
    const char *json =
        "{\"version\":\"wallpaper\",\"app_size\":1024,\"sequence\":1}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_missing_app_size(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"sequence\":1}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_requires_sequence_field(void) {
    // The migration gate: a sequence-less manifest is rejected so the
    // new firmware cannot silently fall back to pre-#83 strcmp
    // behaviour the moment an operator forgets to bump SEQUENCE.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_short_md5(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef\","   // only 16 chars
        "\"app_size\":1024,\"sequence\":1}";
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
        "\"app_size\":1024,\"sequence\":1}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_oversize_app(void) {
    // Anything larger than HF_OTA_MAX_APP_BYTES (1.9 MB) is rejected
    // before Update.begin() is reached on-device — manifest-side guard.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":9000000,\"sequence\":1}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_returns_false_on_zero_app_size(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":0,\"sequence\":1}";
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
        "\"app_size\":1024,\"sequence\":1}";
    OtaManifest m{};
    TEST_ASSERT_FALSE(parseOtaManifest(json, &m));
}

static void test_parse_rejects_negative_sequence(void) {
    // `sequence: -1` — parseUint32 sees the leading `-`, which isn't a
    // digit, and returns false. Loud-failure rather than silent
    // accept-as-uint-overflow.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024,\"sequence\":-1}";
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
        "\"app_size\":1024,\"sequence\":1}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_EQUAL_STRING("wallpaper", m.version);
}

// --- allow_downgrade parsing ----------------------------------------------

static void test_parse_allow_downgrade_literal_true(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024,\"sequence\":1,"
        "\"allow_downgrade\":true}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_TRUE(m.allow_downgrade);
}

static void test_parse_allow_downgrade_literal_false(void) {
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024,\"sequence\":1,"
        "\"allow_downgrade\":false}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_FALSE(m.allow_downgrade);
}

static void test_parse_allow_downgrade_absent_defaults_false(void) {
    OtaManifest m{};
    m.allow_downgrade = true;  // poison so a missed assignment is caught
    TEST_ASSERT_TRUE(parseOtaManifest(kValidManifest, &m));
    TEST_ASSERT_FALSE(m.allow_downgrade);
}

static void test_parse_allow_downgrade_garbage_defaults_false(void) {
    // Non-literal-true → false. A typo like `"allow_downgrade":1`
    // must NOT enable a downgrade — operator typos fail closed.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024,\"sequence\":1,"
        "\"allow_downgrade\":1}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_FALSE(m.allow_downgrade);
}

static void test_parse_allow_downgrade_quoted_true_defaults_false(void) {
    // `"allow_downgrade":"true"` is a stringly-typed mistake the parser
    // must NOT honour as a downgrade enable. Same reason as the
    // garbage-default test: typos fail closed.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024,\"sequence\":1,"
        "\"allow_downgrade\":\"true\"}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_FALSE(m.allow_downgrade);
}

static void test_parse_allow_downgrade_prefix_match_rejected(void) {
    // Round-1 senior-review P2: the original `parseBoolLiteral` checked
    // only the first 4 bytes, so `truer` or `truefoobar` would have
    // been accepted as `true` (the 5th byte was ignored). The
    // terminator-boundary guard rejects that.
    const char *json =
        "{\"version\":\"wallpaper\","
        "\"app_md5\":\"0123456789abcdef0123456789abcdef\","
        "\"app_size\":1024,\"sequence\":1,"
        "\"allow_downgrade\":truer}";
    OtaManifest m{};
    TEST_ASSERT_TRUE(parseOtaManifest(json, &m));
    TEST_ASSERT_FALSE(m.allow_downgrade);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_should_update_returns_false_on_equal_version);
    RUN_TEST(test_should_update_returns_true_on_higher_sequence);
    RUN_TEST(test_should_update_refuses_lower_sequence_no_flag);
    RUN_TEST(test_should_update_refuses_equal_sequence_no_flag);
    RUN_TEST(test_should_update_allows_lower_sequence_with_flag);
    RUN_TEST(test_should_update_allows_equal_sequence_with_flag);
    RUN_TEST(test_should_update_is_case_sensitive);
    RUN_TEST(test_should_update_returns_false_on_null_current);
    RUN_TEST(test_should_update_returns_false_on_empty_current);
    RUN_TEST(test_should_update_returns_false_on_empty_manifest_version);
    RUN_TEST(test_parse_valid_manifest_populates_all_fields);
    RUN_TEST(test_parse_ignores_unrelated_top_level_fields);
    RUN_TEST(test_parse_returns_false_on_null_inputs);
    RUN_TEST(test_parse_returns_false_on_missing_version);
    RUN_TEST(test_parse_returns_false_on_missing_app_md5);
    RUN_TEST(test_parse_returns_false_on_missing_app_size);
    RUN_TEST(test_parse_requires_sequence_field);
    RUN_TEST(test_parse_returns_false_on_short_md5);
    RUN_TEST(test_parse_returns_false_on_uppercase_md5);
    RUN_TEST(test_parse_returns_false_on_oversize_app);
    RUN_TEST(test_parse_returns_false_on_zero_app_size);
    RUN_TEST(test_parse_returns_false_on_garbage_json);
    RUN_TEST(test_parse_rejects_overlong_version);
    RUN_TEST(test_parse_rejects_negative_sequence);
    RUN_TEST(test_parse_does_not_false_match_substring_key);
    RUN_TEST(test_parse_allow_downgrade_literal_true);
    RUN_TEST(test_parse_allow_downgrade_literal_false);
    RUN_TEST(test_parse_allow_downgrade_absent_defaults_false);
    RUN_TEST(test_parse_allow_downgrade_garbage_defaults_false);
    RUN_TEST(test_parse_allow_downgrade_quoted_true_defaults_false);
    RUN_TEST(test_parse_allow_downgrade_prefix_match_rejected);
    return UNITY_END();
}

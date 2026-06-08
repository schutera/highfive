// Native (host) unit tests for hf::isPlausibleFix.
//
// Run with:  pio test -e native
//
// Pins the plausibility rule that gates `getGeolocation`'s 3-attempt
// retry path in `esp_init.cpp` and the heartbeat-side recovery write
// in `duckdb-service/routes/heartbeats.py`. The two sides apply the
// same rule (Null-Island sentinel + range check); this test file is
// the only place where every edge case is exercised end-to-end.

#include <unity.h>

#include <cmath>

#include "geolocation.h"

using hf::isPlausibleFix;
using hf::roundCoord;

void setUp() {}
void tearDown() {}

// --- rejection cases -----------------------------------------------------

static void test_rejects_null_island(void) {
    // The exact (0, 0, *) sentinel the firmware writes when getGeolocation
    // fails — the field-incident shape from issue #89.
    TEST_ASSERT_FALSE(isPlausibleFix(0.0f, 0.0f, 50.0f));
    TEST_ASSERT_FALSE(isPlausibleFix(0.0f, 0.0f, 0.0f));
    TEST_ASSERT_FALSE(isPlausibleFix(0.0f, 0.0f, 1.0f));
}

static void test_rejects_zero_accuracy(void) {
    // Google's "no fix" signal is HTTP 200 with `accuracy: 0`. The
    // legacy single-shot path stored this verbatim. Even if lat/lng
    // happen to look real, zero accuracy means the upstream service
    // didn't actually match the BSSID list.
    TEST_ASSERT_FALSE(isPlausibleFix(48.27f, 11.66f, 0.0f));
}

static void test_rejects_negative_accuracy(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(48.27f, 11.66f, -1.0f));
}

static void test_rejects_nan_lat(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(std::nanf(""), 11.66f, 50.0f));
}

static void test_rejects_nan_lng(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(48.27f, std::nanf(""), 50.0f));
}

static void test_rejects_nan_acc(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(48.27f, 11.66f, std::nanf("")));
}

static void test_rejects_lat_above_90(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(91.0f, 11.66f, 50.0f));
}

static void test_rejects_lat_below_neg90(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(-91.0f, 11.66f, 50.0f));
}

static void test_rejects_lng_above_180(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(48.27f, 181.0f, 50.0f));
}

static void test_rejects_lng_below_neg180(void) {
    TEST_ASSERT_FALSE(isPlausibleFix(48.27f, -181.0f, 50.0f));
}

// --- acceptance cases ----------------------------------------------------

static void test_accepts_garching(void) {
    // Bodensee/Garching-ish coords — the dev/seed-data area.
    TEST_ASSERT_TRUE(isPlausibleFix(48.27f, 11.66f, 50.0f));
}

static void test_accepts_near_equator_but_not_null_island(void) {
    // Guards against an over-eager "near zero" rule. (0.0001, 0.0001)
    // is a real point off the coast of Africa; we shouldn't reject it
    // just because it's near the equator. The Null-Island guard is
    // strictly exact-(0,0).
    TEST_ASSERT_TRUE(isPlausibleFix(0.0001f, 0.0001f, 10.0f));
}

static void test_accepts_lat_only_zero(void) {
    // On the equator, off Greenwich. Real-world: a buoy at (0, 90) is
    // valid; the sentinel rule must require BOTH coords be zero.
    TEST_ASSERT_TRUE(isPlausibleFix(0.0f, 90.0f, 50.0f));
}

static void test_accepts_lng_only_zero(void) {
    // On the Greenwich meridian, off the equator. Same rule symmetry.
    TEST_ASSERT_TRUE(isPlausibleFix(51.5f, 0.0f, 50.0f));
}

static void test_accepts_boundary_coords(void) {
    // Lat = ±90, lng = ±180 are valid corner points.
    TEST_ASSERT_TRUE(isPlausibleFix(90.0f, 180.0f, 100.0f));
    TEST_ASSERT_TRUE(isPlausibleFix(-90.0f, -180.0f, 100.0f));
}

// --- roundCoord (coordinate generalization, issue #145 / ADR-020) --------

static void test_round_generalizes_to_two_dp(void) {
    // A precise Google fix is coarsened to ~1 km before it ever leaves the
    // device. 52.520077 -> 52.52, 13.404954 -> 13.40.
    TEST_ASSERT_FLOAT_WITHIN(1e-4f, 52.52f, roundCoord(52.520077f));
    TEST_ASSERT_FLOAT_WITHIN(1e-4f, 13.40f, roundCoord(13.404954f));
}

static void test_round_rounds_up_third_decimal(void) {
    // .137 -> .14 (nearest), proving it rounds rather than truncates.
    TEST_ASSERT_FLOAT_WITHIN(1e-4f, 48.14f, roundCoord(48.137154f));
}

static void test_round_handles_negative(void) {
    // Southern/western hemispheres round symmetrically.
    TEST_ASSERT_FLOAT_WITHIN(1e-4f, -8.12f, roundCoord(-8.123456f));
}

static void test_round_preserves_null_island_sentinel(void) {
    // (0,0) must survive rounding so the "no fix yet" sentinel and the
    // isPlausibleFix guard downstream still see exact zero.
    TEST_ASSERT_EQUAL_FLOAT(0.0f, roundCoord(0.0f));
}

static void test_round_is_idempotent_on_coarse_value(void) {
    // An already-2-dp value is unchanged — the server-side migration relies
    // on this (round(round(x)) == round(x)) to be a true no-op on re-run.
    TEST_ASSERT_FLOAT_WITHIN(1e-4f, 52.52f, roundCoord(52.52f));
}

static void test_round_passes_nan_through(void) {
    // A parser glitch must surface to isPlausibleFix as NaN, not collapse to 0.
    TEST_ASSERT_TRUE(std::isnan(roundCoord(std::nanf(""))));
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_rejects_null_island);
    RUN_TEST(test_rejects_zero_accuracy);
    RUN_TEST(test_rejects_negative_accuracy);
    RUN_TEST(test_rejects_nan_lat);
    RUN_TEST(test_rejects_nan_lng);
    RUN_TEST(test_rejects_nan_acc);
    RUN_TEST(test_rejects_lat_above_90);
    RUN_TEST(test_rejects_lat_below_neg90);
    RUN_TEST(test_rejects_lng_above_180);
    RUN_TEST(test_rejects_lng_below_neg180);
    RUN_TEST(test_accepts_garching);
    RUN_TEST(test_accepts_near_equator_but_not_null_island);
    RUN_TEST(test_accepts_lat_only_zero);
    RUN_TEST(test_accepts_lng_only_zero);
    RUN_TEST(test_accepts_boundary_coords);
    RUN_TEST(test_round_generalizes_to_two_dp);
    RUN_TEST(test_round_rounds_up_third_decimal);
    RUN_TEST(test_round_handles_negative);
    RUN_TEST(test_round_preserves_null_island_sentinel);
    RUN_TEST(test_round_is_idempotent_on_coarse_value);
    RUN_TEST(test_round_passes_nan_through);
    return UNITY_END();
}

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
    return UNITY_END();
}

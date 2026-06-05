// Native (host) unit tests for the embedded TLS trust anchors in
// lib/tls_roots/tls_roots.h.
//
// Run with:  pio test -e native
//
// These pin the structural contract of the pinned roots so a malformed
// paste or a divergence between the per-root constants and the bundle
// fails the build instead of silently bricking geolocation in the field
// (the 2026-06-05 "Standort ausstehend" incident: pinning GTS Root R1
// alone after Google rotated googleapis.com to GTS Root R4 made every
// geolocation TLS handshake fail — see chapter-11 lessons learned and
// ADR-010). None of the firmware's existing native tests touch this
// header; this file is the only CI guard on the trust material.

#include <unity.h>

#include <string>

#include "tls_roots.h"

using hf::tls::kGoogleApisCaBundlePem;
using hf::tls::kGtsRootR1Pem;
using hf::tls::kGtsRootR4Pem;
using hf::tls::kIsrgRootX1Pem;

void setUp() {}
void tearDown() {}

namespace {

const char* const kBegin = "-----BEGIN CERTIFICATE-----";
const char* const kEnd = "-----END CERTIFICATE-----";

// Count non-overlapping occurrences of `needle` in `hay`.
std::size_t countOccurrences(const std::string& hay, const std::string& needle) {
    std::size_t count = 0;
    std::size_t pos = 0;
    while ((pos = hay.find(needle, pos)) != std::string::npos) {
        ++count;
        pos += needle.size();
    }
    return count;
}

// A single PEM cert: exactly one BEGIN/END pair, BEGIN before END, and a
// non-trivial body between them.
void assertSingleCert(const std::string& pem, const char* name) {
    TEST_ASSERT_EQUAL_INT_MESSAGE(1, (int)countOccurrences(pem, kBegin), name);
    TEST_ASSERT_EQUAL_INT_MESSAGE(1, (int)countOccurrences(pem, kEnd), name);
    const std::size_t begin = pem.find(kBegin);
    const std::size_t end = pem.find(kEnd);
    TEST_ASSERT_TRUE_MESSAGE(begin < end, name);
    TEST_ASSERT_TRUE_MESSAGE((end - begin) > 64, name);  // some base64 body
}

}  // namespace

// Each standalone anchor is exactly one well-formed cert. Catches a
// truncated or doubled paste of any single root.
void test_each_root_is_one_well_formed_cert() {
    assertSingleCert(kIsrgRootX1Pem, "ISRG Root X1");
    assertSingleCert(kGtsRootR1Pem, "GTS Root R1");
    assertSingleCert(kGtsRootR4Pem, "GTS Root R4");
}

// The googleapis bundle is exactly two certs — the R1+R4 pair the
// geolocation handshake needs to verify against either chain Google
// serves. A bundle that collapsed to one cert is exactly what the
// CA-rotation outage looked like.
void test_google_bundle_has_exactly_two_certs() {
    const std::string bundle(kGoogleApisCaBundlePem);
    TEST_ASSERT_EQUAL_INT(2, (int)countOccurrences(bundle, kBegin));
    TEST_ASSERT_EQUAL_INT(2, (int)countOccurrences(bundle, kEnd));
}

// The bundle is byte-for-byte `R1 || R4`. This is the invariant that
// lets the per-root constants stay the documented single source of
// truth while the bundle remains a flash-resident concatenation: edit a
// root and forget to mirror it here, and this assertion fails the build.
void test_google_bundle_is_R1_then_R4() {
    const std::string expected = std::string(kGtsRootR1Pem) + kGtsRootR4Pem;
    TEST_ASSERT_EQUAL_STRING(expected.c_str(), kGoogleApisCaBundlePem);
}

extern "C" int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_each_root_is_one_well_formed_cert);
    RUN_TEST(test_google_bundle_has_exactly_two_certs);
    RUN_TEST(test_google_bundle_is_R1_then_R4);
    return UNITY_END();
}

// Native (host) unit tests for hf::parseUrl.
//
// Run with:  pio test -e native
//
// These tests document the contract that the firmware's URL parsing
// must honor — they exist so that parser regressions cannot ship
// without a CI failure, the way they could before.

#include <unity.h>

#include "url.h"

using hf::parseUrl;
using hf::Url;

void setUp() {}
void tearDown() {}

// --- happy-path parsing ---------------------------------------------------

static void test_full_https_url(void) {
    Url u = parseUrl("https://api.example.com:8443/upload");
    TEST_ASSERT_EQUAL_STRING("https", u.scheme.c_str());
    TEST_ASSERT_EQUAL_STRING("api.example.com", u.host.c_str());
    TEST_ASSERT_EQUAL_UINT16(8443, u.port);
    TEST_ASSERT_EQUAL_STRING("/upload", u.path.c_str());
}

static void test_https_default_port(void) {
    Url u = parseUrl("https://example.com/path");
    TEST_ASSERT_EQUAL_UINT16(443, u.port);
    TEST_ASSERT_EQUAL_STRING("/path", u.path.c_str());
}

static void test_http_default_port(void) {
    Url u = parseUrl("http://example.com/path");
    TEST_ASSERT_EQUAL_UINT16(80, u.port);
}

static void test_no_path_defaults_to_slash(void) {
    Url u = parseUrl("https://example.com");
    TEST_ASSERT_EQUAL_STRING("/", u.path.c_str());
}

// --- real-world inputs the firmware actually sees -------------------------

static void test_local_image_service(void) {
    // The shape of UPLOAD_URL once the wizard has filled it in.
    Url u = parseUrl("http://image-service:4444/upload");
    TEST_ASSERT_EQUAL_STRING("http", u.scheme.c_str());
    TEST_ASSERT_EQUAL_STRING("image-service", u.host.c_str());
    TEST_ASSERT_EQUAL_UINT16(4444, u.port);
    TEST_ASSERT_EQUAL_STRING("/upload", u.path.c_str());
}

static void test_ip_with_port(void) {
    // Mirrors the commented-out fallback in initNewModuleOnServer().
    Url u = parseUrl("http://192.168.0.36:8002/new_module");
    TEST_ASSERT_EQUAL_STRING("192.168.0.36", u.host.c_str());
    TEST_ASSERT_EQUAL_UINT16(8002, u.port);
    TEST_ASSERT_EQUAL_STRING("/new_module", u.path.c_str());
}

// --- malformed input ------------------------------------------------------

static void test_no_scheme(void) {
    Url u = parseUrl("example.com:1234/x");
    TEST_ASSERT_EQUAL_STRING("", u.scheme.c_str());
    TEST_ASSERT_EQUAL_STRING("example.com", u.host.c_str());
    TEST_ASSERT_EQUAL_UINT16(1234, u.port);
    TEST_ASSERT_EQUAL_STRING("/x", u.path.c_str());
}

static void test_invalid_port_falls_back_to_scheme_default(void) {
    Url u = parseUrl("http://example.com:abc/x");
    TEST_ASSERT_EQUAL_UINT16(80, u.port);
}

static void test_out_of_range_port_falls_back(void) {
    Url u = parseUrl("https://example.com:99999/x");
    TEST_ASSERT_EQUAL_UINT16(443, u.port);
}

static void test_empty_input(void) {
    Url u = parseUrl("");
    TEST_ASSERT_EQUAL_STRING("", u.host.c_str());
    TEST_ASSERT_EQUAL_UINT16(0, u.port);
    TEST_ASSERT_EQUAL_STRING("/", u.path.c_str());
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_full_https_url);
    RUN_TEST(test_https_default_port);
    RUN_TEST(test_http_default_port);
    RUN_TEST(test_no_path_defaults_to_slash);
    RUN_TEST(test_local_image_service);
    RUN_TEST(test_ip_with_port);
    RUN_TEST(test_no_scheme);
    RUN_TEST(test_invalid_port_falls_back_to_scheme_default);
    RUN_TEST(test_out_of_range_port_falls_back);
    RUN_TEST(test_empty_input);
    return UNITY_END();
}

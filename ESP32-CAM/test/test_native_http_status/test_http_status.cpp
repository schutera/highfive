// Native (host) unit tests for hf::http::parseStatusCode and
// hf::http::statusCodeToReturnValue.
//
// Run with:  pio test -e native
//
// These pin the contract that the firmware's HTTP non-2xx handling
// must honor — they exist so a refactor that "simplifies" the
// status-handling can't silently regress the
// "Never let sendHeartbeat swallow non-2xx" rule that CLAUDE.md used to
// state as prose. The helper is now the contract; this test enforces it.

#include <unity.h>

#include "http_status.h"

using hf::http::kInvalidStatus;
using hf::http::parseStatusCode;
using hf::http::statusCodeToReturnValue;

void setUp() {}
void tearDown() {}

// ============================================================
// parseStatusCode — happy path
// ============================================================

static void test_parse_200_ok(void) {
    TEST_ASSERT_EQUAL_INT(200, parseStatusCode("HTTP/1.1 200 OK"));
}

static void test_parse_201_created(void) {
    TEST_ASSERT_EQUAL_INT(201, parseStatusCode("HTTP/1.1 201 Created"));
}

static void test_parse_204_no_content(void) {
    TEST_ASSERT_EQUAL_INT(204, parseStatusCode("HTTP/1.1 204 No Content"));
}

static void test_parse_403_forbidden(void) {
    TEST_ASSERT_EQUAL_INT(403, parseStatusCode("HTTP/1.1 403 Forbidden"));
}

static void test_parse_500_internal_server_error(void) {
    TEST_ASSERT_EQUAL_INT(500, parseStatusCode("HTTP/1.1 500 Internal Server Error"));
}

static void test_parse_status_with_no_reason_phrase(void) {
    // Reason phrase is technically optional in HTTP/1.1. Pin that the
    // parser accepts a bare "HTTP/1.1 NNN" without the trailing
    // " Reason" — the byte offsets to the 3-digit code don't change.
    TEST_ASSERT_EQUAL_INT(200, parseStatusCode("HTTP/1.1 200"));
}

// ============================================================
// parseStatusCode — parse failures
// ============================================================

static void test_parse_empty_line_yields_sentinel(void) {
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode(""));
}

static void test_parse_garbage_yields_sentinel(void) {
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode("not an http response"));
}

static void test_parse_http_10_rejected(void) {
    // HTTP/1.0 is intentionally rejected (header comment in
    // http_status.h documents this). Every call site speaks HTTP/1.1;
    // an HTTP/1.0 response is a protocol-version mismatch that should
    // surface as non-2xx rather than being silently accepted.
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode("HTTP/1.0 200 OK"));
}

static void test_parse_http_20_rejected(void) {
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode("HTTP/2.0 200 OK"));
}

static void test_parse_truncated_status_line_yields_sentinel(void) {
    // "HTTP/1.1 20" is two digits — not enough to form a 3-digit code.
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode("HTTP/1.1 20"));
}

static void test_parse_non_digit_status_yields_sentinel(void) {
    // Status field with a letter where a digit is expected.
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode("HTTP/1.1 2x0 OK"));
}

static void test_parse_status_code_below_100_yields_sentinel(void) {
    // 099 is outside the documented HTTP code space. Treat as parse
    // failure to keep the caller's "non-2xx" path uniform — there's no
    // sane interpretation of "the server said HTTP 099."
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode("HTTP/1.1 099 ?"));
}

static void test_parse_status_code_above_599_yields_sentinel(void) {
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, parseStatusCode("HTTP/1.1 600 ?"));
}

// ============================================================
// statusCodeToReturnValue — 2xx success → 0
// ============================================================

static void test_return_value_200_is_zero(void) {
    TEST_ASSERT_EQUAL_INT(0, statusCodeToReturnValue(200));
}

static void test_return_value_204_is_zero(void) {
    TEST_ASSERT_EQUAL_INT(0, statusCodeToReturnValue(204));
}

static void test_return_value_299_is_zero(void) {
    // Upper boundary of the 2xx range.
    TEST_ASSERT_EQUAL_INT(0, statusCodeToReturnValue(299));
}

// ============================================================
// statusCodeToReturnValue — non-2xx → unchanged (the rule)
// ============================================================

static void test_return_value_199_is_unchanged(void) {
    // Sub-200: 1xx is informational and we don't accept it as success.
    // Returning the code unchanged so the caller's non-2xx path fires
    // and logbufNoteHttpCode records the unusual response.
    TEST_ASSERT_EQUAL_INT(199, statusCodeToReturnValue(199));
}

static void test_return_value_300_is_unchanged(void) {
    // Lower boundary of the non-2xx range — 300 is a redirect that the
    // firmware does not follow.
    TEST_ASSERT_EQUAL_INT(300, statusCodeToReturnValue(300));
}

static void test_return_value_403_is_unchanged(void) {
    TEST_ASSERT_EQUAL_INT(403, statusCodeToReturnValue(403));
}

static void test_return_value_500_is_unchanged(void) {
    TEST_ASSERT_EQUAL_INT(500, statusCodeToReturnValue(500));
}

static void test_return_value_sentinel_is_unchanged(void) {
    // The kInvalidStatus sentinel (-4) must propagate through unchanged
    // so the caller can distinguish "parse failure" from "got a real
    // 4xx/5xx from the server." Both end up in logbufNoteHttpCode but
    // they tell different stories in the breadcrumb buffer.
    TEST_ASSERT_EQUAL_INT(kInvalidStatus, statusCodeToReturnValue(kInvalidStatus));
}

// ============================================================
// Integration: parseStatusCode → statusCodeToReturnValue
// ============================================================

static void test_integration_403_propagates_through_both_helpers(void) {
    // The canonical caller pattern from client.cpp:
    //     int code = hf::http::parseStatusCode(statusLine);
    //     logbufNoteHttpCode(code);
    //     int rv = hf::http::statusCodeToReturnValue(code);
    //     if (rv != 0) { /* non-2xx path */ }
    //
    // Pin that a 403 response produces a non-zero return value.
    const int code = parseStatusCode("HTTP/1.1 403 Forbidden");
    TEST_ASSERT_EQUAL_INT(403, code);
    TEST_ASSERT_EQUAL_INT(403, statusCodeToReturnValue(code));
}

static void test_integration_200_propagates_as_zero(void) {
    const int code = parseStatusCode("HTTP/1.1 200 OK");
    TEST_ASSERT_EQUAL_INT(200, code);
    TEST_ASSERT_EQUAL_INT(0, statusCodeToReturnValue(code));
}

int main(int, char**) {
    UNITY_BEGIN();
    // parseStatusCode — happy path
    RUN_TEST(test_parse_200_ok);
    RUN_TEST(test_parse_201_created);
    RUN_TEST(test_parse_204_no_content);
    RUN_TEST(test_parse_403_forbidden);
    RUN_TEST(test_parse_500_internal_server_error);
    RUN_TEST(test_parse_status_with_no_reason_phrase);
    // parseStatusCode — failures
    RUN_TEST(test_parse_empty_line_yields_sentinel);
    RUN_TEST(test_parse_garbage_yields_sentinel);
    RUN_TEST(test_parse_http_10_rejected);
    RUN_TEST(test_parse_http_20_rejected);
    RUN_TEST(test_parse_truncated_status_line_yields_sentinel);
    RUN_TEST(test_parse_non_digit_status_yields_sentinel);
    RUN_TEST(test_parse_status_code_below_100_yields_sentinel);
    RUN_TEST(test_parse_status_code_above_599_yields_sentinel);
    // statusCodeToReturnValue — 2xx success
    RUN_TEST(test_return_value_200_is_zero);
    RUN_TEST(test_return_value_204_is_zero);
    RUN_TEST(test_return_value_299_is_zero);
    // statusCodeToReturnValue — non-2xx
    RUN_TEST(test_return_value_199_is_unchanged);
    RUN_TEST(test_return_value_300_is_unchanged);
    RUN_TEST(test_return_value_403_is_unchanged);
    RUN_TEST(test_return_value_500_is_unchanged);
    RUN_TEST(test_return_value_sentinel_is_unchanged);
    // integration
    RUN_TEST(test_integration_403_propagates_through_both_helpers);
    RUN_TEST(test_integration_200_propagates_as_zero);
    return UNITY_END();
}

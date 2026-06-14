// Native (host) unit tests for the developer serial-console parser and the
// dev-URL composition helper (issue #156).
//
// Run with:  pio test -e native
//
// These pin two things the on-device serial console (serial_console.cpp) relies
// on but cannot host-test directly because they sit behind Arduino Serial I/O:
//   1. parseSerialCmd's tokenisation — verb lowercasing, whitespace handling,
//      1- vs 2-arg forms, and that arguments keep their case (URLs/hosts are
//      case-sensitive).
//   2. devUrlsFromHost — the LAN dev-stack URL convention. This pins the
//      FIRMWARE side of that convention to its expected output; the ports/
//      endpoints must stay byte-for-byte identical to what ESP32-CAM/build.sh
//      and extra_scripts.py compose, or a runtime `set-server <host>` would land
//      a module on a different stack than a DEV_SERVER_HOST build. (This test
//      cannot read build.sh, so keeping the two build scripts in sync is still a
//      manual review responsibility — see the comment in serial_cmd.cpp.)

#include <unity.h>

#include <string>

#include "serial_cmd.h"

using hf::devUrlsFromHost;
using hf::isBareHost;
using hf::parseSerialCmd;
using hf::SerialCmd;

void setUp() {}
void tearDown() {}

// --- parseSerialCmd ------------------------------------------------------

static void test_parse_empty_line_yields_empty_verb(void) {
    SerialCmd c = parseSerialCmd("");
    TEST_ASSERT_EQUAL_STRING("", c.verb.c_str());
    TEST_ASSERT_EQUAL_STRING("", c.arg1.c_str());
    TEST_ASSERT_EQUAL_STRING("", c.arg2.c_str());
}

static void test_parse_whitespace_only_yields_empty_verb(void) {
    SerialCmd c = parseSerialCmd("   \t  ");
    TEST_ASSERT_EQUAL_STRING("", c.verb.c_str());
}

static void test_parse_verb_only(void) {
    SerialCmd c = parseSerialCmd("show-config");
    TEST_ASSERT_EQUAL_STRING("show-config", c.verb.c_str());
    TEST_ASSERT_EQUAL_STRING("", c.arg1.c_str());
}

static void test_parse_verb_is_lowercased(void) {
    SerialCmd c = parseSerialCmd("Set-Server");
    TEST_ASSERT_EQUAL_STRING("set-server", c.verb.c_str());
}

static void test_parse_one_arg(void) {
    SerialCmd c = parseSerialCmd("set-server 192.168.1.50");
    TEST_ASSERT_EQUAL_STRING("set-server", c.verb.c_str());
    TEST_ASSERT_EQUAL_STRING("192.168.1.50", c.arg1.c_str());
    TEST_ASSERT_EQUAL_STRING("", c.arg2.c_str());
}

static void test_parse_two_args_preserve_case(void) {
    SerialCmd c = parseSerialCmd(
        "set-server https://Dev.Example.com/new_module https://Dev.Example.com/upload");
    TEST_ASSERT_EQUAL_STRING("set-server", c.verb.c_str());
    TEST_ASSERT_EQUAL_STRING("https://Dev.Example.com/new_module", c.arg1.c_str());
    TEST_ASSERT_EQUAL_STRING("https://Dev.Example.com/upload", c.arg2.c_str());
}

static void test_parse_extra_tokens_ignored(void) {
    SerialCmd c = parseSerialCmd("set-server a b c d");
    TEST_ASSERT_EQUAL_STRING("a", c.arg1.c_str());
    TEST_ASSERT_EQUAL_STRING("b", c.arg2.c_str());
}

static void test_parse_collapses_runs_of_whitespace(void) {
    SerialCmd c = parseSerialCmd("  set-server   \t 192.168.1.50  ");
    TEST_ASSERT_EQUAL_STRING("set-server", c.verb.c_str());
    TEST_ASSERT_EQUAL_STRING("192.168.1.50", c.arg1.c_str());
}

static void test_parse_tab_separated(void) {
    SerialCmd c = parseSerialCmd("set-server\t192.168.1.50");
    TEST_ASSERT_EQUAL_STRING("set-server", c.verb.c_str());
    TEST_ASSERT_EQUAL_STRING("192.168.1.50", c.arg1.c_str());
}

// --- devUrlsFromHost (the build.sh drift pin) ----------------------------

static void test_dev_urls_match_build_sh_convention(void) {
    std::string init, upload;
    bool ok = devUrlsFromHost("192.168.1.50", init, upload);
    TEST_ASSERT_TRUE(ok);
    // These literals MUST match ESP32-CAM/build.sh's DEV_URL_FLAGS and
    // extra_scripts.py's url_defines exactly.
    TEST_ASSERT_EQUAL_STRING("http://192.168.1.50:8002/new_module", init.c_str());
    TEST_ASSERT_EQUAL_STRING("http://192.168.1.50:8000/upload", upload.c_str());
}

static void test_dev_urls_hostname_host(void) {
    std::string init, upload;
    devUrlsFromHost("mybox.local", init, upload);
    TEST_ASSERT_EQUAL_STRING("http://mybox.local:8002/new_module", init.c_str());
    TEST_ASSERT_EQUAL_STRING("http://mybox.local:8000/upload", upload.c_str());
}

static void test_dev_urls_empty_host_returns_false(void) {
    std::string init = "untouched-init";
    std::string upload = "untouched-upload";
    bool ok = devUrlsFromHost("", init, upload);
    TEST_ASSERT_FALSE(ok);
    TEST_ASSERT_EQUAL_STRING("untouched-init", init.c_str());
    TEST_ASSERT_EQUAL_STRING("untouched-upload", upload.c_str());
}

// The P1 fix: a scheme/port/path-bearing token must NOT be accepted as a bare
// host (otherwise `set-server http://1.2.3.4` would compose a doubled-scheme
// "http://http://1.2.3.4:8002/new_module" and be used as the registration URL).
static void test_dev_urls_reject_scheme_prefixed_host(void) {
    std::string init = "x", upload = "y";
    TEST_ASSERT_FALSE(devUrlsFromHost("http://192.168.1.50", init, upload));
    TEST_ASSERT_EQUAL_STRING("x", init.c_str());     // untouched
    TEST_ASSERT_EQUAL_STRING("y", upload.c_str());
}

static void test_is_bare_host_accepts_ip_and_hostname(void) {
    TEST_ASSERT_TRUE(isBareHost("192.168.1.50"));
    TEST_ASSERT_TRUE(isBareHost("mybox.local"));
}

static void test_is_bare_host_rejects_url_punctuation(void) {
    TEST_ASSERT_FALSE(isBareHost(""));
    TEST_ASSERT_FALSE(isBareHost("http://192.168.1.50"));  // scheme
    TEST_ASSERT_FALSE(isBareHost("192.168.1.50:8002"));    // port
    TEST_ASSERT_FALSE(isBareHost("192.168.1.50/upload"));  // path
    TEST_ASSERT_FALSE(isBareHost("host name"));            // whitespace
}

int main(int, char **) {
    UNITY_BEGIN();

    RUN_TEST(test_parse_empty_line_yields_empty_verb);
    RUN_TEST(test_parse_whitespace_only_yields_empty_verb);
    RUN_TEST(test_parse_verb_only);
    RUN_TEST(test_parse_verb_is_lowercased);
    RUN_TEST(test_parse_one_arg);
    RUN_TEST(test_parse_two_args_preserve_case);
    RUN_TEST(test_parse_extra_tokens_ignored);
    RUN_TEST(test_parse_collapses_runs_of_whitespace);
    RUN_TEST(test_parse_tab_separated);

    RUN_TEST(test_dev_urls_match_build_sh_convention);
    RUN_TEST(test_dev_urls_hostname_host);
    RUN_TEST(test_dev_urls_empty_host_returns_false);
    RUN_TEST(test_dev_urls_reject_scheme_prefixed_host);
    RUN_TEST(test_is_bare_host_accepts_ip_and_hostname);
    RUN_TEST(test_is_bare_host_rejects_url_punctuation);

    return UNITY_END();
}

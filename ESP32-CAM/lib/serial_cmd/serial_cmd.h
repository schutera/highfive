#ifndef HF_SERIAL_CMD_H
#define HF_SERIAL_CMD_H

#include <string>

namespace hf {

// Parsed developer serial command (issue #156).
//
// The USB serial console is a developer-only side channel for retargeting a
// flashed module's server URLs without a rebuild/reflash; the captive portal
// stays Wi-Fi-only (ADR-018). This struct + parser are the pure, host-testable
// core. Serial I/O, validation and dispatch live in serial_console.cpp on the
// device. Pinned by test/test_native_serial_cmd.
struct SerialCmd {
  std::string verb;   // lowercased; empty when the line had no tokens
  std::string arg1;   // first argument, case preserved (URLs/hosts are
                      // case-sensitive), or "" when absent
  std::string arg2;   // second argument, or "" when absent
};

// Parse one line into {verb, arg1, arg2}. Tokens are whitespace-delimited
// (space/tab/CR/LF); leading/trailing whitespace is ignored. The verb is
// lowercased so `Set-Server` == `set-server`; arguments keep their case.
// Tokens beyond the second argument are ignored. An empty / whitespace-only
// line yields an all-empty SerialCmd.
SerialCmd parseSerialCmd(const std::string& line);

// Port + endpoint convention for a LAN dev stack, mirrored from
// ESP32-CAM/build.sh and extra_scripts.py (8002 = duckdb-service /new_module,
// 8000 = image-service /upload). Single source of truth for the firmware's
// runtime retargeting path; test_native_serial_cmd pins these against the
// exact build.sh-composed strings so the three sites cannot drift apart.
extern const char* const kDevInitPort;
extern const char* const kDevInitEndpoint;
extern const char* const kDevUploadPort;
extern const char* const kDevUploadEndpoint;

// True iff `s` is a plausible bare host/IP for the one-argument `set-server
// <host>` form: non-empty and free of scheme/port/path punctuation (no ':',
// '/', '\\', or whitespace). This is a STRICT gate, deliberately not hf::parseUrl
// — parseUrl is permissive (it parses "http" out of a doubled-scheme string as a
// host), so a `set-server http://1.2.3.4` would otherwise compose the malformed
// "http://http://1.2.3.4:8002/new_module" and pass. A token that fails this
// check is a URL the developer should pass via the two-argument verbatim form.
bool isBareHost(const std::string& s);

// Compose the dev init + upload URLs from a bare host/IP (no scheme, no port),
// e.g. "192.168.1.50" -> "http://192.168.1.50:8002/new_module" and
// "http://192.168.1.50:8000/upload". Mirrors build.sh's DEV_URL_FLAGS so a
// runtime `set-server <host>` lands the module on the same stack a
// DEV_SERVER_HOST build would. Returns false (outputs untouched) when host is
// not a valid bare host (see isBareHost).
bool devUrlsFromHost(const std::string& host,
                     std::string& initUrlOut,
                     std::string& uploadUrlOut);

}  // namespace hf

#endif  // HF_SERIAL_CMD_H

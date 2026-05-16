#pragma once

#include <string>

namespace hf {
namespace http {

// Sentinel returned by parseStatusCode() when the response line cannot
// be interpreted as an HTTP/1.1 status. Matches the value client.cpp
// has historically used in-line, kept negative so it never collides
// with a real HTTP status code.
constexpr int kInvalidStatus = -4;

// Parse the first line of an HTTP/1.1 response and return the 3-digit
// status code, or kInvalidStatus on parse failure.
//
// Contract:
//   * Input must start with the literal "HTTP/1.1 " prefix. The HTTP/1.0
//     case is intentionally rejected: every call site in the firmware
//     speaks HTTP/1.1 explicitly, and an HTTP/1.0 response from the
//     other side is a protocol-version mismatch that deserves the
//     "non-2xx" surface rather than silent acceptance.
//   * The three characters at offset 9..12 are read as a decimal status
//     code. Anything that doesn't parse to 100-599 returns kInvalidStatus.
//   * Whitespace around the code is not tolerated — the prefix pins the
//     exact byte layout. This matches the existing call-site behaviour
//     and keeps the parse function trivially constant-time.
//
// Designed to be the single source of truth for the
// "Never let sendHeartbeat swallow non-2xx" rule from CLAUDE.md —
// callers must use this function's return value with
// statusCodeToReturnValue() below, and the native test suite pins both.
int parseStatusCode(const std::string& statusLine);

// Convert a parsed HTTP status code to the "should this be surfaced as
// a non-zero return" value the firmware uses uniformly:
//
//   * 200..299 → 0   (success)
//   * any other → the input code, unchanged (caller propagates it
//                    upstream so logbufNoteHttpCode + non-2xx logging
//                    can fire)
//
// The kInvalidStatus sentinel (-4) is preserved as-is so the parse
// failure remains distinguishable from a real upstream 4xx/5xx.
int statusCodeToReturnValue(int httpCode);

}  // namespace http
}  // namespace hf

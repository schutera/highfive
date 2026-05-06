#pragma once

namespace hf {

// Translate an Arduino `WiFi.status()` value into a short, log-friendly
// name. Pure switch — host-testable, no WiFi.h dependency.
//
// The integer values match the wl_status_t enum in
// arduino-esp32/libraries/WiFi/src/WiFiType.h. We accept `int` rather
// than the typedef so the helper has zero coupling to the Arduino headers
// and can be exercised from the native test target.
//
// Returned strings are static literals — no allocation, safe to print
// directly with Serial.printf("%s", ...).
const char* wifiStatusName(int status);

}  // namespace hf

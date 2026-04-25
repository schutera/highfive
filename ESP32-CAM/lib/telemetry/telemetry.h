#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace hf {

// Inputs to the telemetry payload that ships alongside every image upload.
//
// The firmware fills this in by reading device state at upload time:
//   fw                  → FIRMWARE_VERSION macro
//   uptime_seconds      → millis() / 1000
//   last_reset_reason   → resetReasonStr(esp_reset_reason()) (e.g. "POWERON")
//   free_heap           → ESP.getFreeHeap()
//   min_free_heap       → ESP.getMinFreeHeap()
//   rssi                → WiFi.isConnected() ? WiFi.RSSI() : 0
//   wifi_reconnects     → ReconnectCounter::value()
//   last_http_codes     → HttpCodeRing::snapshot()
//   log                 → RingBuffer::snapshot() (latest ~2 KB of logf)
//
// All Arduino-bound concerns sit in the firmware; the JSON serializer
// itself is pure and host-testable.
struct TelemetryInputs {
    std::string fw;
    std::uint32_t uptime_seconds = 0;
    std::string last_reset_reason;
    std::uint32_t free_heap = 0;
    std::uint32_t min_free_heap = 0;
    int rssi = 0;
    std::uint32_t wifi_reconnects = 0;
    std::vector<int> last_http_codes;
    std::string log;
};

// Serialize TelemetryInputs to a JSON object. The exact field order, names,
// and string-escape rules are load-bearing: image-service writes the result
// verbatim to "{filename}.log.json" sidecars and the admin UI parses those
// back. A schema change here demands a coordinated change in image-service
// and the homepage's TelemetryEntry type.
//
// Schema (RFC 8259 JSON):
//   {
//     "fw": <string>,
//     "uptime_s": <uint>,
//     "last_reset_reason": <string>,
//     "free_heap": <uint>,
//     "min_free_heap": <uint>,
//     "rssi": <int>,
//     "wifi_reconnects": <uint>,
//     "last_http_codes": [<int>, ...],
//     "log": <string with control-char and embedded-null escaping>
//   }
std::string buildTelemetryJson(const TelemetryInputs& inputs);

}  // namespace hf

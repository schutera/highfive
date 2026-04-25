#include "logbuf.h"

#include "esp_init.h"   // FIRMWARE_VERSION
#include "metrics.h"
#include "ring_buffer.h"
#include "telemetry.h"

#include <stdarg.h>
#include <string>
#include <WiFi.h>
#include <esp_system.h>

// Backing storage for the log ring (was a static char[LOGBUF_SIZE]).
// Kept as a separate static array so its address is stable across the
// life of the firmware; hf::RingBuffer holds a pointer into it.
static char s_log_storage[LOGBUF_SIZE];
static hf::RingBuffer s_log(s_log_storage, LOGBUF_SIZE);

// Backing storage for the recent-HTTP-codes ring (was static int[]).
static int s_http_codes_storage[HTTP_CODES_LEN];
static hf::HttpCodeRing s_http_codes(s_http_codes_storage, HTTP_CODES_LEN);

// Monotonic counter for WiFi reconnect attempts.
static hf::ReconnectCounter s_reconnects;

static const char *resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_EXT:       return "EXT";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_WDT:       return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_SDIO:      return "SDIO";
    default:                return "UNKNOWN";
  }
}

void logbufInit() {
  // Reset all telemetry state. Defensive against soft resets where BSS
  // is preserved — the lib classes are trivially assignable, so a fresh
  // instance gives us a clean slate without dynamic allocation.
  s_log = hf::RingBuffer(s_log_storage, LOGBUF_SIZE);
  s_http_codes = hf::HttpCodeRing(s_http_codes_storage, HTTP_CODES_LEN);
  s_reconnects = hf::ReconnectCounter();
}

void logf(const char *fmt, ...) {
  char line[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(line, sizeof(line), fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if (n >= (int)sizeof(line)) n = sizeof(line) - 1;

  Serial.write((const uint8_t *)line, n);
  if (n == 0 || line[n - 1] != '\n') {
    Serial.write('\n');
  }

  s_log.append(line, (size_t)n);
  if (n == 0 || line[n - 1] != '\n') {
    const char nl = '\n';
    s_log.append(&nl, 1);
  }
}

void logbufNoteHttpCode(int code) {
  s_http_codes.note(code);
}

void logbufNoteWifiReconnect() {
  s_reconnects.increment();
}

String buildTelemetryJson() {
  // Gather Arduino-specific inputs here; pass them to the pure host-
  // testable serializer in lib/telemetry. The wire format is pinned by
  // test_image_service_expected_schema_exact and consumed verbatim by
  // image-service's .log.json sidecars.
  hf::TelemetryInputs in;
  in.fw                = FIRMWARE_VERSION;
  in.uptime_seconds    = (uint32_t)(millis() / 1000);
  in.last_reset_reason = resetReasonStr(esp_reset_reason());
  in.free_heap         = (uint32_t)ESP.getFreeHeap();
  in.min_free_heap     = (uint32_t)ESP.getMinFreeHeap();
  in.rssi              = WiFi.isConnected() ? WiFi.RSSI() : 0;
  in.wifi_reconnects   = s_reconnects.value();
  in.last_http_codes   = s_http_codes.snapshot();
  in.log               = s_log.snapshot();

  std::string json = hf::buildTelemetryJson(in);
  return String(json.c_str());
}

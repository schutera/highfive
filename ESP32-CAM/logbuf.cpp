#include "logbuf.h"
#include <stdarg.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <esp_system.h>

static char     s_buf[LOGBUF_SIZE];
static size_t   s_head      = 0;
static bool     s_wrapped   = false;

static int      s_http_codes[HTTP_CODES_LEN];
static uint8_t  s_http_head = 0;
static uint8_t  s_http_count = 0;

static uint32_t s_wifi_reconnects = 0;

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
  s_head = 0;
  s_wrapped = false;
  s_buf[0] = '\0';
  s_http_head = 0;
  s_http_count = 0;
  s_wifi_reconnects = 0;
}

static void appendRaw(const char *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    s_buf[s_head++] = data[i];
    if (s_head >= LOGBUF_SIZE) {
      s_head = 0;
      s_wrapped = true;
    }
  }
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

  appendRaw(line, n);
  if (n == 0 || line[n - 1] != '\n') {
    const char nl = '\n';
    appendRaw(&nl, 1);
  }
}

void logbufNoteHttpCode(int code) {
  s_http_codes[s_http_head] = code;
  s_http_head = (s_http_head + 1) % HTTP_CODES_LEN;
  if (s_http_count < HTTP_CODES_LEN) s_http_count++;
}

void logbufNoteWifiReconnect() {
  s_wifi_reconnects++;
}

static String getLogAsString() {
  if (!s_wrapped) {
    return String(s_buf).substring(0, s_head);
  }
  String out;
  out.reserve(LOGBUF_SIZE + 1);
  for (size_t i = 0; i < LOGBUF_SIZE; i++) {
    size_t idx = (s_head + i) % LOGBUF_SIZE;
    out += s_buf[idx];
  }
  return out;
}

String buildTelemetryJson() {
  DynamicJsonDocument doc(LOGBUF_SIZE + 1024);

  doc["fw"]                = FIRMWARE_VERSION;
  doc["uptime_s"]          = (uint32_t)(millis() / 1000);
  doc["last_reset_reason"] = resetReasonStr(esp_reset_reason());
  doc["free_heap"]         = (uint32_t)ESP.getFreeHeap();
  doc["min_free_heap"]     = (uint32_t)ESP.getMinFreeHeap();
  doc["rssi"]              = WiFi.isConnected() ? WiFi.RSSI() : 0;
  doc["wifi_reconnects"]   = s_wifi_reconnects;

  JsonArray codes = doc.createNestedArray("last_http_codes");
  for (uint8_t i = 0; i < s_http_count; i++) {
    uint8_t idx = (s_http_head + HTTP_CODES_LEN - s_http_count + i) % HTTP_CODES_LEN;
    codes.add(s_http_codes[idx]);
  }

  doc["log"] = getLogAsString();

  String out;
  serializeJson(doc, out);
  return out;
}

#include "esp_camera.h"
#include "client.h"
#include "led.h"
#include "logbuf.h"
#include "module_id.h"
#include "url.h"
#include "http_status.h"
#include "breadcrumb.h"
#include <string>
#include <time.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include "tls_roots.h" // hf::tls::kIsrgRootX1Pem — issue #79

// Module-level keep-alive clients for /upload (issue #79). Two
// storage objects — one TLS, one plain — and `postImage` picks the
// reference based on the URL scheme each call. Keeping a static of
// each rather than reconstructing per call preserves the keep-alive
// semantics within each scheme. The unused branch holds no open
// socket; the static cost is the bare object size (~few hundred
// bytes for WiFiClientSecure's ssl context pointer + ~tens for the
// plain client). HTTPClient::begin(client, url) does NOT auto-select
// — see `esp_init.cpp::initNewModuleOnServer` for the same pattern
// applied to a fresh-per-call client.
static WiFiClientSecure tlsClient;
static WiFiClient plainClient;

/*
  Creates unique filename of format: esp_capture_YYYYMMDDhhmmss.jpg
*/
String createFileName() {
  struct tm timeinfo;
  bool localTimeAvailable = getLocalTime(&timeinfo, 200);

  char buf[64];
  if (localTimeAvailable) {
    snprintf(buf, sizeof(buf),
             "esp_capture_%04d%02d%02d_%02d%02d%02d.jpg",
             timeinfo.tm_year + 1900,
             timeinfo.tm_mon + 1,
             timeinfo.tm_mday,
             timeinfo.tm_hour,
             timeinfo.tm_min,
             timeinfo.tm_sec);
  } else {
    snprintf(buf, sizeof(buf), "esp_capture_unknown_%lu.jpg", (unsigned long)millis());
    Serial.println("WARNING: Unable to get local time while creating image filename.");
  }

  Serial.printf("------ file name: %s\n", buf);
  return String(buf);
}

/*
  POST image + mac + battery + telemetry logs to the Flask /upload endpoint
*/
int postImage(esp_config_t *esp_config) {
  unsigned long __t_all_start = millis();

  char *UPLOAD_URL = esp_config->UPLOAD_URL;
  
  // Capture image (flash off)
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    return -1;
  }

  String filename = createFileName();
  String boundary = "------------------------esp32" + String(millis());

  // for now the battery percentage is randomized!
  esp_config->battery_level = random(1, 100);
  int battery_level = esp_config->battery_level;

  // Canonical 12-char lowercase-hex module ID. Previously this stringified
  // the uint64_t eFuse MAC directly via String(esp_config->esp_ID), which on
  // Arduino emits a decimal truncation (unsigned long) — not a MAC. See
  // lib/module_id/.
  String macStr = String(hf::formatModuleId(esp_config->esp_ID).c_str());

  // Telemetry payload piggybacked on the upload
  String telemetry = buildTelemetryJson();

  // --- build multipart/form-data ---
  String head =
      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"mac\"\r\n\r\n" +
      macStr + "\r\n" +

      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"battery\"\r\n\r\n" +
      String(battery_level) + "\r\n" +

      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"logs\"\r\n"
      "Content-Type: application/json\r\n\r\n" +
      telemetry + "\r\n" +

      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"image\"; filename=\"" + filename + "\"\r\n"
      "Content-Type: image/jpeg\r\n\r\n";

  String tail = "\r\n--" + boundary + "--\r\n";
  size_t contentLength = head.length() + fb->len + tail.length();

  //Serial.println("---- HEAD ----");
  //Serial.println(head);   // metadata + headers
  //Serial.println("---- TAIL ----");
  //Serial.println(tail.substring(0, 100)); // first 100 bytes of tail


  hf::Url url = hf::parseUrl(std::string(UPLOAD_URL));
  const bool useTls = (url.scheme == "https");
  WiFiClient& client = useTls ? static_cast<WiFiClient&>(tlsClient)
                              : static_cast<WiFiClient&>(plainClient);

  Serial.printf("---- trying to send image to: %s:%u (tls=%d)\n",
                url.host.c_str(), (unsigned)url.port, (int)useTls);
  // Issue #42 instrumentation: breadcrumb at each section boundary
  // inside postImage so a TASK_WDT reboot pinpoints connect-vs-write-
  // vs-read. Updates the single RTC_NOINIT slot — last writer wins.
  // No breadcrumbs inside the hot framebuffer-write or body-read loops:
  // those would flood the slot with rewrites and obscure the actual
  // last-section signal we want.
  hf::breadcrumbSet("postImage:connect");
  if (!client.connected()) {
    Serial.println("[!client.connect()]");
    if (useTls) {
      // Pin against ISRG Root X1 (Let's Encrypt) before each fresh
      // connect — only on the !connected() branch; on keep-alive
      // reuse the session was already pinned the last time the
      // socket was opened, and setCACert on a connected TLS client
      // is undefined behaviour in mbedTLS. The PEM lives in .rodata
      // via [lib/tls_roots/tls_roots.h], program lifetime, so the
      // pointer outlives every reuse. Issue #79.
      tlsClient.setCACert(hf::tls::kIsrgRootX1Pem);
    }
    if (!client.connect(url.host.c_str(), url.port)) {
      logf("[HTTP] connect failed to %s:%u",
           url.host.c_str(), (unsigned)url.port);
      client.stop();
      esp_camera_fb_return(fb);
      logbufNoteHttpCode(-2);
      return -2;
    }
    // Set socket options AFTER connect so the underlying fd exists.
    // Setting them on a not-yet-connected WiFiClientSecure triggers a
    // harmless but noisy "[E] WiFiClient.cpp:320 setSocketOption():
    // fail on -1, errno: 9, Bad file number" from the Arduino-ESP32
    // framework — the previous code paid that cost on every boot.
    client.setNoDelay(true);
    client.setTimeout(8000);
  }

  // POST headers
  hf::breadcrumbSet("postImage:write_headers");
  client.print(String("POST ") + url.path.c_str() + " HTTP/1.1\r\n");
  client.print(String("Host: ") + url.host.c_str() + "\r\n");
  client.print("Connection: keep-alive\r\n");
  client.print("Content-Type: multipart/form-data; boundary=" + boundary + "\r\n");
  client.print("Content-Length: " + String(contentLength) + "\r\n\r\n");

  // Send body
  hf::breadcrumbSet("postImage:write_body");
  client.print(head);
  size_t sent = 0;
  while (sent < fb->len) {
    size_t chunk = client.write(fb->buf + sent, min((size_t)16384, fb->len - sent));
    if (chunk == 0) {
      logf("[HTTP] body write failed at %u/%u bytes", (unsigned)sent, (unsigned)fb->len);
      client.stop();
      esp_camera_fb_return(fb);
      logbufNoteHttpCode(-3);
      return -3;
    }
    sent += chunk;
    // Keep the LED's Uploading flash visible during long writes and feed
    // the watchdog — a slow uploader can otherwise eat tens of seconds
    // here without yielding either.
    ledTick();
    esp_task_wdt_reset();
  }
  size_t tailSent = client.write((uint8_t*)tail.c_str(), tail.length());
  if (tailSent != tail.length()) {
    logf("[HTTP] tail write failed at %u/%u bytes",
         (unsigned)tailSent, (unsigned)tail.length());
    client.stop();
    esp_camera_fb_return(fb);
    logbufNoteHttpCode(-3);
    return -3;
  }

  // Read HTTP response
  hf::breadcrumbSet("postImage:read_status");
  String status = client.readStringUntil('\n');

  hf::breadcrumbSet("postImage:read_headers");
  while (client.connected()) {
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;
    esp_task_wdt_reset();
  }

  // Drain the response body so the socket is properly cleared (keep-alive
  // reuse expects an empty inbound buffer). The body's contents are not
  // consumed — image-service's /upload response shape is informational and
  // the HTTP status code below is what drives success/failure logic. An
  // older debug helper (`printResponse`) attempted to parse the body for
  // a now-defunct `circles` field and logged "JSON parse error:
  // InvalidInput" on every successful upload; removed in favour of this
  // honest drain.
  hf::breadcrumbSet("postImage:read_body");
  unsigned long start = millis();
  while (client.connected() || client.available()) {
    if (client.available()) {
      client.read();
      start = millis();
      esp_task_wdt_reset();
    } else if (millis() - start > 5000) {
      break;
    } else {
      delay(1);
    }
  }

  // The non-2xx contract (CLAUDE.md "Critical rules" historical entry):
  // parse, always note the code in logbuf, then propagate non-zero on
  // anything outside 2xx so the upstream return-value flow surfaces the
  // failure. The two helpers live in lib/http_status/ and are pinned by
  // the native test suite — refactoring out either call is now visible
  // in code review rather than silently breaking the rule.
  const int code = hf::http::parseStatusCode(std::string(status.c_str()));
  logbufNoteHttpCode(code);
  const int returnValue = hf::http::statusCodeToReturnValue(code);
  if (returnValue != 0) {
    logf("[HTTP] non-2xx %d — dropping socket", code);
    client.stop();
  }

  esp_camera_fb_return(fb);
  unsigned long __t_all_end = millis();
  Serial.println(String("---- total capture+post took ") + String((__t_all_end - __t_all_start) / 1000.0f, 3) + " seconds");

  // Return shape: the raw HTTP code (e.g. 200, 403, 500) or a negative
  // sentinel. ESP32-CAM.ino's captureAndUpload switch (`if (httpCode >=
  // 100)`) keys on this — DO NOT switch to statusCodeToReturnValue here,
  // it would collapse "200 OK" to 0 and the switch would skip the
  // success-path logging. sendHeartbeat returns the OPPOSITE shape
  // (0 for 2xx, code otherwise) because its caller only cares about
  // success/failure. The asymmetry is load-bearing for both call sites.
  return code;
}


// Hourly liveness ping — form-encoded POST to duckdb-service with
// battery / rssi / uptime / free-heap. Fails quietly; never restarts.
//
// Path is intentionally hardcoded `/heartbeat`: INIT_URL points at the
// registration endpoint (`/new_module`, which uses JSON), but heartbeat
// is a sibling on the same host:port — only the path differs. We use
// INIT_URL purely as the carrier of host+port and discard its path.
int sendHeartbeat(esp_config_t *esp_config) {
  if (WiFi.status() != WL_CONNECTED) {
    logf("[heartbeat] WiFi not connected — skipping");
    return -2;
  }

  hf::Url url = hf::parseUrl(std::string(esp_config->INIT_URL));
  const bool hbUseTls = (url.scheme == "https");
  // Canonical 12-char lowercase-hex module ID (same as /upload + /new_module).
  String macStr = String(hf::formatModuleId(esp_config->esp_ID).c_str());

  // Scheme-aware client dispatch (issue #79). Fresh client per call
  // — no keep-alive in the heartbeat path — so the TLS handshake
  // cost is paid on each iteration when INIT_URL is https. LAN-dev
  // INIT_URLs stay on plain HTTP via the non-TLS branch because the
  // dev box's duckdb-service does not terminate TLS. Pattern mirrors
  // `ota.cpp::httpOtaCheckAndApply` and `postImage` above.
  WiFiClientSecure tlsHbClient;
  WiFiClient plainHbClient;
  WiFiClient& hbClient = hbUseTls ? static_cast<WiFiClient&>(tlsHbClient)
                                  : plainHbClient;
  if (hbUseTls) {
    tlsHbClient.setCACert(hf::tls::kIsrgRootX1Pem);
  }
  hbClient.setTimeout(5000);
  // Issue #42 instrumentation: breadcrumb at each section boundary
  // inside sendHeartbeat — the per-issue suspect list calls heartbeat
  // out separately from upload. Same shape as postImage above.
  hf::breadcrumbSet("sendHeartbeat:connect");
  if (!hbClient.connect(url.host.c_str(), (uint16_t)url.port)) {
    logf("[heartbeat] connect failed to %s:%u",
         url.host.c_str(), (unsigned)url.port);
    logbufNoteHttpCode(-2);
    return -2;
  }

  String body = String("mac=") + macStr
              + "&battery=" + String(esp_config->battery_level)
              + "&rssi=" + String(WiFi.RSSI())
              + "&uptime_ms=" + String(millis())
              + "&free_heap=" + String(ESP.getFreeHeap())
              + "&fw_version=" + String(FIRMWARE_VERSION);

  hf::breadcrumbSet("sendHeartbeat:write");
  hbClient.print(String("POST /heartbeat HTTP/1.1\r\n")
               + "Host: " + String(url.host.c_str()) + ":" + String((unsigned)url.port) + "\r\n"
               + "Content-Type: application/x-www-form-urlencoded\r\n"
               + "Content-Length: " + String(body.length()) + "\r\n"
               + "Connection: close\r\n\r\n"
               + body);
  hbClient.flush();

  hf::breadcrumbSet("sendHeartbeat:read_status");
  String statusLine = hbClient.readStringUntil('\n');
  hbClient.stop();
  Serial.print("[heartbeat] ");
  Serial.println(statusLine);

  // Shared non-2xx contract — see the postImage call site above. The
  // helpers in lib/http_status/ are the single source of truth for
  // "parse + decide whether to surface as non-zero." The native test
  // suite pins both functions; the integration here is the part that
  // code review must keep honest.
  //
  // Behaviour vs. the previous inline indexOf()-based parse: the new
  // helper requires a strict "HTTP/1.1 " prefix. duckdb-service's
  // Flask backend speaks HTTP/1.1, and an HTTP/1.0 response from
  // anything else is a protocol-version mismatch that legitimately
  // belongs in the non-2xx telemetry rather than being silently
  // accepted as 200.
  const int httpCode = hf::http::parseStatusCode(std::string(statusLine.c_str()));
  logbufNoteHttpCode(httpCode);
  const int returnValue = hf::http::statusCodeToReturnValue(httpCode);
  if (returnValue != 0) {
    logf("[heartbeat] non-2xx: %d", httpCode);
  }
  // Return shape: 0 for 2xx, otherwise the raw HTTP code or negative
  // sentinel. ESP32-CAM.ino's boot-heartbeat check (`if (sendHeartbeat(...)
  // == 0)`) keys on the 0=success convention. DO NOT swap for the raw
  // code shape that postImage uses — both callers depend on this
  // asymmetry; postImage's switch needs the raw code, this caller only
  // wants pass/fail. The helpers in `lib/http_status/` produce both
  // shapes; each call site picks the right one for its caller.
  return returnValue;
}

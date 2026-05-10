#include "esp_camera.h"
#include "client.h"
#include "led.h"
#include "logbuf.h"
#include "module_id.h"
#include "url.h"
#include "breadcrumb.h"
#include <string>
#include <time.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>

static WiFiClient client;

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
  Prints circle detection JSON response
*/
void printResponse(String response) {
  DynamicJsonDocument doc(1024);
  DeserializationError error = deserializeJson(doc, response);

  if (error) {
    Serial.print("------ JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }

  Serial.println("----------------------------------------------------------------------");
  Serial.printf("--------------------- %d circles found ---------------------\n", doc["circles"].size());
  for (int i = 0; i < doc["circles"].size(); i++) {
    int radius = doc["circles"][i]["radius"];
    const char* status = doc["circles"][i]["status"];
    int x = doc["circles"][i]["x"];
    int y = doc["circles"][i]["y"];

    Serial.printf("Circle[%d]: radius=%d, status=%s, pos=(%d,%d)\n", i+1, radius, status, x, y);
  }

  const char* message = doc["message"];
  Serial.printf("Response message: %s\n", message);
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

  // Initialize client
  static bool clientInitialized = false;
  if (!clientInitialized) {
 //   client.setInsecure();
    client.setNoDelay(true);
    client.setTimeout(8000);
    clientInitialized = true;
  }

  Serial.printf("---- trying to send image to: %s:%u\n",
                url.host.c_str(), (unsigned)url.port);
  // Issue #42 instrumentation: breadcrumb at each section boundary
  // inside postImage so a TASK_WDT reboot pinpoints connect-vs-write-
  // vs-read. Updates the single RTC_NOINIT slot — last writer wins.
  // No breadcrumbs inside the hot framebuffer-write or body-read loops:
  // those would flood the slot with rewrites and obscure the actual
  // last-section signal we want.
  hf::breadcrumbSet("postImage:connect");
  if (!client.connected()) {
    Serial.println("[!client.connect()]");
    if (!client.connect(url.host.c_str(), url.port)) {
      logf("[HTTP] connect failed to %s:%u",
           url.host.c_str(), (unsigned)url.port);
      client.stop();
      esp_camera_fb_return(fb);
      logbufNoteHttpCode(-2);
      return -2;
    }
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
  }

  hf::breadcrumbSet("postImage:read_body");
  String response = "";
  unsigned long start = millis();
  while (client.connected() || client.available()) {
    if (client.available()) {
      char c = client.read();
      response += c;
      start = millis();
    } else if (millis() - start > 5000) {
      break;
    }
  }

  printResponse(response);

  int code = -4;
  if (status.startsWith("HTTP/1.1 ")) {
    code = status.substring(9, 12).toInt();
  }
  logbufNoteHttpCode(code);
  if (code < 200 || code >= 300) {
    logf("[HTTP] non-2xx %d — dropping socket", code);
    client.stop();
  }

  esp_camera_fb_return(fb);
  unsigned long __t_all_end = millis();
  Serial.println(String("---- total capture+post took ") + String((__t_all_end - __t_all_start) / 1000.0f, 3) + " seconds");

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
  // Canonical 12-char lowercase-hex module ID (same as /upload + /new_module).
  String macStr = String(hf::formatModuleId(esp_config->esp_ID).c_str());

  WiFiClient hbClient;
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

  // Parse the HTTP status from the first response line. Format is
  // "HTTP/1.1 200 OK\r\n"; we want the integer between the first and
  // second space. Anything not 2xx is a real upload failure that
  // belongs in the telemetry ring buffer.
  hf::breadcrumbSet("sendHeartbeat:read_status");
  String statusLine = hbClient.readStringUntil('\n');
  hbClient.stop();
  Serial.print("[heartbeat] ");
  Serial.println(statusLine);

  int firstSpace = statusLine.indexOf(' ');
  int secondSpace = statusLine.indexOf(' ', firstSpace + 1);
  int httpCode = -4; // sentinel: invalid/missing response
  if (firstSpace > 0 && secondSpace > firstSpace) {
    httpCode = statusLine.substring(firstSpace + 1, secondSpace).toInt();
  }
  logbufNoteHttpCode(httpCode);
  if (httpCode < 200 || httpCode >= 300) {
    logf("[heartbeat] non-2xx: %d", httpCode);
    return httpCode;
  }
  return 0;
}
#include "esp_camera.h"
#include "client.h"
#include <time.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WifiClient.h>
#include <Arduino.h>
#include <ArduinoJson.h>

static WiFiClient client;
/*
  Extracts host, port, and endpoint path from URL
*/
static url_t splitUrl(const char* urlChars) {
  url_t url;
  url.port = 443;
  url.path = "/";

  String urlString(urlChars);
  int doubleslashPosition = urlString.indexOf("://");
  int hostIndex = doubleslashPosition >= 0 ? doubleslashPosition + 3 : 0;

  int slash = urlString.indexOf('/', hostIndex);
  String host = slash >= 0 ? urlString.substring(hostIndex, slash) : urlString.substring(hostIndex);

  if (slash >= 0) {
    url.path = urlString.substring(slash);
  }

  int colon = host.indexOf(':');
  if (colon >= 0) {
    url.host = host.substring(0, colon);
    url.port = host.substring(colon + 1).toInt();
  } else {
    url.host = host;
  }
  return url;
}

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
  POST image + mac + battery to the Flask /upload endpoint
*/
int postImage(esp_config_t *esp_config) {
  unsigned long __t_all_start = millis();

  char *UPLOAD_URL = esp_config->UPLOAD_URL;
  
  // Capture image
  digitalWrite(4, HIGH);
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { 
    digitalWrite(4, LOW);
    return -1; 
  }
  delay(100);
  digitalWrite(4, LOW);

  String filename = createFileName();
  String boundary = "------------------------esp32" + String(millis());

  // Convert battery level to 0-1 float string
  float batteryFloat = esp_config->battery_level / 100.0f;
  //String batteryStr = String(batteryFloat, 2);
  
  float battery = random(1, 101) / 100.0; // randomizes battery percentage - later, here comes the actual battery %
  String batteryStr = String(battery);
  
  String macStr = String(esp_config->esp_ID);

  // --- build multipart/form-data ---
  String head =
      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"mac\"\r\n\r\n" +
      macStr + "\r\n" +

      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"battery\"\r\n\r\n" +
      batteryStr + "\r\n" +

      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"image\"; filename=\"" + filename + "\"\r\n"
      "Content-Type: image/jpeg\r\n\r\n";

  String tail = "\r\n--" + boundary + "--\r\n";
  size_t contentLength = head.length() + fb->len + tail.length();

  //Serial.println("---- HEAD ----");
  //Serial.println(head);   // metadata + headers
  //Serial.println("---- TAIL ----");
  //Serial.println(tail.substring(0, 100)); // first 100 bytes of tail


  url_t url = splitUrl(UPLOAD_URL);

  // Initialize client
  static bool clientInitialized = false;
  if (!clientInitialized) {
 //   client.setInsecure();
    client.setNoDelay(true);
    client.setTimeout(8000);
    clientInitialized = true;
  }

  Serial.printf("---- trying to send image to: %s:%u\n", url.host, url.port);
  if (!client.connected()) {
    Serial.println("[!client.connect()]");
    if (!client.connect(url.host.c_str(), url.port)) {
      Serial.println("[!client.connect(xxx)]");
      esp_camera_fb_return(fb);
      return -2;
    }
  }

  // POST headers
  client.print(String("POST ") + url.path + " HTTP/1.1\r\n");
  client.print(String("Host: ") + url.host + "\r\n");
  client.print("Connection: keep-alive\r\n");
  client.print("Content-Type: multipart/form-data; boundary=" + boundary + "\r\n");
  client.print("Content-Length: " + String(contentLength) + "\r\n\r\n");

  // Send body
  client.print(head);
  size_t sent = 0;
  while (sent < fb->len) {
    size_t chunk = client.write(fb->buf + sent, min((size_t)16384, fb->len - sent));
    if (chunk == 0) {
      client.stop();
      esp_camera_fb_return(fb);
      return -3;
    }
    sent += chunk;
  }
  client.write((uint8_t*)tail.c_str(), tail.length());
  //client.print(tail);

  // Read HTTP response
  String status = client.readStringUntil('\n');

  while (client.connected()) {
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;
  }

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
  if (code < 200 || code >= 300) client.stop();

  esp_camera_fb_return(fb);
  unsigned long __t_all_end = millis();
  Serial.println(String("---- total capture+post took ") + String((__t_all_end - __t_all_start) / 1000.0f, 3) + " seconds");

  return code;
}
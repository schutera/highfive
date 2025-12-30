/*
  ESP32-CAM WiFi Connect and Scan Example (with LED blink)
  - Scans for available WiFi networks and prints them to the Serial Monitor
  - Attempts to connect to the specified WiFi network and prints the IP address
  - Blinks the onboard LED while connecting
*/

#include <WiFi.h> // ESP32 only supports this library for WiFi
#include "secrets.h"

#define LED_PIN 33 // Onboard LED for most ESP32-CAM modules

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.begin(115200);
  Serial.println();
  Serial.println("[WiFi Scan] Starting scan...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  int n = WiFi.scanNetworks();
  Serial.println("[WiFi Scan] Scan done");
  bool found = false;
  if (n == 0) {
    Serial.println("[WiFi Scan] No networks found");
  } else {
    Serial.printf("[WiFi Scan] %d networks found:\n", n);
    for (int i = 0; i < n; ++i) {
      Serial.printf("  %d: %s (RSSI: %d) %s\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i), (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "OPEN" : "");
      if (WiFi.SSID(i) == WIFI_SSID) found = true;
      delay(10);
    }
  }
  if (found) {
    Serial.println("[WiFi Scan] Target SSID found!");
  } else {
    Serial.println("[WiFi Scan] Target SSID NOT found!");
  }

  Serial.printf("\nConnecting to SSID: %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Blink LED
    tries++;
  }
  digitalWrite(LED_PIN, LOW); // Turn off LED after connect attempt
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected!");
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());
    // Optionally, turn LED on solid to indicate success
    digitalWrite(LED_PIN, HIGH);
  } else {
    Serial.println("\nWiFi connection failed.");
  }
}

void loop() {}

#pragma once
#include <WiFiClientSecure.h>

// The one place a TLS client is configured for this firmware. Every
// WiFiClientSecure call site (upload, heartbeat, OTA manifest/binary,
// boot registration, geolocation) funnels through configureBoundedClient
// so the CA-pin + bounded-handshake pairing can't drift apart and a new
// TLS site can't silently inherit the ESP32 120 s handshake default.
//
// Why this exists: before this helper the pairing lived in six
// copy-pasted blocks across client.cpp / ota.cpp / esp_init.cpp. A
// seventh site that forgot setHandshakeTimeout would reopen the #148
// reboot-loop class (a stalled 120 s handshake exceeds the 60 s
// task-WDT budget → watchdog reboot). See issue #185 and the
// longhorn/carpenter entry in docs/11-risks-and-technical-debt.
//
// ESP-only: depends on WiFiClientSecure, so it is not host-testable and
// is not compiled into the native test env (no native test includes it).

namespace hf {
namespace tls {

// TLS handshake timeout, in seconds. The ESP32 default is 120 s; bounding
// it to 8 s keeps a stalled handshake comfortably under the 60 s task-WDT
// budget while leaving ample room for a healthy handshake to the pinned
// servers. Named so the value has a single home (#148 / #186 / #185).
inline constexpr uint8_t kHandshakeTimeoutSec = 8;

// Pin the given CA PEM and bound the handshake on `client`. Call on a
// fresh (not-yet-connected) TLS client, before connect(); the caller
// supplies the trust anchor (hf::tls::kIsrgRootX1Pem for
// highfive.schutera.com, hf::tls::kGoogleApisCaBundlePem for
// googleapis.com — both from lib/tls_roots).
void configureBoundedClient(WiFiClientSecure& client, const char* caPem);

}  // namespace tls
}  // namespace hf

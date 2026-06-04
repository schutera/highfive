# ADR-018: Optional WPA2-Enterprise WiFi (username + password) for onboarding

## Status

Accepted.

## Context

Issue [#63](https://github.com/schutera/highfive/issues/63): a user could
not connect a module to a WiFi that requires a **username in addition to a
password** — WPA2-Enterprise (802.1X), the auth scheme used by eduroam and
most university/corporate networks. The firmware only ever joined with
`WiFi.begin(ssid, password)` (`ESP32-CAM/esp_init.cpp`'s
`setupWifiConnection`), which is WPA2-Personal (PSK) only. The onboarding
captive portal (`ESP32-CAM/host.cpp`) likewise collected only SSID +
password.

WPA2-Enterprise has many flavours (PEAP, TTLS, TLS, FAST; inner methods
MSCHAPv2, GTC, PAP …). Supporting the full matrix — especially EAP-TLS
client certificates — is a large surface (cert upload/storage on the ESP,
a bigger form, more flash). The issue's framing is "user and password",
which maps cleanly onto username+password EAP.

A hard constraint: this must not regress the existing fleet. Every module
already deployed joins a personal network with no username, and that path
must stay byte-for-byte unchanged.

## Decision

Add an **optional** `USERNAME` field to the WiFi config. When it is empty
(the default, and every existing `config.json`), the firmware runs the
unchanged WPA2-Personal path. When it is non-empty, the firmware joins via
the `esp_wpa2.h` enterprise APIs
(`esp_wifi_sta_wpa2_ent_set_identity/username/password` +
`esp_wifi_sta_wpa2_ent_enable`, then `WiFi.begin(ssid)` with no PSK) —
PEAP/TTLS with MSCHAPv2, which the ESP32 negotiates from the credentials.

Scope decisions, all chosen for minimal surface against the stated need:

- **EAP method: username + password only.** PEAP/TTLS + MSCHAPv2. No
  EAP-TLS / client certificates.
- **Single identity field.** The operator-entered username is used as both
  the EAP outer identity and the inner username. No separate anonymous
  outer identity (an eduroam privacy nicety) for now.
- **No RADIUS server-certificate validation.** The ESP accepts the
  network's auth server without verifying its certificate. This is the
  common ESP32 enterprise configuration and "just works" across
  deployments, but it is a real security tradeoff (see Consequences).
- **Surface: captive portal + `config.json`.** The username is entered on
  the ESP's own captive-portal form (where SSID/password are entered
  today) and persisted to `NETWORK.USERNAME` in `config.json`, so USB /
  `uploadfs` provisioning works too. The homepage SetupWizard stays
  instructional — it does not push config to the ESP.

The PSK-vs-enterprise decision is isolated in the host-testable
`ESP32-CAM/lib/wifi_auth/`'s `hf::wifiAuthMode`, per
[ADR-002](adr-002-esp-host-testable-lib.md), so the load-bearing branch is
pinned in CI without a radio. A whitespace-only username is treated as
empty there, so a stray space typed into the optional field can't silently
flip a personal-WiFi module onto the enterprise path.

## Consequences

### Positive

- Modules can join eduroam / university / corporate WiFi with a username
  and password.
- Backward compatible: empty username → the exact prior PSK join. No
  struct-layout change for existing fields (USERNAME is appended), no new
  required field, the `loadConfig` required-field gate is untouched.
- The branch decision is host-tested (`test_native_wifi_auth`), and the
  portal's `username` form parsing is pinned in `test_native_form_query`.

### Negative / costs

- **No server-cert validation = rogue-AP exposure.** Without verifying the
  RADIUS server certificate, an attacker who stands up an AP with the same
  SSID can complete the EAP handshake and capture the MSCHAPv2 exchange
  (offline-crackable). This is weaker than the firmware's posture
  elsewhere (it CA-pins googleapis per
  [ADR-010](adr-010-esp-firmware-tls-trust-model.md)). Accepted for now to
  meet "just let me log in"; a future ADR can add optional CA-cert pinning.
- **No anonymous outer identity.** On privacy-conscious eduroam configs
  the real username is sent in the clear outer identity. Acceptable for
  the stated use; revisit if needed.
- **Flash.** Linking the `esp_wpa2` enterprise stack grows the binary; it
  still fits the `min_spiffs` app partition (verified by
  `pio run -e esp32cam`).
- **Unescaped reflection.** The username is echoed back into the
  captive-portal form's `value="…"` without HTML-escaping — the same
  trust-the-operator softAP behaviour as the existing SSID field in
  `ESP32-CAM/host.cpp`'s `sendConfigForm`. It is not a new class of
  exposure, but if escaping is ever added to the portal, the username
  field belongs on the list alongside SSID.

### Out of scope (deferred)

EAP-TLS client certificates; RADIUS server-certificate validation; a
separate anonymous/outer identity field. Tracked as known limitations in
[chapter 11](../11-risks-and-technical-debt/README.md).

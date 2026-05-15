# ADR-010: ESP firmware TLS — CA-pinned trust anchors for `highfive.schutera.com` and `googleapis.com`

## Status

Accepted

## Context

Until issue #79, the ESP32-CAM firmware spoke plain HTTP to four endpoints on the HiveHive server stack: `POST /new_module` (registration), `POST /upload` (image + telemetry), `POST /heartbeat` (liveness), and `GET /firmware.json` + `/firmware.app.bin` (OTA). The single `HIGHFIVE_API_KEY` shared secret rode on those connections in clear-text on every shared-WiFi hop. A passive sniff on any LAN segment between a module and the server captured the key and gave full server compromise.

Probes against `highfive.schutera.com` on 2026-05-14 showed Mark's nginx already terminating TLS on every relevant path with a Let's Encrypt cert chain (R13 intermediate → ISRG Root X1) and HSTS set on the API + upload responses. The server was ready; the firmware was the sole remaining HTTP consumer.

[`ESP32-CAM/esp_init.cpp`'s `getGeolocation`](../../ESP32-CAM/esp_init.cpp) was already using `https://www.googleapis.com/...` via Arduino-ESP32's `HTTPClient`, but with no explicit `setCACert` — so the firmware was negotiating TLS without verifying peer identity. The WiFi-AP fingerprint sent to Google's geolocation API was therefore exposed to any MITM presenting a self-signed cert.

Alternatives considered:

- **`setInsecure()`** — encrypts the payload but accepts any cert. Cheap to deploy. Rejected: an attacker on the path can present a self-signed cert and proxy the entire conversation. Encryption without verification is theatre.
- **Cert pinning** — pin Mark's exact leaf cert SHA-256 fingerprint. Rejected: Let's Encrypt rotates leaf certs every 90 days. Each rotation would brick deployed modules until a synchronized OTA push, and a missed rotation strands the fleet.
- **HMAC-over-HTTP** — sign each request with a derived key. Rejected: solves authentication but not confidentiality. The API key still rides plain on the wire, just now alongside a signature.
- **mTLS / per-device client certs** — strongest defence, but requires a per-device PKI on the server. Out of scope; tracked as a separate threat model.

## Decision

CA-pin against the _self-signed root_ of each authority we trust:

| Anchor                                                                                                          | Trusts                                             |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `hf::tls::kIsrgRootX1Pem` in [`ESP32-CAM/lib/tls_roots/tls_roots.h`](../../ESP32-CAM/lib/tls_roots/tls_roots.h) | Let's Encrypt issuance for `highfive.schutera.com` |
| `hf::tls::kGtsRootR1Pem` in the same header                                                                     | Google issuance for `www.googleapis.com`           |

Both PEMs are embedded as `inline constexpr char[]` at namespace scope. `.rodata` on the ESP32 is flash-mapped, so no PROGMEM macro is needed and the pointer has program lifetime — which is the contract `WiFiClientSecure::setCACert` requires (the cert must outlive every connection using it).

Arduino-ESP32's `HTTPClient::begin(client, url)` does NOT auto-select between `WiFiClient` and `WiFiClientSecure` based on the URL scheme — it uses whatever client the caller passed. Each call site therefore implements its own scheme-aware dispatch: parse the URL with `hf::parseUrl`, branch on `scheme == "https"`, hold a `WiFiClient&` reference to either a pre-allocated `WiFiClientSecure` (with `setCACert` applied) or a plain `WiFiClient`, and pass that reference into `HTTPClient::begin` (or directly into a raw socket `connect`). LAN-dev topologies (`http://10.0.0.5:8002/...`) route through the plain branch because the dev-box services do not terminate TLS.

The five call sites:

- [`ESP32-CAM/esp_init.cpp`'s `initNewModuleOnServer`](../../ESP32-CAM/esp_init.cpp) — registration. Scheme-aware dispatch, ISRG Root X1 on the TLS branch.
- [`ESP32-CAM/esp_init.cpp`'s `getGeolocation`](../../ESP32-CAM/esp_init.cpp) — geolocation. URL is hardcoded `https://www.googleapis.com/...` so the dispatch is unconditional TLS with GTS Root R1.
- [`ESP32-CAM/client.cpp`'s `postImage`](../../ESP32-CAM/client.cpp) — image upload. Two module-level static clients (one TLS, one plain) preserve keep-alive within each scheme; the per-call reference picks based on `UPLOAD_URL`'s scheme. ISRG Root X1 on the TLS branch.
- [`ESP32-CAM/client.cpp`'s `sendHeartbeat`](../../ESP32-CAM/client.cpp) — heartbeat. Fresh client per call (no keep-alive), scheme-aware dispatch, ISRG Root X1 on the TLS branch.
- [`ESP32-CAM/ota.cpp`'s `httpOtaCheckAndApply`](../../ESP32-CAM/ota.cpp) — manifest + binary fetch. Scheme-aware dispatch, ISRG Root X1 on the TLS branch. Originally tracked separately as issue #81; folded into the same PR.

The five sites share the same shape and could be centralised behind a `hf::tls::selectClient(tlsStorage, plainStorage, scheme, caRootPem)` helper. Deferred for this PR — the inline pattern is small enough that the cross-references in the comments are easier to follow than chasing a single-call helper. If a sixth site appears, factor.

## Consequences

**Enables.** The `HIGHFIVE_API_KEY`, operator email in the `/new_module` payload, image bodies, telemetry, and the WiFi-fingerprint geolocation request all become opaque to any passive listener on the WiFi path. A MITM attempting to substitute a server presents a cert the firmware refuses to verify against ISRG Root X1, breaking the handshake before any byte of the request leaves.

**Costs.** Each TLS handshake costs ~30–50 KB heap transiently and ~1–2 s wall-clock on the wire. The 60 s `TASK_WDT_TIMEOUT_S` budget in [`ESP32-CAM/ESP32-CAM.ino`'s `setup`](../../ESP32-CAM/ESP32-CAM.ino) covers it comfortably. The two embedded PEMs add ~3 KB to the flash image (RAM is `.rodata`, no heap cost outside the handshake). The `static WiFiClientSecure` in `postImage` is slightly larger than the prior `WiFiClient` — observable as ~50 bytes additional RAM usage in the static segment. Boot-log heap measurement at first flash should confirm the runtime free-heap stays above the ~30 KB floor needed for a clean TLS handshake.

**Forecloses.** A 2030 Let's Encrypt root rotation will require shipping new firmware with the new ISRG root. ADR-008 OTA gives a non-USB path for that update, so the cost-of-getting-it-wrong has dropped enough to make this trade-off acceptable. Embedding both ISRG Root X1 and X2 (the alternate ECDSA root, also published by Let's Encrypt) would add another ~1 KB of flash and give a longer migration runway — deferred until a concrete rotation is on the horizon.

**Migration.** Pre-#79 modules baked `http://highfive.schutera.com/*` URLs into SPIFFS. [`hf::rewriteLegacyHighfiveUrl`](../../ESP32-CAM/lib/form_query/form_query.h) rewrites those values on the first boot after the OTA delivers post-#79 firmware. Both `loadConfig` readers apply the rewrite in memory, and the main-firmware reader in [`ESP32-CAM/esp_init.cpp`'s `loadConfig`](../../ESP32-CAM/esp_init.cpp) persists the migration back to SPIFFS once. The migration is idempotent, anchored at the literal `http://highfive.schutera.com` prefix (substring matches inside query strings are not touched), and host-tested in `test_native_form_query`.

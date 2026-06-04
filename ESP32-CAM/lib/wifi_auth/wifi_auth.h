#pragma once

// WiFi authentication-mode decision for the onboarding path (issue #63).
//
// The firmware historically only spoke WPA2-Personal (PSK): a single SSID
// + password, joined with `WiFi.begin(ssid, password)`. Networks that
// require a *username* in addition to a password — WPA2-Enterprise
// (PEAP/TTLS + MSCHAPv2), the auth scheme used by eduroam and most
// university/corporate WiFi — could not be joined at all.
//
// The username is an OPTIONAL config field. When it is empty the legacy
// PSK path must run byte-for-byte unchanged (backward compatibility is a
// hard requirement of this feature); when it is set, the firmware switches
// to the WPA2-Enterprise join path. This header isolates that one-line
// decision so it is host-testable without a radio — the branch is the
// load-bearing part: a regression that flipped the default would silently
// break every personal-WiFi module in the field.

namespace hf {

enum class WifiAuthMode {
  // No username configured → WPA2-Personal (PSK) or open network. The
  // legacy `WiFi.begin(ssid, password)` path.
  PersonalOrOpen,
  // A username is configured → WPA2-Enterprise (PEAP/TTLS + MSCHAPv2),
  // joined via the esp_wpa2 enterprise APIs.
  Enterprise,
};

// Decide the auth mode from the configured username.
//
// A username that is null, empty, or whitespace-only yields
// `PersonalOrOpen` — the optional portal field is left blank by personal-
// WiFi users, and treating a stray space as "enterprise" would silently
// break their join. Any username containing at least one non-whitespace
// character yields `Enterprise`.
//
// Note: this only decides the *mode*. The credential strings handed to the
// WiFi stack are used verbatim (the firmware does not trim SSID/password
// either), so a username with surrounding whitespace that still has
// content is treated as enterprise and passed through as-is.
WifiAuthMode wifiAuthMode(const char* username);

// Convenience predicate over `wifiAuthMode`.
inline bool wifiIsEnterprise(const char* username) {
  return wifiAuthMode(username) == WifiAuthMode::Enterprise;
}

}  // namespace hf

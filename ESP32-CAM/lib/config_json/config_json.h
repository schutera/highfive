#ifndef HF_CONFIG_JSON_H
#define HF_CONFIG_JSON_H

#include <string>

namespace hf {

// Pure, host-testable read-modify-write helpers for /config.json (issue #156).
//
// Each takes the current file contents as a string and returns the updated
// JSON, preserving every key it does not touch. This is the core that lets the
// captive-portal Wi-Fi save (host.cpp::saveConfig) and the developer serial
// retargeting writers (esp_init.cpp) share one drift-proof JSON shape, and
// makes the "Wi-Fi save must not drop an out-of-band INIT_URL" invariant (R1)
// pinnable by test/test_native_config_json.
//
// Conventions for all three:
//   * Empty / whitespace-only input is treated as a fresh empty object
//     (first-time setup, before any /config.json exists).
//   * A non-empty input that fails to parse, or whose root is not a JSON
//     object (e.g. "null"), means "corrupt-but-present file": setWifiCreds
//     falls back to a fresh object (matching pre-#156 saveConfig, which always
//     built from scratch); the URL writers return "" so the caller refuses to
//     clobber it.
//   * A return value of "" means "do not write" — either the refusal above or
//     a StaticJsonDocument overflow on serialize (the #19 truncation guard).
//     Callers must check for "" before opening the file for writing.

// Set NETWORK.SSID / NETWORK.PASSWORD, preserving all other keys.
std::string setWifiCredsInConfigJson(const std::string& input,
                                     const std::string& ssid,
                                     const std::string& password);

// Set NETWORK.INIT_URL / NETWORK.UPLOAD_URL, preserving all other keys.
std::string setServerUrlsInConfigJson(const std::string& input,
                                      const std::string& initUrl,
                                      const std::string& uploadUrl);

// Remove NETWORK.INIT_URL / NETWORK.UPLOAD_URL so loadConfig's "absent =>
// baked default" path resumes. Preserves all other keys.
std::string clearServerUrlsInConfigJson(const std::string& input);

}  // namespace hf

#endif  // HF_CONFIG_JSON_H

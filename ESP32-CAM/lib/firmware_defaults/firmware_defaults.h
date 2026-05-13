#pragma once

// Shared SPIFFS-config defaults for the HiveHive ESP32-CAM firmware.
//
// Two firmware readers consume the same `/config.json` keys:
//
//   * `host.cpp::loadConfig` — captive-portal RAM shadow that backs the
//     web form. Reads with an ArduinoJson `| <fallback>` so that a
//     missing key prefills with the operator-recommended value.
//   * `esp_init.cpp::loadConfig` — production `esp_config_t` reader.
//     Reads with `| <fallback>` so a missing key falls back to the
//     "do nothing aggressive" production default. The default-init
//     block above the SPIFFS open uses the same constants for the
//     "no config file at all" path.
//
// The two fallbacks per field are NOT the same value on purpose — the
// form prefills the cadence the operator should pick, while the
// production reader picks the conservative default that won't surprise
// a deployed device. Encoding each pair as `k*FormFallback` and
// `k*ProductionFallback` makes the asymmetry survive future
// "let's deduplicate the literals" refactors.
//
// History: see chapter-11 "Dual-reader asymmetry (intentional, but
// flagged)" and "Dead-weight discovery: CAPTURE_INTERVAL is written but
// never read" — both resolved by PR-G (issues #65, #66).

namespace hf {
namespace defaults {

// ----- RESOLUTION ---------------------------------------------------------
// Form prefill is a string ("VGA", "UXGA", ...) — matches the captive-
// portal `<input>` value, fed back through `getResolutionFromString` on
// load. Production fallback is the `esp_camera` `framesize_t` enum value;
// declared here as a plain `int` to keep this header free of
// `<esp_camera.h>` (consumers cast at the assignment site).
//   FRAMESIZE_UXGA == 10 in esp_camera framework headers.
constexpr const char* kResolutionFormFallback       = "VGA";
constexpr int         kResolutionProductionFallback = 10;  // FRAMESIZE_UXGA

// ----- VERTICAL_FLIP ------------------------------------------------------
// Form default is "no flip"; production default is "flip" because the
// physical orientation of the camera in a deployed nest box requires it.
// Operators who reconfigure via the form normally want to keep the flip
// — they just see a 0 in the field because the form prefill predates
// the production fallback being defined.
constexpr int kVerticalFlipFormFallback       = 0;
constexpr int kVerticalFlipProductionFallback = 1;

// ----- BRIGHTNESS ---------------------------------------------------------
// Form default is "no adjustment"; production default is "+1" because
// the typical nest-box lighting is dim enough that the small boost
// improves classification headroom.
constexpr int kBrightnessFormFallback       = 0;
constexpr int kBrightnessProductionFallback = 1;

// ----- SATURATION ---------------------------------------------------------
// Form default is "no adjustment"; production default is "-1" because
// slight desaturation reduces colour artefacts on the OV2640 sensor.
constexpr int kSaturationFormFallback       = 0;
constexpr int kSaturationProductionFallback = -1;

}  // namespace defaults
}  // namespace hf

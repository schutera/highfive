#pragma once

#include <cstdint>
#include <cstddef>

namespace hf {

// Hard cap on the OTA app size. The `min_spiffs` partition table sets
// each app slot to ~1.9 MB; any manifest claiming `app_size` larger
// than this is rejected during parse so a malformed/malicious manifest
// can't trick the firmware into starting an Update.begin() that would
// fail mid-stream. Round number, not the exact slot boundary, so the
// check rejects clearly-bogus values without rejecting borderline-valid
// ones (the runtime Update.begin() does the precise capacity check).
constexpr uint32_t HF_OTA_MAX_APP_BYTES = 1900000;

// Decoded OTA manifest from `firmware.json`. Sized for compile-time
// allocation (no heap) since the firmware-side parser runs early in
// setup() where heap fragmentation is least welcome.
//
// `sequence` and `allow_downgrade` are PR II additions for issue #83.
// The pre-#83 manifest carried only `version` + `app_md5` + `app_size`;
// `parseOtaManifest` now REQUIRES `sequence` (loud-fail on absence so
// an operator forgetting to bump SEQUENCE in firmware.json is visible
// rather than silently re-introducing the strcmp downgrade behaviour).
struct OtaManifest {
    char version[32];        // bee-name version string, NUL-terminated
    char app_md5[33];        // 32 hex chars + NUL
    uint32_t app_size;
    uint32_t sequence;       // monotonic, operator-bumped — see ADR-006 + ADR-008 addendum
    bool allow_downgrade;    // optional in JSON; defaults to false
};

// True iff the manifest's version differs from the running firmware
// AND `current_sequence` is non-zero AND (the manifest's sequence is
// strictly greater than the running sequence OR the manifest
// explicitly sets `allow_downgrade: true`).
//
// Pre-#83 this was plain `strcmp(current, manifest) != 0`, which
// flashed in either direction — surfaced during the PR #82 smoke test
// as a one-shot downgrade pingpong (chapter-11 lesson "OTA
// `shouldOtaUpdate` accepts downgrades"). The 3-arg form removes the
// regression at the type level: any caller that wants to compare a
// manifest must also pass the running sequence, and any manifest that
// doesn't carry one fails to parse.
//
// `current_sequence == 0` is the dev escape hatch (round-3 senior-
// review P1). Arduino-IDE compiles that bypass `build.sh` /
// `extra_scripts.py` end up with `FIRMWARE_SEQUENCE = 0` via the
// fallback in `esp_init.h`. Without this guard a dev binary would
// silently auto-flash to whatever fleet release `/firmware.json`
// advertises — the operator must USB-flash a properly-built binary
// before OTA can take over.
//
// NULL or empty `current_version`, NULL `manifest.version`, or empty
// `manifest.version` all return false — a malformed input is a "do not
// update" signal, not a reason to flash anyway.
bool shouldOtaUpdate(const char* current_version, uint32_t current_sequence,
                     const OtaManifest& manifest);

// Parse the manifest body. Returns false (and leaves *out unchanged)
// on: NULL inputs, malformed JSON, missing `version`/`app_md5`/
// `app_size`/`sequence` fields, an `app_md5` that isn't 32 lowercase-hex
// chars, an `app_size` outside (0, HF_OTA_MAX_APP_BYTES], or a
// non-uint32 `sequence`. Returns true and populates *out otherwise.
// `allow_downgrade` is optional in the JSON: absent → false; literal
// `true` → true; anything else (literal `false`, `1`, `"true"`, etc.)
// → false. The literal-only acceptance is deliberate — we want a typo
// to fail closed (refuse to downgrade) rather than open. Other fields
// (`md5`, `built_at`) are ignored — they belong to the web-installer
// consumer of the same manifest file.
bool parseOtaManifest(const char* json_body, OtaManifest* out);

}  // namespace hf

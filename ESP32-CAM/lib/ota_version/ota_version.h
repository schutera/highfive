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
struct OtaManifest {
    char version[32];    // bee-name version string, NUL-terminated
    char app_md5[33];    // 32 hex chars + NUL
    uint32_t app_size;
};

// True if the manifest's version differs from the running firmware.
// Bee-name comparison (per ADR-006) is plain string equality, not
// semver — the version names are unordered. NULL or empty on either
// side returns false: a malformed manifest is a "do not update" signal,
// not a reason to flash anyway.
bool shouldOtaUpdate(const char* current_version, const char* manifest_version);

// Parse the manifest body. Returns false (and leaves *out unchanged)
// on: NULL inputs, malformed JSON, missing `version`/`app_md5`/
// `app_size` fields, an `app_md5` that isn't 32 lowercase-hex chars,
// or an `app_size` outside (0, HF_OTA_MAX_APP_BYTES]. Returns true and
// populates *out otherwise. Other fields (`md5`, `built_at`) are
// ignored — they belong to the web-installer consumer of the same
// manifest file.
bool parseOtaManifest(const char* json_body, OtaManifest* out);

}  // namespace hf

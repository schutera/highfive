#include "ota_version.h"

#include <cctype>
#include <cstring>
#include <cstdlib>

namespace hf {

namespace {

// Find `"key":` in `json` and return the offset of the byte just past
// the colon (skipping any whitespace), or -1 if the key is absent. The
// match must be on a quoted-key boundary so a value that happens to
// contain the key bytes (e.g. {"foo":"app_size"}) cannot false-match.
// Only flat single-level objects are supported — sufficient for the
// manifest shape this library is paired with. If a future manifest
// grows a nested object with a same-named field
// (e.g. `{"meta":{"app_size":99},"app_size":1024}`) the parser
// returns whichever appears first in the byte stream; that is a
// loud-failure design choice (the manifest contract is "flat") rather
// than a silent one (best-match heuristics).
long long findValueStart(const char* json, const char* key) {
    if (!json || !key) return -1;
    const size_t keyLen = std::strlen(key);
    // Caller's responsibility to pass a sensible key (non-empty,
    // reasonable length); guard against an empty key so the search
    // loop terminates.
    if (keyLen == 0) return -1;
    const size_t jsonLen = std::strlen(json);
    if (jsonLen < keyLen + 4) return -1;  // "":""  minimum framing

    for (size_t i = 0; i + keyLen + 2 < jsonLen; ++i) {
        if (json[i] != '"') continue;
        if (std::memcmp(json + i + 1, key, keyLen) != 0) continue;
        if (json[i + 1 + keyLen] != '"') continue;
        size_t j = i + 2 + keyLen;
        while (j < jsonLen && (json[j] == ' ' || json[j] == '\t')) ++j;
        if (j >= jsonLen || json[j] != ':') continue;  // {"app_size_other":...}
        ++j;
        while (j < jsonLen && (json[j] == ' ' || json[j] == '\t')) ++j;
        return static_cast<long long>(j);
    }
    return -1;
}

// Copy a JSON string value at `start` into `out` (NUL-terminated, up to
// `outLen-1` chars). Returns false if the value isn't a quoted string,
// is empty, exceeds `outLen-1`, or contains a backslash-escape (we do
// not unescape; the manifest values are bee names and hex digits with
// no need for escapes).
bool copyStringValue(const char* json, long long start, char* out, size_t outLen) {
    if (start < 0 || !json || !out || outLen == 0) return false;
    if (json[start] != '"') return false;
    size_t i = static_cast<size_t>(start) + 1;
    size_t w = 0;
    while (json[i] != '\0' && json[i] != '"') {
        if (json[i] == '\\') return false;  // unsupported by design
        if (w + 1 >= outLen) return false;  // truncation, reject
        out[w++] = json[i++];
    }
    if (json[i] != '"') return false;       // unterminated
    if (w == 0) return false;               // empty
    out[w] = '\0';
    return true;
}

// Parse a non-negative integer at `start`. Returns false on non-digit
// first char or on overflow past UINT32_MAX. Stops at the first
// non-digit byte; surrounding JSON punctuation (`,`, `}`, whitespace)
// is left for the caller to ignore.
bool parseUint32(const char* json, long long start, uint32_t* out) {
    if (start < 0 || !json || !out) return false;
    size_t i = static_cast<size_t>(start);
    if (json[i] < '0' || json[i] > '9') return false;
    uint64_t acc = 0;
    while (json[i] >= '0' && json[i] <= '9') {
        acc = acc * 10 + static_cast<uint64_t>(json[i] - '0');
        if (acc > 0xFFFFFFFFULL) return false;
        ++i;
    }
    *out = static_cast<uint32_t>(acc);
    return true;
}

bool isLowerHex(const char* s, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        const char c = s[i];
        const bool digit = (c >= '0' && c <= '9');
        const bool lower = (c >= 'a' && c <= 'f');
        if (!digit && !lower) return false;
    }
    return true;
}

}  // namespace

bool shouldOtaUpdate(const char* current_version, const char* manifest_version) {
    if (!current_version || !manifest_version) return false;
    if (current_version[0] == '\0' || manifest_version[0] == '\0') return false;
    return std::strcmp(current_version, manifest_version) != 0;
}

bool parseOtaManifest(const char* json_body, OtaManifest* out) {
    if (!json_body || !out) return false;

    OtaManifest tmp{};

    if (!copyStringValue(json_body,
                         findValueStart(json_body, "version"),
                         tmp.version, sizeof(tmp.version))) {
        return false;
    }
    if (!copyStringValue(json_body,
                         findValueStart(json_body, "app_md5"),
                         tmp.app_md5, sizeof(tmp.app_md5))) {
        return false;
    }
    if (std::strlen(tmp.app_md5) != 32 || !isLowerHex(tmp.app_md5, 32)) {
        return false;
    }
    if (!parseUint32(json_body,
                     findValueStart(json_body, "app_size"),
                     &tmp.app_size)) {
        return false;
    }
    if (tmp.app_size == 0 || tmp.app_size > HF_OTA_MAX_APP_BYTES) {
        return false;
    }

    *out = tmp;
    return true;
}

}  // namespace hf

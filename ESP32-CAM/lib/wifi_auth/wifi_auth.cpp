#include "wifi_auth.h"

namespace hf {

namespace {
// Whitespace classes the onboarding form can realistically deliver after
// url-decoding: space, tab, CR, LF. Kept local + explicit rather than
// pulling <cctype> so the predicate's behavior is identical on-device and
// on the host test runner regardless of locale.
bool isFormWhitespace(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}
}  // namespace

WifiAuthMode wifiAuthMode(const char* username) {
  if (username == nullptr) {
    return WifiAuthMode::PersonalOrOpen;
  }
  for (const char* p = username; *p != '\0'; ++p) {
    if (!isFormWhitespace(*p)) {
      return WifiAuthMode::Enterprise;
    }
  }
  return WifiAuthMode::PersonalOrOpen;
}

}  // namespace hf

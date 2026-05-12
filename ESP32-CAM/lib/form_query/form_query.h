#pragma once

#include <string>

namespace hf {

// Percent-decode an application/x-www-form-urlencoded value.
//
// Behavior is deliberately byte-compatible with the original Arduino-String
// implementation that lived in host.cpp, so that the on-device WiFi
// onboarding flow keeps parsing form submissions exactly as before:
//
//   * '+' is decoded to ' '.
//   * "%XX" is decoded as a hex pair (case-insensitive, [0-9A-Fa-f]). The
//     decoder requires two characters AFTER the '%', i.e. it only triggers
//     when (i + 2 < src.length()). A trailing "%" or "%X" with insufficient
//     characters is passed through literally.
//   * Any other character is copied through unchanged.
//
// Note: the original implementation does not validate that hex chars are in
// the [0-9A-Fa-f] range — non-hex characters fall through the `isdigit`
// branch and are processed as if they were uppercase letters. That quirk is
// preserved here so the refactor is a pure lift.
std::string urlDecode(const std::string& src);

// Extract a single named parameter from a urlencoded query string.
//
// `query` is of the form "key1=value1&key2=value2&...". The returned value
// is urlDecode()'d. Returns an empty string if `name` is not present.
//
// Behavior is deliberately byte-compatible with the original Arduino-String
// implementation that lived in host.cpp:
//
//   * Search uses a substring match for "<name>=", so a query of
//     "password=secret" will satisfy a lookup for name="pass" if a longer
//     match does not appear earlier. This pre-existing quirk is preserved.
//   * The value runs from immediately after "<name>=" up to the next '&'
//     or the end of the string.
//   * The returned value is urlDecode()'d.
std::string getParam(const std::string& query, const std::string& name);

// Resolve a "keep current on empty submission" form field.
//
// Returns trim(submitted) if non-empty after trim; otherwise returns
// current verbatim. Pins the captive-portal `/save` "blank means keep
// current" contract — see docs/11-risks-and-technical-debt/README.md
// "Captive-portal JS validator and /save handler are two halves of
// one contract (issue #46)" for the load-bearing semantics. Extracted
// into a host-testable helper at issue #57.
//
// Whitespace set: space, tab, CR, LF, VT, FF — matches Arduino
// String::trim() so the behaviour is byte-compatible with the inline
// code at host.cpp's runAccessPoint that this helper replaces.
std::string resolveKeepCurrentField(const std::string& submitted,
                                    const std::string& current);

}  // namespace hf

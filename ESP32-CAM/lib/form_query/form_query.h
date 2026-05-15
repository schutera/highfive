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

// Three-field-per-URL split for the captive-portal form (issue #79).
//
// Splits a URL like `https://highfive.schutera.com/upload` or
// `http://192.168.0.36:8002/new_module` into the operator-facing
// fields the captive portal renders: a base (scheme + host, no
// port, no trailing slash), an optional port-as-string (empty if
// the URL had no explicit port — even if the scheme has a default
// like 443 for https), and an endpoint (the path with no leading
// slash). The inverse is `joinUrlFromForm`.
//
// Edge cases preserved verbatim:
//   * Empty input → all three fields empty.
//   * Missing "://" → input is not a URL; all three fields empty.
//   * URL with no path (e.g. `http://example.com`) → endpoint empty.
//   * URL with trailing slash (`http://example.com/`) → endpoint empty.
//   * Port with non-digit characters → captured as-is; `joinUrlFromForm`
//     will pass it through unchanged so the eventual form validator
//     can flag it.
struct FormUrlParts {
    std::string base;      // e.g. "https://highfive.schutera.com"
    std::string port;      // e.g. "8002", or "" when implicit
    std::string endpoint;  // e.g. "upload"
};
FormUrlParts splitUrlForForm(const std::string& url);

// Inverse of `splitUrlForForm`. Recombines into a normalised URL:
//   * Trailing slashes on `base` are stripped.
//   * Leading slashes on `endpoint` are stripped.
//   * If `port` is empty, no `:port` is emitted.
//   * If `port` matches the scheme default (80 for http, 443 for
//     https), it is also omitted — preferred form is the implicit
//     port. Operators editing a production URL on a dev box won't
//     accidentally pin `:443` into the saved config.
//   * If both base and endpoint are present, a single '/' separator
//     is inserted; otherwise output is `<base>` alone (which may be
//     empty if base itself was empty).
std::string joinUrlFromForm(const std::string& base,
                            const std::string& port,
                            const std::string& endpoint);

// One-time SPIFFS-URL migration for #79. Rewrites a saved URL of the
// form `http://highfive.schutera.com[:port][/path]` to the same URL
// with scheme `https://`. Other URLs (LAN-dev IPs, hosts that aren't
// highfive.schutera.com, URLs that already start with `https://`,
// the empty string) are returned unchanged.
//
// Used by both `esp_init.cpp::loadConfig` and `host.cpp::loadConfig`
// so SPIFFS configs written by pre-#79 firmware (which baked
// http://highfive.schutera.com into config.json) transparently
// migrate on the first boot of post-#79 firmware. Idempotent: a
// second call on the migrated value returns the value unchanged.
//
// The prefix match is anchored at byte 0 and uses the exact literal
// `http://highfive.schutera.com` — substring matches (e.g. a URL
// like `http://example.com/?proxy=highfive.schutera.com`) are NOT
// rewritten, by design. See the dual-reader convention in
// `lib/firmware_defaults/firmware_defaults.h` for why this helper
// is host-testable rather than inlined.
std::string rewriteLegacyHighfiveUrl(const std::string& url);

// Server-side complement to the captive-portal JS port validator
// (issue #79). Returns `true` when `port` is acceptable as the port
// field of a saved URL: an empty string (operator wants the scheme
// default — 80 for http, 443 for https), or a sequence of ASCII
// digits that parses into the inclusive range 1..65535. Returns
// `false` for non-digits, leading whitespace, scientific notation,
// negative signs, an empty digit run between digits, or values
// outside the range.
//
// The JS validator in `host.cpp`'s `sendConfigForm` enforces the
// same rule client-side; this helper closes the gap when the form
// is bypassed (curl, JS-disabled browser, custom client). On a
// `false` return the `/save` handler in `host.cpp` re-renders the
// form without persisting to SPIFFS so an operator typo doesn't
// brick the next boot.
bool isValidPortString(const std::string& port);

}  // namespace hf

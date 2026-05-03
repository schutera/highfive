#pragma once

#include <cstdint>
#include <string>

namespace hf {

struct Url {
    std::string scheme;       // "http", "https", or "" if absent
    std::string host;
    uint16_t port = 0;        // resolved: scheme default if URL omits :port
    std::string path = "/";
};

// Parse a URL into its parts. Defaults:
//   scheme: "" if the URL has no "<scheme>://" prefix
//   port:   80 for "http", 443 for "https", 0 otherwise
//   path:   "/" if the URL has no path component
//
// Robust to malformed input: an unparseable port falls back to the
// scheme default rather than throwing. Designed to be the single
// source of truth for URL parsing, replacing the ad-hoc splitUrl()
// in client.cpp once the firmware is migrated.
Url parseUrl(const std::string& urlStr);

}  // namespace hf

#include "url.h"

#include <cstdlib>

namespace hf {

namespace {

uint16_t defaultPortForScheme(const std::string& scheme) {
    if (scheme == "https") return 443;
    if (scheme == "http") return 80;
    return 0;
}

bool tryParsePort(const std::string& s, uint16_t& out) {
    if (s.empty()) return false;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
    }
    char* end = nullptr;
    long v = std::strtol(s.c_str(), &end, 10);
    if (end == s.c_str() || *end != '\0') return false;
    if (v <= 0 || v > 65535) return false;
    out = static_cast<uint16_t>(v);
    return true;
}

}  // namespace

Url parseUrl(const std::string& urlStr) {
    Url url;

    // Optional "<scheme>://"
    size_t schemeEnd = urlStr.find("://");
    size_t hostStart = 0;
    if (schemeEnd != std::string::npos) {
        url.scheme = urlStr.substr(0, schemeEnd);
        hostStart = schemeEnd + 3;
    }

    // Path begins at the first '/' after the host
    size_t pathStart = urlStr.find('/', hostStart);
    std::string hostPort;
    if (pathStart != std::string::npos) {
        hostPort = urlStr.substr(hostStart, pathStart - hostStart);
        url.path = urlStr.substr(pathStart);
    } else {
        hostPort = urlStr.substr(hostStart);
    }

    // host[:port]
    size_t colon = hostPort.find(':');
    if (colon != std::string::npos) {
        url.host = hostPort.substr(0, colon);
        uint16_t parsed = 0;
        if (tryParsePort(hostPort.substr(colon + 1), parsed)) {
            url.port = parsed;
        }
    } else {
        url.host = hostPort;
    }

    if (url.port == 0) {
        url.port = defaultPortForScheme(url.scheme);
    }

    return url;
}

}  // namespace hf

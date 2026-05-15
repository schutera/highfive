#include "form_query.h"

#include <cctype>
#include <cstddef>

namespace hf {

std::string urlDecode(const std::string& src) {
    std::string decoded;
    decoded.reserve(src.size());
    char c;
    for (size_t i = 0; i < src.length(); i++) {
        c = src[i];
        if (c == '+') {
            decoded += ' ';
        } else if (c == '%' && i + 2 < src.length()) {
            char h1 = src[i + 1];
            char h2 = src[i + 2];
            // Match the original on-device behavior verbatim: digits go to
            // their numeric value, and anything else is treated as if it
            // were an uppercase hex letter via (toupper(c) - 'A' + 10).
            // Non-hex inputs are not validated — same quirk as before.
            int hi = std::isdigit(static_cast<unsigned char>(h1))
                         ? h1 - '0'
                         : std::toupper(static_cast<unsigned char>(h1)) - 'A' + 10;
            int lo = std::isdigit(static_cast<unsigned char>(h2))
                         ? h2 - '0'
                         : std::toupper(static_cast<unsigned char>(h2)) - 'A' + 10;
            decoded += static_cast<char>(hi * 16 + lo);
            i += 2;
        } else {
            decoded += c;
        }
    }
    return decoded;
}

std::string getParam(const std::string& query, const std::string& name) {
    std::string key = name + "=";
    std::size_t start = query.find(key);
    if (start == std::string::npos) return "";
    start += key.length();
    std::size_t end = query.find('&', start);
    if (end == std::string::npos) end = query.length();
    std::string value = query.substr(start, end - start);
    return urlDecode(value);
}

std::string resolveKeepCurrentField(const std::string& submitted,
                                    const std::string& current) {
    // Whitespace set matches Arduino String::trim() (space, tab, CR, LF,
    // VT, FF). `find_first_not_of` is used over a loop with `std::isspace`
    // because the std::string predicate-free APIs are simpler and avoid
    // any <locale>-related surprises in the host-native build.
    static const char* kWhitespace = " \t\n\r\v\f";
    const std::size_t first = submitted.find_first_not_of(kWhitespace);
    if (first == std::string::npos) return current;  // empty or all-whitespace
    const std::size_t last = submitted.find_last_not_of(kWhitespace);
    return submitted.substr(first, last - first + 1);
}

FormUrlParts splitUrlForForm(const std::string& url) {
    FormUrlParts out;
    if (url.empty()) return out;

    const std::size_t schemeEnd = url.find("://");
    if (schemeEnd == std::string::npos) return out;  // not a URL

    const std::size_t hostStart = schemeEnd + 3;
    if (hostStart >= url.size()) {
        // Just `scheme://` with no host — treat as malformed; pass
        // through to base so the operator sees what they entered.
        out.base = url;
        return out;
    }

    // End of host is either ':' (explicit port follows) or '/' (path
    // follows) or end-of-string.
    const std::size_t hostEnd = url.find_first_of(":/", hostStart);
    if (hostEnd == std::string::npos) {
        // `scheme://host` — no port, no path.
        out.base = url;
        return out;
    }

    out.base = url.substr(0, hostEnd);

    std::size_t pathStart;
    if (url[hostEnd] == ':') {
        const std::size_t portStart = hostEnd + 1;
        pathStart = url.find('/', portStart);
        const std::size_t portEnd =
            (pathStart == std::string::npos) ? url.size() : pathStart;
        out.port = url.substr(portStart, portEnd - portStart);
    } else {
        // url[hostEnd] == '/' — path starts here, no explicit port.
        pathStart = hostEnd;
    }

    if (pathStart != std::string::npos && pathStart < url.size()) {
        // Strip the leading '/' on the path so it renders as an
        // endpoint name (e.g. "upload") rather than "/upload".
        const std::size_t endpointStart =
            (url[pathStart] == '/') ? pathStart + 1 : pathStart;
        if (endpointStart < url.size()) {
            out.endpoint = url.substr(endpointStart);
        }
    }
    return out;
}

namespace {

bool portMatchesSchemeDefault(const std::string& base,
                              const std::string& port) {
    if (port == "80" && base.rfind("http://", 0) == 0) return true;
    if (port == "443" && base.rfind("https://", 0) == 0) return true;
    return false;
}

void rtrimSlash(std::string& s) {
    while (!s.empty() && s.back() == '/') s.pop_back();
}

void ltrimSlash(std::string& s) {
    std::size_t i = 0;
    while (i < s.size() && s[i] == '/') ++i;
    if (i > 0) s.erase(0, i);
}

}  // namespace

std::string rewriteLegacyHighfiveUrl(const std::string& url) {
    // `sizeof(literal) - 1` gives the strlen of a string literal at
    // compile time without re-counting bytes — drift-proof against a
    // future "tighten the prefix" edit.
    static constexpr char kLegacyPrefix[] = "http://highfive.schutera.com";
    static constexpr std::size_t kLegacyPrefixLen = sizeof(kLegacyPrefix) - 1;
    if (url.size() < kLegacyPrefixLen) return url;
    if (url.compare(0, kLegacyPrefixLen, kLegacyPrefix) != 0) return url;
    // Match. Compose the migrated value: "https://" + remainder
    // (skip the legacy scheme "http://" = 7 bytes).
    return std::string("https://") + url.substr(7);
}

bool isValidPortString(const std::string& port) {
    if (port.empty()) return true;  // empty = scheme default
    // Reject leading zeros on multi-digit values — "00080" and "080"
    // are not canonical and would round-trip badly: `joinUrlFromForm`
    // emits the literal port into the URL, and `portMatchesSchemeDefault`
    // does an exact string compare against "80"/"443", so a saved
    // `http://host:00080/path` would NOT scheme-default-strip on the
    // next form render.
    if (port.size() > 1 && port[0] == '0') return false;
    // No internal whitespace, no signs, no exponents — strict digits.
    unsigned long acc = 0;
    for (char c : port) {
        if (c < '0' || c > '9') return false;
        acc = acc * 10u + static_cast<unsigned long>(c - '0');
        if (acc > 65535u) return false;  // early-exit on overflow
    }
    return acc >= 1u && acc <= 65535u;
}

std::string joinUrlFromForm(const std::string& base,
                            const std::string& port,
                            const std::string& endpoint) {
    std::string normBase = base;
    std::string normEndpoint = endpoint;
    rtrimSlash(normBase);
    ltrimSlash(normEndpoint);

    std::string out = normBase;
    if (!port.empty() && !portMatchesSchemeDefault(normBase, port)) {
        out += ":";
        out += port;
    }
    if (!normEndpoint.empty()) {
        if (!out.empty()) out += "/";
        out += normEndpoint;
    }
    return out;
}

}  // namespace hf

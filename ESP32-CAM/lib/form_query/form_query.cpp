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

}  // namespace hf

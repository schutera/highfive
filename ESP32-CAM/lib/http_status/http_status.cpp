#include "http_status.h"

namespace hf {
namespace http {

namespace {

constexpr const char* kHttp11Prefix = "HTTP/1.1 ";
constexpr size_t kHttp11PrefixLen = 9;  // strlen("HTTP/1.1 ")

}  // namespace

int parseStatusCode(const std::string& statusLine) {
    if (statusLine.size() < kHttp11PrefixLen + 3) {
        return kInvalidStatus;
    }
    if (statusLine.compare(0, kHttp11PrefixLen, kHttp11Prefix) != 0) {
        return kInvalidStatus;
    }

    int code = 0;
    for (size_t i = kHttp11PrefixLen; i < kHttp11PrefixLen + 3; ++i) {
        const char c = statusLine[i];
        if (c < '0' || c > '9') {
            return kInvalidStatus;
        }
        code = code * 10 + (c - '0');
    }

    // Constrain to the HTTP status-code space. 0xx/6xx etc. are not
    // valid; bounce them to the same sentinel as a parse failure so the
    // caller's "non-2xx" path covers both shapes uniformly.
    if (code < 100 || code > 599) {
        return kInvalidStatus;
    }
    return code;
}

int statusCodeToReturnValue(int httpCode) {
    if (httpCode >= 200 && httpCode < 300) {
        return 0;
    }
    return httpCode;
}

}  // namespace http
}  // namespace hf

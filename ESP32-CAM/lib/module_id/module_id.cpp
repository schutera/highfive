#include "module_id.h"

#include <cstdio>

namespace hf {

std::string formatModuleId(uint64_t mac) {
    // 12 hex chars + null terminator. snprintf is used (rather than streams
    // or hand-rolled hex) because it has identical behavior on the host
    // toolchain and on xtensa-gcc, and produces the canonical format in a
    // single call. Only the lower 48 bits are emitted; any higher bits in
    // the eFuse MAC value are deliberately discarded.
    char buf[13];
    std::snprintf(
        buf, sizeof(buf),
        "%02x%02x%02x%02x%02x%02x",
        static_cast<unsigned>((mac >> 40) & 0xFFu),
        static_cast<unsigned>((mac >> 32) & 0xFFu),
        static_cast<unsigned>((mac >> 24) & 0xFFu),
        static_cast<unsigned>((mac >> 16) & 0xFFu),
        static_cast<unsigned>((mac >>  8) & 0xFFu),
        static_cast<unsigned>((mac      ) & 0xFFu));
    return std::string(buf);
}

}  // namespace hf

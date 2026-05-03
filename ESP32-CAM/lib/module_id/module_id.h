#pragma once

#include <cstdint>
#include <string>

namespace hf {

// Format a 48-bit MAC (carried in the lower 48 bits of `mac`) as the
// canonical HiveHive module ID: exactly 12 lowercase hex characters,
// no separators, no prefix. Example: 0xAABBCCDDEEFFULL -> "aabbccddeeff".
//
// This is the single source of truth for the on-the-wire module-ID
// shape that every HiveHive service validates against. The firmware
// must never emit a decimal stringification of the eFuse MAC again
// (which is what String(uint64_t) silently does on Arduino, since its
// String constructor takes unsigned long and truncates).
//
// Returns std::string so the helper stays Arduino-agnostic and is
// host-testable under PlatformIO's `native` env. Call sites that need
// an Arduino String can wrap with `String(formatModuleId(mac).c_str())`.
std::string formatModuleId(uint64_t mac);

}  // namespace hf

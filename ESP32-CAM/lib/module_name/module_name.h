#pragma once

#include <cstdint>
#include <string>

namespace hf {

// Generate a bee-themed three-word module name from the device MAC.
//
// The previous in-line implementation seeded indices into the
// ADJECTIVES / FRUITS / ANIMALS word lists from only mac[0..2]. On
// little-endian ESP32 those positions hold the LSB three octets of
// ESP.getEfuseMac(), which are the manufacturer-shared trailing bytes
// for same-batch devices — confirmed in the field with two distinct
// modules (b0:69:6e:f2:3a:08 and e8:9f:a9:f2:3a:08) both registering
// as "fierce-apricot-specht". See issue #92.
//
// This helper XORs paired bytes so all six MAC octets contribute to
// every word index: mac[0]^mac[3], mac[1]^mac[4], mac[2]^mac[5].
// Same-batch devices that share their trailing octets will diverge in
// at least one word as soon as a single byte of the unique prefix
// differs.
//
// The caller passes the six MAC bytes in whatever order the firmware
// reads them; on the ESP32, that is the byte view of ESP.getEfuseMac()
// (which is little-endian-packed, so mac[0] is the LSB octet). The
// helper does not interpret endianness — it treats the six bytes as
// opaque input, which makes it deterministic on the host test bench.
//
// Returns std::string for host-testability (matches the convention in
// lib/module_id/). Call sites that need an Arduino String can wrap
// with `String(moduleNameFromMac(mac).c_str())`.
std::string moduleNameFromMac(const uint8_t mac[6]);

}  // namespace hf

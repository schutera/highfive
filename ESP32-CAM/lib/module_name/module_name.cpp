#include "module_name.h"

#include <cstddef>
#include <cstdint>

namespace hf {

// 32 × 32 × 32 = 32,768 unique combinations.
// Animals are lowercase German names with umlauts substituted (ae/ue/oe)
// so they stay ASCII-safe across the URL/JSON/filename pipeline.
// Moved here from esp_init.cpp (issue #92) so the indexing logic is
// host-testable independent of the Arduino runtime.
namespace {

constexpr std::size_t kWordListSize = 32;

const char* const kAdjectives[kWordListSize] = {
    "swift",   "brave", "quiet", "bright",  "gentle",  "proud", "calm",  "eager",
    "fierce",  "glad",  "happy", "jolly",   "kind",    "lively","merry", "noble",
    "patient", "pure",  "quick", "ready",   "smart",   "strong","tame",  "vivid",
    "wise",    "witty", "young", "loyal",   "sleek",   "spry",  "mild",  "keen",
};

const char* const kFruits[kWordListSize] = {
    "plum",   "grape",   "fig",       "lime",      "pear",       "kiwi",       "guava",      "date",
    "apple",  "mango",   "peach",     "lemon",     "melon",      "berry",      "cherry",     "papaya",
    "lychee", "quince",  "pomelo",    "raisin",    "banana",     "currant",    "olive",      "coconut",
    "citron", "ackee",   "apricot",   "mulberry",  "persimmon",  "nectarine",  "raspberry",  "blackberry",
};

const char* const kAnimals[kWordListSize] = {
    "wolf",    "fuchs",  "baer",    "luchs",   "dachs",   "iltis",   "marder",  "otter",
    "biber",   "hase",   "eule",    "uhu",     "falke",   "milan",   "adler",   "reh",
    "hirsch",  "elch",   "specht",  "kraehe",  "amsel",   "spatz",   "meise",   "star",
    "schwan",  "ente",   "gans",    "reiher",  "storch",  "kuckuck", "forelle", "hecht",
};

}  // namespace

std::string moduleNameFromMac(const uint8_t mac[6]) {
    // XOR-paired indices so all six MAC bytes contribute to every word.
    // Pre-PR-#1 code took mac[0], mac[1], mac[2] directly — and on the
    // little-endian ESP32 those are the manufacturer-shared trailing
    // octets, so two devices in the same production batch could
    // produce identical names. With pairing, devices whose unique
    // prefix octets differ in any byte position cannot collide on the
    // corresponding word.
    const std::size_t adj_idx    = static_cast<std::size_t>(mac[0] ^ mac[3]) % kWordListSize;
    const std::size_t fruit_idx  = static_cast<std::size_t>(mac[1] ^ mac[4]) % kWordListSize;
    const std::size_t animal_idx = static_cast<std::size_t>(mac[2] ^ mac[5]) % kWordListSize;
    return std::string(kAdjectives[adj_idx]) + "-" + kFruits[fruit_idx] + "-" + kAnimals[animal_idx];
}

}  // namespace hf

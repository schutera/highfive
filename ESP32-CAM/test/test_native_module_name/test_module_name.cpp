// Native (host) unit tests for hf::moduleNameFromMac.
//
// Run with:  pio test -e native
//
// These tests pin the post-#92 behaviour: indices into the three 32-entry
// word lists are derived from all six MAC bytes via XOR pairs so the
// same-batch field collision (two distinct devices both registering as
// "fierce-apricot-specht") cannot regress.

#include <unity.h>

#include <cstdint>
#include <cstring>
#include <set>
#include <string>

#include "module_name.h"

using hf::moduleNameFromMac;

void setUp() {}
void tearDown() {}

namespace {

// All adjectives / fruits / animals from module_name.cpp, kept in sync
// here so a test can prove every word produced is from the valid list
// (i.e. the modulo wrap is correct, no out-of-bounds char* read).
const char* const kAdjectives[] = {
    "swift", "brave", "quiet", "bright", "gentle", "proud", "calm", "eager",
    "fierce", "glad", "happy", "jolly", "kind", "lively", "merry", "noble",
    "patient", "pure", "quick", "ready", "smart", "strong", "tame", "vivid",
    "wise", "witty", "young", "loyal", "sleek", "spry", "mild", "keen",
};
const char* const kFruits[] = {
    "plum", "grape", "fig", "lime", "pear", "kiwi", "guava", "date",
    "apple", "mango", "peach", "lemon", "melon", "berry", "cherry", "papaya",
    "lychee", "quince", "pomelo", "raisin", "banana", "currant", "olive", "coconut",
    "citron", "ackee", "apricot", "mulberry", "persimmon", "nectarine", "raspberry", "blackberry",
};
const char* const kAnimals[] = {
    "wolf", "fuchs", "baer", "luchs", "dachs", "iltis", "marder", "otter",
    "biber", "hase", "eule", "uhu", "falke", "milan", "adler", "reh",
    "hirsch", "elch", "specht", "kraehe", "amsel", "spatz", "meise", "star",
    "schwan", "ente", "gans", "reiher", "storch", "kuckuck", "forelle", "hecht",
};

bool inList(const std::string& word, const char* const* list, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i) {
        if (word == list[i]) return true;
    }
    return false;
}

}  // namespace

// --- determinism --------------------------------------------------------

static void test_same_mac_produces_same_name(void) {
    const uint8_t mac[6] = {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF};
    const std::string a = moduleNameFromMac(mac);
    const std::string b = moduleNameFromMac(mac);
    TEST_ASSERT_EQUAL_STRING(a.c_str(), b.c_str());
}

static void test_all_zero_mac_produces_first_words(void) {
    // 0 XOR 0 = 0 → first word in each list. Pins the index-zero path so a
    // future XOR-formula change that broke the all-zero degenerate case
    // would fail loudly here rather than silently in a corner of the
    // distribution.
    const uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
    TEST_ASSERT_EQUAL_STRING("swift-plum-wolf", moduleNameFromMac(mac).c_str());
}

// --- field-collision regression -----------------------------------------

static void test_same_batch_macs_produce_different_names(void) {
    // Field incident, issue #92: two distinct devices both registered as
    // "fierce-apricot-specht". Their MACs share the trailing three
    // octets (f2:3a:08), and on the little-endian ESP32 those octets
    // land at mac[0..2] of the byte view of ESP.getEfuseMac(). Under
    // the pre-PR-#1 logic that picked indices from mac[0..2] alone,
    // the two devices were indistinguishable. The XOR-pair fix uses
    // all six bytes, so the divergence in the unique-prefix octets
    // (mac[3..5]) forces the names apart.
    //
    // Byte order below matches what the firmware sees: ESP.getEfuseMac()
    // returns a uint64_t whose lower 48 bits are the MAC; the cast to
    // uint8_t* exposes mac[0] = LSB octet. So for MAC `b0:69:6e:f2:3a:08`,
    // mac[0..5] = {08, 3a, f2, 6e, 69, b0}.
    const uint8_t mac_a[6] = {0x08, 0x3a, 0xf2, 0x6e, 0x69, 0xb0};  // b0:69:6e:f2:3a:08
    const uint8_t mac_b[6] = {0x08, 0x3a, 0xf2, 0xa9, 0x9f, 0xe8};  // e8:9f:a9:f2:3a:08

    const std::string a = moduleNameFromMac(mac_a);
    const std::string b = moduleNameFromMac(mac_b);
    TEST_ASSERT_TRUE_MESSAGE(a != b,
        "Same-batch MACs must not produce identical names (issue #92).");
}

// --- shape / format -----------------------------------------------------

static void test_name_has_two_hyphens(void) {
    const uint8_t mac[6] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66};
    const std::string s = moduleNameFromMac(mac);
    // Count hyphens.
    std::size_t hyphens = 0;
    for (char c : s) {
        if (c == '-') ++hyphens;
    }
    TEST_ASSERT_EQUAL_INT(2, hyphens);
}

static void test_name_parts_are_in_word_lists(void) {
    // Any MAC should produce a name whose three hyphen-separated parts
    // each belong to the corresponding word list. This guards against an
    // off-by-one in the modulo wrap or an out-of-bounds read.
    const uint8_t mac[6] = {0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE};
    const std::string s = moduleNameFromMac(mac);
    const std::size_t h1 = s.find('-');
    const std::size_t h2 = s.find('-', h1 + 1);
    TEST_ASSERT_TRUE(h1 != std::string::npos && h2 != std::string::npos);

    const std::string adj    = s.substr(0, h1);
    const std::string fruit  = s.substr(h1 + 1, h2 - h1 - 1);
    const std::string animal = s.substr(h2 + 1);

    TEST_ASSERT_TRUE_MESSAGE(inList(adj,    kAdjectives, 32), "adjective must be in list");
    TEST_ASSERT_TRUE_MESSAGE(inList(fruit,  kFruits,     32), "fruit must be in list");
    TEST_ASSERT_TRUE_MESSAGE(inList(animal, kAnimals,    32), "animal must be in list");
}

// --- distribution -------------------------------------------------------

static void test_distinct_unique_prefixes_diverge(void) {
    // Pin the actual point of #92: when the shared-suffix bytes are
    // identical but the unique-prefix bytes differ, the resulting names
    // must diverge. Sweep over all 256 values of the third unique-prefix
    // byte (mac[5]); collect the resulting names. They must not all
    // collapse to the same string.
    std::set<std::string> seen;
    for (int b = 0; b < 256; ++b) {
        const uint8_t mac[6] = {
            0x08, 0x3a, 0xf2,  // shared suffix (LE: trailing octets of MAC)
            0x6e, 0x69,        // shared prefix
            static_cast<uint8_t>(b),
        };
        seen.insert(moduleNameFromMac(mac));
    }
    // The XOR pairs (b ^ 0x08) is what drives the adjective index; sweeping
    // 256 values through `% 32` cycles through all 32 adjectives, so the
    // set should contain at least all 32 distinct adjective stems. Just
    // assert "more than one" to keep the test resilient to wordlist edits.
    TEST_ASSERT_TRUE_MESSAGE(seen.size() > 1,
        "Sweeping a unique-prefix byte must produce more than one name.");
}

extern "C" int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_same_mac_produces_same_name);
    RUN_TEST(test_all_zero_mac_produces_first_words);
    RUN_TEST(test_same_batch_macs_produce_different_names);
    RUN_TEST(test_name_has_two_hyphens);
    RUN_TEST(test_name_parts_are_in_word_lists);
    RUN_TEST(test_distinct_unique_prefixes_diverge);
    return UNITY_END();
}

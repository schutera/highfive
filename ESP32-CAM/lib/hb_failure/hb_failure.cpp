#include "hb_failure.h"

#ifdef ARDUINO
// RTC_NOINIT_ATTR places the variables in RTC slow memory and tells the
// runtime not to zero them on boot. Survives software reset, wiped on POR.
// Same storage class as lib/breadcrumb — see that header for the rationale.
#include <esp_attr.h>
#define HF_HB_FAILURE_ATTR RTC_NOINIT_ATTR
#else
// Native (host) tests: file-static storage models "survives soft reset"
// within a single test process. setUp() resets state per case.
#define HF_HB_FAILURE_ATTR
#endif

namespace {

// Magic guard so indeterminate RTC contents on a cold boot don't masquerade
// as a valid streak. False-positive odds: 1 in 4 billion per power-on,
// acceptable for diagnostic data. Distinct value from breadcrumb's so a
// confused debugger can tell the two slots apart in an RTC dump.
constexpr std::uint32_t kMagic = 0x48424641u;  // "HBFA"

HF_HB_FAILURE_ATTR std::uint32_t s_magic;
HF_HB_FAILURE_ATTR int s_code;
HF_HB_FAILURE_ATTR std::uint32_t s_count;

}  // namespace

namespace hf {

void hbFailureNote(int code) {
    if (s_magic != kMagic) {
        // First note after a cold boot (or after a clear): start fresh so we
        // never add to RTC garbage.
        s_count = 0;
    }
    s_magic = kMagic;
    s_code = code;
    s_count += 1;
}

void hbFailureClear() {
    s_magic = kMagic;
    s_code = 0;
    s_count = 0;
}

HbFailure hbFailurePeek() {
    if (s_magic != kMagic) {
        return HbFailure{};  // {0, 0} — fail-closed on indeterminate memory
    }
    HbFailure out;
    out.code = s_code;
    out.count = s_count;
    return out;
}

}  // namespace hf

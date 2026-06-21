#include "capture_gate.h"

#ifdef ARDUINO
// RTC_NOINIT_ATTR places the variables in RTC slow memory and tells the
// runtime not to zero them on boot. Survives software reset, wiped on POR.
// Same storage class as lib/breadcrumb and lib/hb_failure — see those headers
// for the rationale.
#include <esp_attr.h>
#define HF_CAPTURE_GATE_ATTR RTC_NOINIT_ATTR
#else
// Native (host) tests: file-static storage models "survives soft reset"
// within a single test process. captureGateClearForTest() resets it per case.
#define HF_CAPTURE_GATE_ATTR
#endif

namespace {

// Magic guard so indeterminate RTC contents on a cold boot don't masquerade
// as a valid stored timestamp. Distinct value from breadcrumb's and
// hb_failure's so a confused debugger can tell the three slots apart in an
// RTC dump.
constexpr std::uint32_t kMagic = 0x43475431u;  // "CGT1"

HF_CAPTURE_GATE_ATTR std::uint32_t s_magic;
HF_CAPTURE_GATE_ATTR std::uint32_t s_last_epoch;

}  // namespace

namespace hf {

bool captureGateShouldCapture(std::uint32_t nowEpoch, std::uint32_t windowSec) {
    if (nowEpoch < kMinPlausibleEpoch) {
        // No synced clock — can't measure a window. Fail open (capture).
        return true;
    }
    if (s_magic != kMagic) {
        // Power-on / first boot / cleared: no anchor. Capture (this is exactly
        // the genuine-power-cycle case we want to always image).
        return true;
    }
    if (nowEpoch < s_last_epoch) {
        // Clock moved backwards (NTP correction, manual set). Fail open rather
        // than throttle on a nonsensical negative interval.
        return true;
    }
    return (nowEpoch - s_last_epoch) >= windowSec;
}

void captureGateNote(std::uint32_t nowEpoch) {
    if (nowEpoch < kMinPlausibleEpoch) {
        // Never anchor the window to a pre-NTP bogus epoch.
        return;
    }
    s_magic = kMagic;
    s_last_epoch = nowEpoch;
}

void captureGateClearForTest() {
    s_magic = 0;
    s_last_epoch = 0;
}

}  // namespace hf

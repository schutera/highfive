#include "breadcrumb.h"

#include <cstdint>
#include <cstring>

#ifdef ARDUINO
// RTC_NOINIT_ATTR places the variable in RTC slow memory and tells the
// runtime not to zero it on boot. Survives software reset, wiped on POR.
#include <esp_attr.h>
#define HF_BREADCRUMB_ATTR RTC_NOINIT_ATTR
#else
// Native (host) tests: file-static storage models "survives soft reset"
// well enough — within a single test process the variables retain values
// across calls. setUp() in the Unity test resets state per case.
#define HF_BREADCRUMB_ATTR
#endif

namespace {

// Magic guard so random RTC contents on cold-boot don't masquerade as a
// valid breadcrumb. False-positive odds: 1 in 4 billion per power-on,
// acceptable for diagnostic data.
constexpr std::uint32_t kMagic = 0xCAFEBABEu;
constexpr std::size_t kStageBufLen = 64;

HF_BREADCRUMB_ATTR std::uint32_t s_magic;
HF_BREADCRUMB_ATTR char s_stage[kStageBufLen];

}  // namespace

namespace hf {

void breadcrumbSet(const char* stage) {
    s_magic = kMagic;
    if (!stage) {
        s_stage[0] = '\0';
        return;
    }
    std::strncpy(s_stage, stage, kStageBufLen - 1);
    s_stage[kStageBufLen - 1] = '\0';
}

void breadcrumbClear() {
    s_magic = 0;
    s_stage[0] = '\0';
}

bool breadcrumbReadAndClear(char* out, std::size_t outLen) {
    if (s_magic != kMagic) {
        breadcrumbClear();
        return false;
    }
    if (out && outLen > 0) {
        std::strncpy(out, s_stage, outLen - 1);
        out[outLen - 1] = '\0';
    }
    breadcrumbClear();
    return true;
}

}  // namespace hf

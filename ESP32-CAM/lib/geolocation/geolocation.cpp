#include "geolocation.h"

#include <cmath>

namespace hf {

bool isPlausibleFix(float lat, float lng, float acc) {
    if (std::isnan(lat) || std::isnan(lng) || std::isnan(acc)) return false;
    if (acc <= 0.0f) return false;
    if (lat == 0.0f && lng == 0.0f) return false;
    if (lat > 90.0f || lat < -90.0f) return false;
    if (lng > 180.0f || lng < -180.0f) return false;
    return true;
}

float roundCoord(float value) {
    if (std::isnan(value) || std::isinf(value)) return value;
    // factor = 10 ^ kPublicCoordDecimals; the static_assert guards the
    // literal so a precision change can't silently drift from the constant.
    static_assert(kPublicCoordDecimals == 2, "update factor when precision changes");
    const float factor = 100.0f;
    return std::roundf(value * factor) / factor;
}

}  // namespace hf

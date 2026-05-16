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

}  // namespace hf

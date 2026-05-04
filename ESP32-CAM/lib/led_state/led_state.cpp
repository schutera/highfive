#include "led_state.h"

namespace hf {

bool ledOnAt(LedMode mode, uint32_t now_ms) {
    switch (mode) {
        case LedMode::Off:
            return false;

        case LedMode::Connected:
            return true;

        case LedMode::Connecting: {
            // 1 Hz, 50% duty: on for [0,500), off for [500,1000).
            return (now_ms % 1000u) < 500u;
        }

        case LedMode::Failed: {
            // 5 Hz: on for [0,100), off for [100,200).
            return (now_ms % 200u) < 100u;
        }

        case LedMode::ApMode: {
            // Heartbeat: 60 ms on, 100 ms off, 60 ms on, then idle for the
            // rest of a 1600 ms period. Visually distinct from a regular
            // blink so the user can tell "captive portal up" from
            // "connecting".
            const uint32_t t = now_ms % 1600u;
            return (t < 60u) || (t >= 160u && t < 220u);
        }

        case LedMode::Uploading: {
            // 50 ms flash at the top of every 1000 ms period. Visible but
            // unobtrusive; one count per upload attempt.
            return (now_ms % 1000u) < 50u;
        }
    }
    return false;
}

}  // namespace hf

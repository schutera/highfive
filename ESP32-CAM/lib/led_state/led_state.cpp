#include "led_state.h"

namespace hf {

bool ledOnAt(LedMode mode, uint32_t elapsed_ms) {
    switch (mode) {
        case LedMode::Off:
        case LedMode::ApMode:
        case LedMode::Connecting:
        case LedMode::Connected:
            // Steady-state modes are silent. The flash LED is too bright
            // for ambient signalling — see led_state.h's contract.
            return false;

        case LedMode::Failed: {
            // Three 50 ms pulses with 150 ms gaps, then off forever.
            // Total signal length ~450 ms.
            //   [0,    50)  on
            //   [50,  200)  off
            //   [200, 250)  on
            //   [250, 400)  off
            //   [400, 450)  on
            //   [450, ...)  off
            if (elapsed_ms < 50) return true;
            if (elapsed_ms < 200) return false;
            if (elapsed_ms < 250) return true;
            if (elapsed_ms < 400) return false;
            if (elapsed_ms < 450) return true;
            return false;
        }

        case LedMode::Uploading: {
            // Single 50 ms pulse on mode entry, then off. Confirms a
            // capture-and-upload is in progress without strobing.
            return elapsed_ms < 50;
        }
    }
    return false;
}

}  // namespace hf

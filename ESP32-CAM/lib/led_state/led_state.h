#pragma once

#include <cstdint>

namespace hf {

// Operational LED feedback patterns. The on-board flash LED (GPIO 4) is
// driven by ledOnAt() below as a pure function of (mode, millis()), so the
// pattern logic is host-testable and the firmware-side driver is a thin
// digitalWrite wrapper.
//
// Patterns are tuned to be unambiguous from across a room:
//   ApMode      — heartbeat (two short pulses then a gap, ~1.6 s period)
//   Connecting  — slow blink (1 Hz, 50% duty)
//   Connected   — solid on
//   Failed      — rapid blink (5 Hz)
//   Uploading   — single short pulse at start of every period (50 ms on,
//                 ~1 s off) so the user can count uploads in the field
//   Off         — boot pre-init or after intentional shutdown
enum class LedMode : uint8_t {
    Off,
    ApMode,
    Connecting,
    Connected,
    Failed,
    Uploading,
};

// Pure decision: given a mode and a free-running millisecond clock, should
// the LED be on right now? The Arduino driver calls this every ledTick()
// and writes the result to the GPIO; that's all.
bool ledOnAt(LedMode mode, uint32_t now_ms);

}  // namespace hf

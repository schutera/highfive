#pragma once

#include <cstdint>

namespace hf {

// Operational LED feedback patterns for the AI Thinker ESP32-CAM. The
// on-board LED is the camera flash (GPIO 4) — it is bright enough to
// light a small room. Every pattern below is therefore designed to fire
// *briefly* and only when the user genuinely needs a signal. Steady-state
// modes are silent.
//
// Patterns:
//   Off / ApMode / Connecting / Connected — silent (LED never on).
//   Failed     — three 50 ms pulses with 150 ms gaps (~450 ms total),
//                then off. Visible across a room without lingering.
//   Uploading  — single 50 ms pulse on mode entry, then off. Confirms a
//                capture is in flight without blinking the user in the
//                face every second.
//
// Patterns are time-relative to the moment `ledSetMode` is called rather
// than to a free-running clock, so each invocation deterministically
// produces one full sequence and then stays silent. The Arduino driver
// records the mode-set time and passes elapsed-milliseconds to
// `ledOnAt`; no global state lives in the pure helper.
enum class LedMode : uint8_t {
    Off,
    ApMode,
    Connecting,
    Connected,
    Failed,
    Uploading,
};

// Pure decision: given a mode and the milliseconds elapsed since the
// mode was last set via ledSetMode, should the LED be on right now?
// The Arduino driver calls this every ledTick() and writes the result
// to the GPIO; that's all.
bool ledOnAt(LedMode mode, uint32_t elapsed_ms);

}  // namespace hf

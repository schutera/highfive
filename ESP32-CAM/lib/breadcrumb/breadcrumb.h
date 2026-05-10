#pragma once

#include <cstddef>

namespace hf {

// Stage breadcrumb backed by ESP32 RTC slow memory (RTC_NOINIT).
//
// The slot survives software resets — task-watchdog (`reset_reason=7`),
// panic, `ESP.restart()` — but is wiped on power-on. That is exactly the
// shape we need for issue #42: instrument every long-running call with
// `breadcrumbSet("stage:name")` so that if the next reboot is a WDT,
// `setup()` can read+clear the slot and surface the offending stage in
// the next upload's telemetry sidecar JSON. Without this, the in-RAM
// `logbuf` (BSS) gets cleared on reboot and the only post-mortem signal
// is `last_reset_reason: TASK_WDT` with no clue what was running.
//
// Pure C++17 + a single ESP-attribute macro; host-testable via a plain
// static fallback when `ARDUINO` is not defined.

void breadcrumbSet(const char* stage);

void breadcrumbClear();

// Returns true iff a valid breadcrumb existed at the time of the call.
// Clears the slot in either case so a subsequent call returns false.
// The out-buffer is always nul-terminated when `outLen > 0`.
bool breadcrumbReadAndClear(char* out, std::size_t outLen);

}  // namespace hf

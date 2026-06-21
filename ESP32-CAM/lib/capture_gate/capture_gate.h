#pragma once

#include <cstdint>

namespace hf {

// Boot-capture rate-limit guardrail (#179, spun out of #143).
//
// During the field reboot "storm" investigated in #143, a module crash-looped
// every ~40 s and took one boot smoke-test image per reboot, dumping ~90–100
// images/hour (boot_count reached 3169). This slot caps that: it records the
// wall-clock epoch of the last boot capture so that if the device reboots again
// within `kBootCaptureWindowSec`, the boot capture is skipped. A future reboot
// loop can no longer spam thousands of images, regardless of its root cause
// (which is hardened separately — #149/#148/#170; this is defence-in-depth).
//
// Storage mirrors lib/breadcrumb and lib/hb_failure: `RTC_NOINIT_ATTR` on
// device (survives software resets — ESP.restart()/TASK_WDT/panic — and is
// wiped on power-on) with a magic guard so indeterminate RTC contents on a cold
// boot can't masquerade as a real timestamp. The power-on wipe is the
// load-bearing semantic: a reboot LOOP is a chain of software resets (so it
// gets throttled), whereas a genuine unplug/redeploy is a power-on (so the slot
// is empty and the boot capture ALWAYS runs). Pure C++17 + a single
// ESP-attribute macro; host-testable via a plain static fallback when `ARDUINO`
// is not defined.

// Throttle window. The issue suggested 30–60 min; 30 min caps a worst-case
// ~40 s loop at ~48 boot images/day (vs. thousands) while a real recovery
// reboot cadence (liveness watchdog = 2 h) is never throttled.
constexpr std::uint32_t kBootCaptureWindowSec = 30u * 60u;

// Wall-clock epochs below this (≈2020-09-13) mean NTP has not synced, so we
// have no clock to measure the window against. The gate fails OPEN there
// (captures): without NTP a boot upload's filename has no real timestamp and,
// in the documented storm, successful uploads — the thing being throttled —
// required a working network anyway.
constexpr std::uint32_t kMinPlausibleEpoch = 1600000000u;

// Decide whether to take the boot smoke-test capture this boot. `nowEpoch` is
// `(uint32_t)time(nullptr)` evaluated after the setup() NTP sync. Returns true
// (capture) on: no clock yet, no valid stored timestamp (power-on / first boot
// / cleared), a backwards clock, or a stored timestamp older than `windowSec`.
// Returns false (throttle) only when a valid recent capture is on record.
bool captureGateShouldCapture(std::uint32_t nowEpoch, std::uint32_t windowSec);

// Record that a boot capture was taken at `nowEpoch`. No-op when `nowEpoch` is
// implausible (pre-NTP), so a bogus epoch is never persisted as the window
// anchor. Call this only after a boot capture actually uploads, so the window
// bounds the server-visible image rate (a failed upload creates no spam and
// correctly leaves the gate re-armed).
void captureGateNote(std::uint32_t nowEpoch);

// Test-only: clear the slot (invalidate the magic), mirroring the cold-boot /
// power-on state. Used by setUp() in the native suite. On device the slot is
// managed entirely by captureGateNote + the RTC power-on wipe.
void captureGateClearForTest();

}  // namespace hf

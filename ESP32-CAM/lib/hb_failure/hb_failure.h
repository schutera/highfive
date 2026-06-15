#pragma once

#include <cstdint>

namespace hf {

// Cross-reboot record of the most recent heartbeat-failure streak (#172).
//
// The hourly (steady-state) heartbeat fails *between* boots, but a failed
// heartbeat never reaches the server (no 2xx response), so the reason the
// hourly pings fail is invisible remotely — the telemetry sidecar and the
// boot heartbeat only ever capture the BOOT call's outcome. In #170 the boot
// heartbeat returns 200 while every hourly heartbeat in the following 2 h
// fails and trips the liveness watchdog, yet we cannot see *why* without a
// physical serial capture.
//
// This slot closes that gap: every heartbeat failure bumps a persisted
// counter and records the last failure code; the NEXT heartbeat that
// round-trips a 2xx — typically the boot heartbeat after a `livenessReboot`
// — carries the streak to the server, which then clears it. Reboot loops and
// fail-then-recover blips both surface.
//
// Storage mirrors `lib/breadcrumb`: `RTC_NOINIT_ATTR` on device (survives
// software resets — ESP.restart()/TASK_WDT/panic — wiped on power-on) with a
// magic guard so indeterminate RTC contents on a cold boot can't masquerade
// as a real streak. Pure C++17 + a single ESP-attribute macro; host-testable
// via a plain static fallback when `ARDUINO` is not defined.
struct HbFailure {
    int code = 0;            // last non-zero sendHeartbeat() return value
    std::uint32_t count = 0;  // consecutive failures since the last reported 2xx
};

// Record one heartbeat failure: store `code` and increment the count.
// The first call after a cold boot (invalid magic) starts the count at 1.
void hbFailureNote(int code);

// Clear the streak. Called after a heartbeat round-trips a 2xx — the server
// has now seen (or no longer needs) the streak, so the next heartbeat starts
// fresh.
void hbFailureClear();

// Read the current streak without mutating it. Returns {0, 0} when no valid
// streak exists (fresh power-on, or after a clear) — the fail-closed property
// that keeps cold-boot RTC garbage from surfacing as a fake failure count.
HbFailure hbFailurePeek();

}  // namespace hf

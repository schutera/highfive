# ADR-024: Boot-capture rate-limit via an RTC_NOINIT epoch, wiped on power-on

## Status

Accepted ([#179](https://github.com/schutera/highfive/issues/179)). Spun out of the
[#143](https://github.com/schutera/highfive/issues/143) investigation, which recorded a
field module crash-looping every ~40 s and uploading one boot smoke-test image per
reboot — ~90–100 images/hour, `boot_count` 3169, the bulk of that module's ~15 k
uploads. The reboot _causes_ are hardened separately
([#149](https://github.com/schutera/highfive/issues/149)/[#148](https://github.com/schutera/highfive/issues/148)/[#170](https://github.com/schutera/highfive/issues/170));
this is the cheap defence-in-depth guardrail #143 recommended "worth doing regardless".

## Context

The firmware takes a boot smoke-test image on every boot that is not the scheduled
24 h daily reboot (which already suppresses it via the `boot`/`daily_reboot` NVS flag).
A crash/watchdog/liveness reboot loop therefore dumps one image per cycle. We want to
cap that at ~1 image per N-minute window **without** suppressing the legitimate
boot-capture on a genuine power-on / field redeploy, and without depending on
diagnosing the (unknown, possibly involuntary) reset cause.

The hard part is the clock. Each boot's `millis()` restarts at 0, so "time since the
last boot capture" needs a value that survives reboots. ESP32 RTC slow memory survives
**software** resets (`ESP.restart()`/TASK_WDT/panic) but is wiped on **power-on**;
wall-clock time is only available once NTP syncs in `setup()`.

## Decision

A new host-testable lib [`ESP32-CAM/lib/capture_gate`](../../ESP32-CAM/lib/capture_gate/)
stores the **wall-clock epoch of the last boot capture** in a magic-guarded
`RTC_NOINIT_ATTR` slot (same storage class and fail-closed magic-guard idiom as
`lib/breadcrumb` and `lib/hb_failure`). In `setup()`, after the NTP sync, the boot
capture is skipped when `captureGateShouldCapture(time(nullptr), kBootCaptureWindowSec)`
is false; on a successful boot upload, `captureGateNote(time(nullptr))` anchors the
window. Window is 30 min.

The RTC power-on wipe is the load-bearing semantic: a reboot **loop** is a chain of
software resets, so the slot survives and throttles; a genuine **power-cycle/redeploy**
is a power-on, so the slot is empty and the boot capture always runs. The gate **fails
open** (captures) when NTP has not synced (no clock to measure against), when no valid
anchor exists, or when the clock moved backwards — and `captureGateNote` refuses to
persist a pre-NTP bogus epoch. Noting only on a _successful_ upload bounds the
**server-visible** image rate to ≤1/window; a failed upload makes no spam and leaves the
gate re-armed.

### Alternatives rejected

- **NVS (Preferences) instead of RTC_NOINIT.** Survives power-on too, so a deliberate
  field power-cycle within the window would lose its boot smoke-test image — the opposite
  of the desired semantic. RTC_NOINIT's power-on wipe is exactly the "throttle loops, not
  redeploys" rule. (NVS is also not exercised by the native host tests.)
- **Throttle by `boot_count` cadence (boots-per-interval) with no wall clock.** Avoids
  the NTP dependency but cannot express an N-_minute_ window; the documented storm had a
  working network (uploads succeeded ⇒ NTP available), so the epoch approach holds where
  it matters.
- **Fix the reset cause instead.** Out of scope and already pursued elsewhere; this is a
  blast-radius cap that holds regardless of root cause.

## Consequences

- A future reboot loop uploads ≤~48 boot images/day instead of thousands, independent of
  the loop's cause. The 2 h liveness-watchdog recovery cadence is far wider than 30 min,
  so legitimate recovery reboots are never throttled.
- **No-NTP edge:** a WiFi-up-but-NTP-down loop is not throttled (fail-open). Accepted: it
  matches the documented storm's preconditions poorly and erring toward capturing avoids
  ever silencing a genuine boot image. Recorded as a known tradeoff in chapter 11.
- Decision logic is pure and unit-tested (`test/test_native_capture_gate`) with the clock
  injected as a parameter; the RTC storage is the only non-portable piece.
- Shipping to the field requires a firmware release (SEQUENCE bump per the
  firmware-release runbook); merging the source ships nothing on its own.
- **Bench-testing the throttle _engaging_ is not possible with `esp_reset.py` /
  `esp_capture.py`**: their RTS/EN-pin reset is a `POWERON_RESET`, which wipes
  `RTC_NOINIT` — so the stored epoch clears on every bench reset and the gate
  always captures. Observing the throttle needs a _successful_ boot upload (to
  arm `captureGateNote`; on Windows the dev host must be LAN-reachable — WLAN
  profile Private) followed by a real software `ESP.restart()` within the window.
  Same constraint the `hb_failure` streak (#172) documents — see
  [esp-reliability.md §8](../06-runtime-view/esp-reliability.md) "Only software
  resets preserve the streak". The pure gate logic is covered by the native
  tests regardless.

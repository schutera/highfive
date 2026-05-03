# ADR-007: ESP reliability — circuit breaker + daily reboot + camera PWDN recovery

## Status

Accepted. Supersedes the ad-hoc "watchdog only" reliability story
implicit in `v1.0.0`.

## Context

ESP32-CAM modules deployed in the field died after roughly 8–10
days with no recovery path. PR 17 hardened the reliability story
along three independent axes:

1. **WiFi auto-recovery + circuit breaker.** A simple "reboot
   after 5 reconnect failures" rule is too eager (kills good
   devices on a transient AP outage) and too lax (does nothing if
   the failure is in JPEG capture or HTTP). The breaker counts
   *consecutive failures of any kind* (camera NULL, WiFi down,
   HTTP non-2xx) and, when it trips, defers a reboot to the next
   loop iteration so the device gets one more chance.

2. **Daily reboot.** After 24 hours of uptime, the module
   restarts itself to clear heap fragmentation and stale TCP
   state. To avoid doubling the daily image cost, the boot path
   skips `captureAndUpload` if the wake was triggered by the
   daily timer (signalled via NVS key `daily_reboot`).

3. **Camera recovery via PWDN cycle.** When the sensor returns
   NULL frames repeatedly, `captureAndUpload` cycles the PWDN
   pin and re-runs `esp_camera_init()` rather than just retrying
   the capture. Recovers the module from sensor lock-ups that
   otherwise required a power-cycle.

Independently each is a small change. Together they are an
architectural commitment: **the firmware never fails open. Every
failure path eventually reboots the device with state preserved
in NVS so the next boot can act on it.**

## Decision

The three mechanisms live in `ESP32-CAM/ESP32-CAM.ino` and the
`ESP32-CAM/esp_init.{h,cpp}` pair:

- `TASK_WDT_TIMEOUT_S = 60` — the task watchdog. Bumped from 30 s
  in PR-17 review (see CLAUDE.md lessons register) because the
  worst-case loop iteration (`captureAndUpload` 3× retry +
  heartbeat) could exceed 30 s and silently reboot mid-upload.
- Consecutive-failure breaker tracked in a static counter local
  to `loop()`; reboot deferred by one iteration.
- Daily-reboot wake flagged in NVS namespace `"telemetry"` key
  `daily_reboot`; consumed and cleared at the top of `setup()`.
- Camera recovery: `captureAndUpload` calls
  `esp_camera_deinit()`, drives PWDN, re-inits the camera, and
  retries the capture if `esp_camera_fb_get()` returns NULL.

Heartbeat status-code parsing (`sendHeartbeat` reads the HTTP
status line and returns 0 only on 2xx) feeds the breaker — silent
HTTP 500s used to look like success and never trip the counter.

## Consequences

**Positive**:

- A module that loses WiFi, returns NULL frames, or hits any
  capture failure recovers within one or two loop iterations
  (~30–60 s) — or, failing that, reboots within 60 s and starts
  fresh.
- Daily reboot caps any long-running degradation at 24 h.
- Heartbeat failures now show up in admin telemetry instead of
  vanishing, so silent decay is observable.

**Negative**:

- A genuinely broken device will reboot-loop forever without
  intervention. We accept that — reboot-looping is louder than
  silent decay, and the silence watcher (ADR-005) will alert.
- The watchdog timeout is a knife-edge: 60 s is comfortably above
  worst-case loop time today, but adding one more retry to the
  upload path could push us back over. New retries require a
  matching watchdog audit.

**Forbidden**:

- Don't add `while (true)` blocking paths anywhere in firmware.
  Every error path either retries with a bounded counter or calls
  `ESP.restart()`.
- Don't lower `TASK_WDT_TIMEOUT_S` back to 30 without re-running
  the worst-case capture-plus-heartbeat scenario.

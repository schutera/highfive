# ADR-007: ESP reliability — circuit breaker + daily reboot + camera PWDN recovery

## Status

Accepted. Supersedes the ad-hoc "watchdog only" reliability story
implicit in `v1.0.0`.

## Context

ESP32-CAM modules deployed in the field died after roughly 8–10
days with no recovery path. PR 17 hardened the reliability story
along three independent axes:

1. **Consecutive-failure circuit breaker.** A simple "reboot
   after 5 reconnect failures" rule is too eager (kills good
   devices on a transient AP outage) and too lax (does nothing if
   the failure is in JPEG capture or HTTP). The breaker counts
   *consecutive failures of any kind on the upload path* (camera
   NULL frame, network start-error, send-failure, HTTP non-2xx)
   and, when it trips at >= 5, calls `delay(1000); ESP.restart()`
   immediately from inside the upload routine.

2. **Daily reboot.** After 24 hours of uptime, the module
   restarts itself to clear heap fragmentation and stale TCP
   state. To avoid doubling the daily image cost, the boot path
   skips `captureAndUpload` if the wake was triggered by the
   daily timer (signalled via NVS key `daily_reboot` in the
   `boot` namespace).

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
  in PR-17 review (commit `ea7dc73`; see CLAUDE.md never-violate
  rules) because the worst-case loop iteration
  (`captureAndUpload` 3× retry + heartbeat) could exceed 30 s
  and silently reboot mid-upload.
- Consecutive-failure breaker tracked in a `static uint8_t
  consecutiveFailures` local to `captureAndUpload`
  (`ESP32-CAM.ino:222`). Incremented at line 277 on any
  non-2xx outcome, reset at line 275 on success. At >= 5 it runs
  `delay(1000); ESP.restart()` immediately at lines 281-283.
  The pre-existing comment at lines 218-221 describes a
  **separate** behaviour: a single failed first-capture-on-boot
  returns `false` from `captureAndUpload`, the caller proceeds,
  and the next `loop()` iteration (~30 s later) tries again. That
  retry path eventually feeds the breaker; it does not defer the
  restart itself.
- Daily-reboot wake flagged in NVS namespace `"boot"` key
  `daily_reboot`; written by the daily-trigger path at
  `ESP32-CAM.ino:307` (`putBool("daily_reboot", true)`), then
  read + cleared at boot at `ESP32-CAM.ino:186, 190` (`getBool`
  + `putBool(..., false)` in the same Preferences block) before
  `captureAndUpload` is called.
- Camera recovery: `captureAndUpload` calls
  `esp_camera_deinit()`, drives PWDN, re-inits the camera, and
  retries the capture if `esp_camera_fb_get()` returns NULL.

`sendHeartbeat` was hardened separately in the same PR-17
review (`ea7dc73`): it now parses the HTTP status line and
returns 0 only on 2xx, and on any non-2xx (or WiFi-down /
connect-fail) it writes to the logbuf ring via
`logbufNoteHttpCode` (`ESP32-CAM/client.cpp:283`). That gives
admin telemetry a record of heartbeat failures. Important: the
heartbeat status code is **not** wired to the breaker counter —
the breaker only counts upload-path failures from
`captureAndUpload`. A heartbeating device that fails to upload
images will trip the breaker; a device whose uploads succeed
but whose heartbeats fail will not.

## Alternatives considered

- **Naive 5-fail-reconnect-then-reboot** (count only WiFi reconnect
  failures). Rejected — too eager (a transient AP outage kills
  good devices) and too lax (silent on JPEG-encode failures or
  HTTP 5xx). Replaced by the consecutive-failure breaker that
  treats all upload-path failure modes uniformly.
- **Watchdog only.** Rejected — would catch hard hangs but not slow
  degradation (heap fragmentation, gradually-failing camera sensor).
  The daily reboot + breaker pair handles the slow-degradation
  half; the watchdog stays as the deadlock backstop.
- **Cron-style scheduled-restart only** (e.g. every 6 hours). Rejected
  as the *only* reliability mechanism — too coarse for sub-hour
  failure modes (camera lock-up mid-day waits up to 6 h before
  recovery). Kept as one of three layers (the daily reboot) rather
  than the only one.
- **Routing heartbeat status into the breaker counter.** Considered
  during PR-17 review and rejected — it would couple the two
  channels and make it harder to reason about why a module rebooted.
  A device whose heartbeats fail but uploads succeed should *not*
  reboot; its silence will be caught by the watcher (ADR-005) on
  the receiving side.

## Consequences

**Positive**:

- A module that loses WiFi, returns NULL frames, or hits any
  capture failure recovers within one or two loop iterations
  (~30–60 s) — or, failing that, reboots within a few minutes
  via the breaker.
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
- The breaker only watches the upload path. A module that
  successfully uploads (cached imagery, or a cooperative-but-broken
  network) but fails every heartbeat will not auto-restart on its
  own; the silence watcher would catch it eventually via the
  heartbeat-row gap.

**Forbidden**:

- Don't add `while (true)` blocking paths anywhere in firmware.
  Every error path either retries with a bounded counter or calls
  `ESP.restart()`.
- Don't lower `TASK_WDT_TIMEOUT_S` back to 30 without re-running
  the worst-case capture-plus-heartbeat scenario (commit `ea7dc73`
  is the last one that audited it).
- Don't move the `daily_reboot` NVS flag out of the `boot`
  namespace without updating both the writer
  (`ESP32-CAM.ino:307`) and the reader/clear path
  (`ESP32-CAM.ino:186, 190`) in the same commit.

# ADR-034: loopTask stack is one global budget, raised to 16 KB and measured per boot

## Status

Accepted

## Context

The Arduino core runs `setup()` and `loop()` on a single task
(`loopTask`) whose stack defaults to **8192 bytes**
(`ARDUINO_LOOP_STACK_SIZE` in the core's `main.cpp`; no repo file configured
it). An mbedTLS handshake that parses and verifies a certificate chain
against the pinned ISRG Root X1 during the OTA-manifest fetch overflowed
that stack: the canary tripped and the board panic-reboot-looped on every
boot, never reaching registration (#276). The immediate fix,
`SET_LOOP_TASK_STACK_SIZE(16384)`, cleared the overflow but was picked, not
measured — and `setup()` performs verified TLS up to four times (OTA
manifest, registration, boot heartbeat; geolocation on NVS cache misses),
plus `loop()` uploads over TLS on every capture, all spending from the same
budget. The follow-up question #276 left open: should the four TLS call
sites move to a dedicated task with an explicit stack (a per-call-site
"known-good stack" helper), or stay on one raised, instrumented global
budget?

## Decision

**Keep one global `loopTask` budget** — `SET_LOOP_TASK_STACK_SIZE(16384)` —
and make it observable: the firmware logs
`[stack] loopTask high-water mark=<N> bytes after <stage>` after every heavy
stage in `setup()` and after the first loop() upload
(`uxTaskGetStackHighWaterMark(NULL)`, which reports the minimum free bytes of
the current task since boot). No dedicated TLS task is introduced.

The measured bound (2026-09-02, bench ESP32-CAM `68:09:47:60:33:08`,
production URLs): the watermark of a full production boot — OTA manifest TLS
fetch, a live geolocation TLS fetch (14-boot cache TTL forced to elapse),
registration TLS POST, boot heartbeat TLS POST, first image-upload TLS POST —
reached **6428 of 16384 bytes free** during the OTA-manifest stage and no
later stage took it lower (~9.96 KB peak, ~61 % of budget, ~6.4 KB headroom).
The OTA-manifest fetch is the deepest single stage; the TLS path runs
~3.6 KB deeper than the no-TLS baseline (10,048 bytes free on a boot whose
manifest connect failed against an unreachable target, so no handshake ran).

## Consequences

- A single budget stays the invariant of record: TLS depth is one number per
  boot, greppable in every bench capture and in the release-checklist
  re-verify step, instead of being split across several task stacks that each
  need their own measurement.
- No FreeRTOS task adds complexity: no serialization of the shared NVS/SPIFFS
  state (`Preferences`, `/config.json`) between tasks, no second stack
  budget, no change of scheduler priority.
- The cost is ~8 KB of DRAM permanently standing idle (the raise from the
  8 KB default) and the discipline of re-measuring before a TLS call site
  grows deeper than the manifest fetch — the `[stack]` line makes a
  regression visible on the bench boot.
- Foreclosed: moving TLS work to a dedicated task would have decoupled the
  handshake depth from the loopTask, but at the price of a second budget to
  cost, state-serialization and the same measurement duty — no real headroom
  gain for this codebase's TLS call pattern.
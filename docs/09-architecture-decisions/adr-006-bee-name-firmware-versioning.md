# ADR-006: ESP firmware uses bee-species names as version identifiers

## Status

Accepted.

## Context

ESP32-CAM firmware ships separately from the server-side stack and
gets flashed onto remote modules that may not be reachable for
months. We need a version string that is:

- Visible in logs, telemetry, and the dashboard with no decoding
  ("which build is this device on?").
- Easy to bump manually as part of a release commit (no build
  number machinery).
- Memorable enough that humans use it in chat and bug reports.

Semver was the obvious choice and was used for `v1.0.0`. In
practice nobody talked about firmware as `v1.2.3` — and the
ordering between minor and patch carried no real meaning for an
embedded artifact that we ship as a single binary per release.

PR 17 introduced a naming convention based on bee species
(`bumblebee` → `honeybee` → `mason` → `carpenter`, …). The current
version is recorded in `ESP32-CAM/VERSION` (a single-line file)
and exposed at runtime as `FIRMWARE_VERSION` in `esp_init.h`,
which the heartbeat payload sends as `fw_version` and the
dashboard renders verbatim.

## Decision

Firmware versions are bee-species names, in roughly order of
introduction. Each release commit updates two files:

- `ESP32-CAM/VERSION` — the single source of truth (one word, lowercase).
- `ESP32-CAM/esp_init.h` — `#define FIRMWARE_VERSION "<name>"`.

The `ESP32-CAM/build.sh` helper reads `VERSION` to tag the built
artifact.

The semver scheme is retained for the **server-side** stack
(`v1.0.0` and onwards in `CHANGELOG.md`) — only the embedded
firmware uses bee names.

## Consequences

**Positive**:

- Field reports become unambiguous: "module on `mason`, last
  heartbeat 4h ago" reads cleaner than "module on 1.2.3".
- The named release becomes a forcing function — choosing the next
  bee makes you think about whether this batch of changes is a
  coherent release.

**Negative**:

- No automatic ordering. We rely on commit history to know that
  `mason` is older than `carpenter`. Documented in
  `CHANGELOG.md` per release.
- Pool of names is finite. When we run out of carpenter bees, the
  next ADR will pick a new pool.

**Forbidden**:

- Don't reuse a bee name. Once shipped, it points at exactly one
  firmware build forever.
- Don't introduce a parallel semver for firmware. One scheme.

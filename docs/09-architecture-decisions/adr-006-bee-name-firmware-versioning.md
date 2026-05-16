# ADR-006: ESP firmware version — bee-name convention

## Status

**Accepted.** The bee-name convention is the agreed direction. As of
issue #36, `ESP32-CAM/VERSION` is the single writer; the firmware boot
log, telemetry sidecar, heartbeat body, and homepage OTA manifest all
read the same string via build-flag injection.

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
(`bumblebee` → `honeybee` → `mason` → `carpenter`, …) but added the
new identifier piecemeal as features landed, leaving older identifiers
in place. The result, as of `upstream/main` HEAD `a3675de`, is that
three different files each carry a different "firmware version" string
and each is read by a different consumer.

## Decision

Firmware versions are bee-species names, in roughly order of
introduction. Each release bumps the single source — `ESP32-CAM/VERSION`
— and the build pipeline propagates that string to every consumer.

### One writer, four readers

| File / location                         | Macro / value                                            | Surfaces as                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ESP32-CAM/VERSION`                     | `carpenter` (single writer)                              | n/a                                                                                                                                                                                                          |
| `ESP32-CAM/build.sh`                    | reads `VERSION`, then `cp` + `cat` for the manifest      | The `version` field in `homepage/public/firmware.json` (the OTA manifest the wizard reads).                                                                                                                  |
| `ESP32-CAM/build.sh` `--build-property` | `-DFIRMWARE_VERSION="<value of VERSION>"` to arduino-cli | The `FIRMWARE_VERSION` macro inside the firmware binary produced by the release path.                                                                                                                        |
| `ESP32-CAM/extra_scripts.py`            | injects `-DFIRMWARE_VERSION="<value>"` for PlatformIO    | Same macro for the `pio run -e esp32cam` cross-compile path.                                                                                                                                                 |
| `ESP32-CAM/esp_init.h` (fallback)       | `#define FIRMWARE_VERSION "dev-unset"` if not injected   | Only fires when the sketch is compiled directly in Arduino IDE without going through `build.sh` or `pio`. The string surfaces in boot log + telemetry + heartbeat as a "this is not a release build" signal. |

PR II / issue #83 adds a parallel `ESP32-CAM/SEQUENCE` file (single
writer) that follows the exact same shape — read by `build.sh`,
`extra_scripts.py`, and `build_dev_artifact.py`; injected as
`-DFIRMWARE_SEQUENCE=<int>`; fallback `0` in `esp_init.h` for raw
Arduino IDE builds. Same one-writer-four-readers pattern, different
macro. See [ADR-008 "Sequence + allow_downgrade addendum"](adr-008-firmware-ota-partition-and-rollback.md#sequence--allow_downgrade-addendum-pr-ii-83)
for the OTA-comparator semantics that read it. The version stays the
unordered bee name; SEQUENCE is the ordering signal the OTA path
needs.

The `FIRMWARE_VERSION` macro is consumed by:

- `ESP32-CAM/ESP32-CAM.ino` (`setup()` boot log line)
- `ESP32-CAM/logbuf.cpp` (`buildTelemetryJson` → telemetry sidecar `fw` field on every upload)
- `ESP32-CAM/client.cpp` (`sendHeartbeat` → `module_heartbeats.fw_version`)

So a single deployed `carpenter` device now reports `carpenter` on
all four surfaces (`firmware.json`, boot log, telemetry sidecar,
heartbeat row).

The semver scheme is retained for the **server-side** stack
(`v1.0.0` and onwards in `CHANGELOG.md`) — only the embedded
firmware uses bee names.

### Historical: the three-source divergence

Prior to issue #36, three uncoordinated definitions existed:
`ESP32-CAM/VERSION` (`carpenter`, only read by `build.sh` for the
manifest), `esp_init.h` (`#define FIRMWARE_VERSION "1.0.0"`, baked
into telemetry + boot log), and `client.cpp` (`#define FW_VERSION
"honeybee"`, baked into the heartbeat body). A single deployed
device therefore reported three different "firmware versions"
depending on which surface you looked at. Resolved by collapsing the
two firmware-side macros into a single injected `FIRMWARE_VERSION`.

## Alternatives considered

- **Strict semver** (`v1.0.0`, `v1.1.0`, …). Used for `v1.0.0` and
  rejected for subsequent firmware. The minor/patch axis carries no
  real meaning for an embedded artefact we ship as a single binary
  per release, and nobody talked about firmware as `v1.2.3` in chat
  or bug reports. **Kept** for the server-side stack (`CHANGELOG.md`).
- **Date-stamped builds** (`2026-04-25`). Rejected — unmemorable;
  field reports still need a human-readable referent.
- **Sequential integers** (firmware #1, #2, …). Rejected — same
  failure mode as semver minor/patch (no operator-friendly
  identifier in chat).
- **Auto-derived from git short SHA**. Rejected — opaque to operators,
  and field-deployed devices are not necessarily on a clean tag.

## Consequences

**Positive**:

- Field reports are unambiguous: "module on `carpenter`, last heartbeat
  4h ago" reads cleaner than "module on 1.2.3".
- The named release becomes a forcing function — choosing the next
  bee makes you think about whether this batch of changes is a
  coherent release.
- One writer, one macro, one string on every surface. Bumping `VERSION`
  is the entire release-naming workflow.

**Negative**:

- No automatic ordering. We rely on commit history to know that
  `mason` is older than `carpenter`. Documented in
  `CHANGELOG.md` per release.
- Pool of names is finite. When we run out of carpenter bees, the
  next ADR will pick a new pool.
- Two build paths (arduino-cli via `build.sh`, PlatformIO via
  `extra_scripts.py`) need to be kept in sync. Both inject the same
  macro from the same `VERSION` file, but a future toolchain swap
  needs to update both seams.

**Forbidden** (only the rules with scar tissue):

- Don't reuse a bee name. Once shipped, it points at exactly one
  firmware build forever.
- Don't reintroduce a second firmware-side version macro. The
  three-source mess this ADR was originally written about cost a
  debugging session; if a future need is "this binary needs a
  _different_ string for some surface", reach for a separate variable
  with a clearly distinct name, not a parallel `*_VERSION`.

# ADR-006: ESP firmware version — bee-name convention (currently divergent)

## Status

**Accepted (partial — see Tech debt).** The bee-name convention is the
agreed direction. The implementation currently maintains **three
uncoordinated sources of truth** for the same logical "firmware version"
field. Unification is tracked in
[`docs/11-risks-and-technical-debt/README.md`](../11-risks-and-technical-debt/README.md).

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
introduction. Each release should bump **all three** of the
identifiers below to the same name, until the unification work
collapses them to one source.

### Currently divergent (as of `upstream/main` HEAD `a3675de`)

| File / location        | Macro / value                                                | Read by                                                                                     | Surfaces as                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ESP32-CAM/VERSION`    | `carpenter`                                                  | `ESP32-CAM/build.sh`                                                                        | The `version` field in `homepage/public/firmware.json` (the OTA manifest the wizard reads).                                                                                |
| `ESP32-CAM/esp_init.h` | `#define FIRMWARE_VERSION "1.0.0"`                           | `ESP32-CAM/logbuf.cpp` (`logBootMarker`) and `ESP32-CAM/ESP32-CAM.ino` (`setup()` boot log) | The telemetry sidecar `fw` field on every image upload, and the boot log line.                                                                                             |
| `ESP32-CAM/client.cpp` | `#define FW_VERSION "honeybee"` (just above `sendHeartbeat`) | `ESP32-CAM/client.cpp` (`sendHeartbeat`'s body string)                                      | The `fw_version` form field in the hourly heartbeat body to `POST /heartbeat` (the column `module_heartbeats.fw_version`, surfaced as `Module.latestHeartbeat.fwVersion`). |

So a single deployed `carpenter` device today reports:

- `firmware.json` says `version: carpenter`,
- the upload sidecar says `"fw": "1.0.0"`,
- the heartbeat row says `fw_version: honeybee`.

### Desired end-state

A single source of truth — `ESP32-CAM/VERSION` — feeding both macros
via a `platformio.ini` `build_flags` injection:

```ini
build_flags =
    -DFIRMWARE_VERSION=\"$(shell cat ESP32-CAM/VERSION)\"
```

`FW_VERSION` in `client.cpp` then deletes its `#ifndef` block and uses
`FIRMWARE_VERSION` directly. `build.sh` continues to read `VERSION`
for the manifest. Three readers, one writer.

The semver scheme is retained for the **server-side** stack
(`v1.0.0` and onwards in `CHANGELOG.md`) — only the embedded
firmware uses bee names.

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

- Field reports become unambiguous (once unified): "module on `mason`,
  last heartbeat 4h ago" reads cleaner than "module on 1.2.3".
- The named release becomes a forcing function — choosing the next
  bee makes you think about whether this batch of changes is a
  coherent release.

**Negative**:

- **Today the three sources disagree.** Anyone reading the dashboard,
  the manifest, or the boot log will see a different name. Fix the
  three-source mess (see Tech debt) before the next field deployment
  or you will spend a debugging session figuring out which "version"
  is real.
- No automatic ordering. We rely on commit history to know that
  `mason` is older than `carpenter`. Documented in
  `CHANGELOG.md` per release.
- Pool of names is finite. When we run out of carpenter bees, the
  next ADR will pick a new pool.

**Forbidden** (only the rules with scar tissue):

- Don't reuse a bee name. Once shipped, it points at exactly one
  firmware build forever.
- Don't bump only one of the three current identifiers. Either bump
  all three to the same value or fix the unification first.

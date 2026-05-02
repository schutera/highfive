# ADR-002: Pure C++ helpers under `ESP32-CAM/lib/` for host testability

## Status

Accepted.

## Context

The ESP32-CAM firmware is built with the Arduino framework and
PlatformIO. The Arduino core is only available for the target board;
host CI cannot compile firmware that imports `Arduino.h`,
`WiFi.h`, etc.

Without host testing, every change to URL parsing, telemetry
serialisation, or the on-device circular buffer would only be
exercised on the device — slow feedback and no CI gate.

PlatformIO supports a `native` env that compiles against the host
toolchain (no Arduino core). It can run Unity unit tests on the CI
runner in seconds. But it can only see code under the `lib/`
directory, not code mixed into `.ino` / `.cpp` files that pull in
Arduino headers.

## Decision

Pure C++ helpers — code that does not depend on Arduino, ESP-IDF, or
hardware — live under `ESP32-CAM/lib/<name>/`:

- `lib/url/` — URL parsing for the upload base + endpoint config
- `lib/ring_buffer/` — fixed-size circular buffer used by `logbuf.cpp`
- `lib/telemetry/` — telemetry JSON builder
- `lib/form_query/` — URL-form parsing

Code that depends on Arduino headers stays in `ESP32-CAM/*.cpp`
(`host.cpp`, `client.cpp`, `esp_init.cpp`, `logbuf.cpp`) and is
exercised by the `esp-firmware` cross-compile job — which catches
linkage errors but not behaviour.

Host tests live under `ESP32-CAM/test/test_native_*/` and run via
`pio test -e native`. CI job: `esp-native`.

## Consequences

**Positive**:

- 38 host tests run on every CI push in seconds.
- New helpers default to `lib/` first, only escalate to `.cpp` if
  they truly need Arduino headers.
- Refactoring a parser or buffer can be done with a tight test loop
  on the laptop, no board attached.

**Negative**:

- Logic split across `lib/` and `.cpp` based on a non-obvious
  criterion (does it import Arduino?). New contributors need to be
  told the rule.
- The `esp-firmware` cross-compile job catches linkage breakage but
  not behaviour breakage in the `.cpp` files. We rely on integration
  testing on a real board for those.

**Forbidden**:

- Don't move pure C++ logic _out_ of `lib/` unless you also drop its
  unit tests. Logic outside `lib/` cannot be tested by the `native`
  env.

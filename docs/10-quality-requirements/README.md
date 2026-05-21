# 10. Quality Requirements

How HiveHive verifies it works: what's tested, where, and what CI
enforces on every PR. For the actual CI job manifest, see
[ci-gates.md](ci-gates.md).

## Testing pyramid

Four layers, each fast and hermetic where possible:

### Per-service unit tests (most coverage)

Run hermetically — no Docker, no real DB, no network.

| Service          | Stack                  | Count | Run                                  |
| ---------------- | ---------------------- | ----- | ------------------------------------ |
| `backend`        | vitest + supertest     | 17    | `cd backend && npm test`             |
| `homepage`       | vitest + jsdom         | 8     | `cd homepage && npm test`            |
| `image-service`  | pytest                 | 31    | `cd image-service && pytest tests/`  |
| `duckdb-service` | pytest (in-mem DuckDB) | 24    | `cd duckdb-service && pytest tests/` |

In `backend`, the duckdb-service client is mocked via `vi.mock`. In
`image-service`, all outbound HTTP and `duckdb.connect` calls are
monkey-patched. In `duckdb-service`, an in-memory DuckDB fixture
exercises schema, nest creation, progress insertion.

### ESP32-CAM host tests

PlatformIO `native` env (no Arduino core, runs on the CI host).

| Suite                                  | Count | Run                                  |
| -------------------------------------- | ----- | ------------------------------------ |
| `ESP32-CAM/test/test_native_url`       | -     | `cd ESP32-CAM && pio test -e native` |
| `ESP32-CAM/test/test_native_ring_*`    | -     | (same — runs all 38 in one job)      |
| `ESP32-CAM/test/test_native_telemetry` | -     | (same)                               |

Total: 38 tests covering `lib/url`, `lib/ring_buffer`, `lib/telemetry`.
Why this works: see [ADR-002](../09-architecture-decisions/adr-002-esp-host-testable-lib.md).

A second job (`esp-firmware`) cross-compiles the actual Arduino
firmware against the `esp32cam` env so any breakage from `.ino` /
`.cpp` linkage is caught even though the binary cannot run on CI.

### End-to-end pipeline test

`tests/e2e/test_upload_pipeline.py` boots an isolated docker-compose
stack (`tests/e2e/docker-compose.test.yml`, ports +1000 from dev) and
drives it with `tools/mock_esp.py`. Asserts:

- `image-service /upload` returns 200 and writes both image and sidecar
- `duckdb-service /modules` reflects updated `image_count` + battery
- `image-service /modules/<mac>/logs` round-trips the telemetry sidecar
- `backend /api/modules/:id/logs` enforces the admin gate

Run: `make test-e2e` (after `make test-e2e-deps`).

### UI tests (Playwright)

`tests/ui/` boots the same four backend services plus a production-built
homepage container, then drives real Chromium through the SPA via
Playwright. Catches the surface that jsdom + mocked APIs cannot — wire-
shape drift at the rendered-DOM boundary, SPA route mounting, and
cross-service contract regressions that pass `npm test && npm run build`
silently.

Five specs in iteration 1:

- `smoke.spec.ts` — homepage `/`, `/dashboard`, `/setup` mount without console errors.
- `dashboard-telemetry.spec.ts` — pins the [Telemetry sidecar envelope drift](../11-risks-and-technical-debt/README.md#telemetry-sidecar-envelope-drift--admin-ui-silently-rendered--for-every-field) regression. Asserts TelemetryRow renders literal values, not `—`.
- `dashboard-side-list.spec.ts` — pins the [Three layers, one rule](../11-risks-and-technical-debt/README.md#three-layers-one-rule-was-actually-four-surfaces--the-dashboard-side-list-silently-filtered-pending-modules-pr-ii-final-pass-smoke) regression. Asserts the Null-Island module appears with the "Location pending" pill.
- `module-panel-rendering.spec.ts` — header, MAC-prefix, image count, nest grid all render against real backend data.
- `setup-wizard-happy-path.spec.ts` — Step 1 → 5 via the documented skip branches.

Specs that fixture-type a wire shape import the type from
`@highfive/contracts` — currently `dashboard-telemetry.spec.ts`
imports `TelemetryEntry` (see [ADR-014](../09-architecture-decisions/adr-014-playwright-ui-tests.md)).

Run: `make test-ui` (after `make test-ui-deps`).

### Manual hardware-in-the-loop tests (OTA)

Four OTA flows cannot be exercised on CI because they require a real
ESP32-CAM on the LAN. Procedures and observed-output reference for
T2 (HTTP boot-pull), T3 (boot-heartbeat flicker), T4 (rollback), and
T6 (ArduinoOTA LAN push) live in
[manual-tests-ota.md](manual-tests-ota.md). Re-run them after any
firmware change that touches `ota.cpp`, `ESP32-CAM.ino`'s `setup()`,
`loop()`, or `platformio.ini`'s OTA env split.

## Repo-level wrappers

```bash
make help
make test               # = make test-esp-native test-e2e
make test-esp-native    # cd ESP32-CAM && python -m platformio test -e native
make test-e2e-deps      # pip install -r tests/e2e/requirements.txt
make test-e2e           # python -m pytest tests/e2e/ -v
make test-ui-deps       # cd tests/ui && npm ci && npx playwright install --with-deps chromium
make test-ui            # docker compose up + seed + playwright test + teardown
```

`make test-ui` is intentionally not in the `make test` umbrella yet —
the new gate stacks a few green CI runs before being folded into the
default `make test` target.

## CI

Nine parallel jobs gate every PR — see [ci-gates.md](ci-gates.md).
All must be green to merge.

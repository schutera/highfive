# 10. Quality Requirements

How HiveHive verifies it works: what's tested, where, and what CI
enforces on every PR. For the actual CI job manifest, see
[ci-gates.md](ci-gates.md).

## Testing pyramid

Three layers, each fast and hermetic where possible:

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

## Repo-level wrappers

```bash
make help
make test               # = make test-esp-native test-e2e
make test-esp-native    # cd ESP32-CAM && python -m platformio test -e native
make test-e2e-deps      # pip install -r tests/e2e/requirements.txt
make test-e2e           # python -m pytest tests/e2e/ -v
```

## CI

Eight parallel jobs gate every PR — see [ci-gates.md](ci-gates.md).
All must be green to merge.

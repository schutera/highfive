# End-to-end pipeline tests

Drives the full HiveHive backend stack with a mock ESP32-CAM and asserts
that every link of the upload chain holds:

```
mock_esp  →  image-service /upload  →  filesystem (image + .log.json sidecar)
                                    →  duckdb-service /add_progress_for_module
                                    →  duckdb-service module row update

read-back:
  duckdb-service /modules               → module appears with updated counts
  image-service  /modules/<mac>/logs    → telemetry sidecar round-trips
  backend        /api/modules/:id/logs  → admin-gated proxy works
```

## What this catches

The e2e test would have caught the original "no traffic to backend"
symptom in seconds. Anything that breaks the multipart shape, the
telemetry JSON schema, the depends_on ordering, or the auth headers
fails the test.

What it does **not** catch: WiFi watchdog behavior, daily-reboot timer,
heap fragmentation, real camera capture. Those need either native unit
tests (`make test-esp-native`) or hardware-in-the-loop testing.

## Prerequisites

- Docker + docker compose v2
- Python 3.10+
- `pip install -r tests/e2e/requirements.txt`

## Running

From the repo root:

```bash
make test-e2e
```

That brings up an isolated stack (project `highfive-e2e`, ports 9000/9002/4002),
waits for health, runs the test suite, and tears down. ~30s on a warm
Docker daemon, ~3 min cold.

## Iterating on test code

To keep the stack up between runs while editing tests:

```bash
docker compose -f tests/e2e/docker-compose.test.yml -p highfive-e2e up -d --build
E2E_REUSE_STACK=1 pytest tests/e2e/ -v
# ...iterate on tests...
docker compose -f tests/e2e/docker-compose.test.yml -p highfive-e2e down -v
```

## Port mapping

The test stack runs on ports shifted by +1000 from dev so it cannot clash
with a running dev compose:

| Service          | Dev port | Test port |
| ---------------- | -------- | --------- |
| image-service    | 8000     | 9000      |
| duckdb-service   | 8002     | 9002      |
| backend          | 3002     | 4002      |
| homepage         | 5173     | (not started) |

Volumes and networks are also isolated under the `highfive-e2e` compose
project name.

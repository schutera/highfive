# CI gates

`.github/workflows/tests.yml` runs **seven parallel jobs** on PRs to
`main` and pushes to `main`. All must stay green to merge.

| Job             | What it runs                                             |
| --------------- | -------------------------------------------------------- |
| `esp-native`    | `pio test -e native` in `ESP32-CAM/`                     |
| `esp-firmware`  | `pio run -e esp32cam` in `ESP32-CAM/` (cross-compile)    |
| `backend-unit`  | `npm test` (vitest + supertest) in `backend/`            |
| `duckdb-unit`   | `pytest tests/ -q` in `duckdb-service/`                  |
| `image-unit`    | `pytest tests/ -q` in `image-service/`                   |
| `homepage-unit` | `npm test` (vitest + jsdom) in `homepage/`               |
| `e2e-pipeline`  | `pytest tests/e2e/ -v` (boots full compose, ports +1000) |

Concurrency cancels superseded runs on the same ref. The workflow
also runs on pushes to `chore/test-harness`.

## When you add a new gate

1. Add the job to `.github/workflows/tests.yml`.
2. Add a row to the table above.
3. If the job runs a new test layer (not just more tests in an
   existing one), add it to the [testing pyramid](README.md#testing-pyramid).
4. If the gate enforces an architectural rule (e.g. "no DuckDB import
   outside `duckdb-service/`"), record the rule as an ADR.

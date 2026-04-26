# CLAUDE.md

Conventions and orientation for the **HiveHive** (a.k.a. `highfive`) bee-monitoring monorepo. Deeper context lives in [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md); this file does not duplicate them.

## Project at a glance

HiveHive monitors wild-bee nesting activity. ESP32-CAM modules upload images to a Python image service, a Python DuckDB service owns persistence, a Node/Express backend aggregates for the UI, and a React + Vite homepage renders dashboard, map, and setup wizard. Dev-side everything runs under `docker compose` on the shared bridge network `net`.

## Service map

| Service          | Stack                           | Host:Container | Directory         |
| ---------------- | ------------------------------- | -------------- | ----------------- |
| `homepage`       | React 19 + Vite + TS + Tailwind | `5173:5173`    | `homepage/`       |
| `backend`        | Node 20 + Express + TS          | `3002:3002`    | `backend/`        |
| `image-service`  | Python 3.11 + Flask             | `8000:4444`    | `image-service/`  |
| `duckdb-service` | Python 3.11 + Flask + DuckDB    | `8002:8000`    | `duckdb-service/` |
| `ESP32-CAM`      | C++17 + Arduino + PlatformIO    | n/a (edge)     | `ESP32-CAM/`      |

Internal calls use Docker service names (e.g. `http://duckdb-service:8000`), **not** `localhost`. The DuckDB file lives in the named volume `duckdb_data`, mounted at `/data` in both `image-service` and `duckdb-service`.

## Run the dev stack

```bash
docker compose up --build
```

Required `.env` at the repo root:

```env
DEBUG=true
DUCKDB_SERVICE_URL=http://duckdb-service:8000
# HIGHFIVE_API_KEY=...   # optional, overrides dev fallback 'hf_dev_key_2026'
```

Backend Swagger UI: <http://localhost:3002/api-docs>. `duckdb-service` auto-seeds five sample modules when `SEED_DATA=true` (compose default) and the DB is empty.

Per-service dev (without compose):

```bash
cd backend  && npm install && npm run dev
cd homepage && npm install && npm run dev      # :5173
```

## Run the tests

Repo-wide wrappers:

```bash
make help
make test               # = make test-esp-native test-e2e
make test-esp-native    # cd ESP32-CAM && python -m platformio test -e native
make test-e2e-deps      # pip install -r tests/e2e/requirements.txt
make test-e2e           # python -m pytest tests/e2e/ -v
```

Per-service unit tests (what CI runs):

```bash
cd backend        && npm ci && npm test                       # vitest + supertest, 17 tests
cd homepage       && npm ci && npm test                       # vitest + jsdom, 8 smoke tests
cd duckdb-service && pip install -r requirements-dev.txt && pytest tests/ -q   # 24 tests
cd image-service  && pip install -r requirements-dev.txt && pytest tests/ -q   # 31 tests
cd ESP32-CAM      && pio test -e native                       # Unity host tests, 38 tests
cd ESP32-CAM      && pio run  -e esp32cam                     # cross-compile firmware
```

## Where things live

| Area                               | Path                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| Shared TS contracts                | `contracts/src/index.ts` (npm workspace `@highfive/contracts`) |
| Backend Express entry              | `backend/src/server.ts`                                        |
| Backend route handlers             | `backend/src/app.ts` (+ `auth.ts`, `duckdbClient.ts`)          |
| Backend tests                      | `backend/tests/*.test.ts`                                      |
| Homepage pages / components        | `homepage/src/pages/`, `homepage/src/components/`              |
| Homepage tests                     | `homepage/src/__tests__/*.test.tsx`                            |
| Homepage API client                | `homepage/src/services/`                                       |
| Image service Flask app            | `image-service/app.py`                                         |
| Image service routes / services    | `image-service/routes/`, `image-service/services/`             |
| Image service tests                | `image-service/tests/test_*.py`                                |
| DuckDB service Flask app           | `duckdb-service/app.py`                                        |
| DuckDB schema / models             | `duckdb-service/db/`, `duckdb-service/models/`                 |
| DuckDB service tests               | `duckdb-service/tests/test_*.py`                               |
| ESP32-CAM firmware entry           | `ESP32-CAM/ESP32-CAM.ino`                                      |
| ESP32-CAM pure C++ (host-testable) | `ESP32-CAM/lib/{url,ring_buffer,telemetry}/`                   |
| ESP32-CAM Unity host tests         | `ESP32-CAM/test/test_native_*/`                                |
| End-to-end pipeline test           | `tests/e2e/test_upload_pipeline.py`                            |
| E2E isolated compose stack         | `tests/e2e/docker-compose.test.yml` (ports +1000)              |
| Mock ESP driver                    | `tools/mock_esp.py`                                            |
| Compose stack                      | `docker-compose.yml`                                           |
| CAD / laser DXFs                   | `assets/`                                                      |
| Docs (deep dives)                  | `documentation/`                                               |

## Conventions worth knowing

- **Test layout**: backend tests in `backend/tests/`, homepage tests in `homepage/src/__tests__/`, Python service tests in `<service>/tests/` next to source. ESP host tests in `ESP32-CAM/test/test_native_*/`.
- **DB invariant**: `duckdb-service` is the **only** writer of `app.duckdb`. `image-service` does not open a DuckDB connection — it goes through HTTP (`/add_progress_for_module`, `/modules/<mac>/heartbeat`, `/modules/<mac>/progress_count`).
- **Auth**: frontend → backend uses `X-API-Key`. Admin-only endpoints (telemetry log proxy) require a second `X-Admin-Key` header, also checked against `HIGHFIVE_API_KEY`. Admin UI is gated by `?admin=1` and stored in `sessionStorage['hf_admin']`.
- **ESP host-testability rule**: pure C++ helpers go under `ESP32-CAM/lib/<name>/` so `pio test -e native` can compile them without the Arduino core.
- **Field-name drift**: the `progess`/`hateched` typos were fixed in `778c9b1`, but `modul_id` is still live on the wire between `image-service` and `duckdb-service`. When touching DB/API field names, grep for both spellings before changing things — see `UBIQUITOUS_LANGUAGE.md`.
- **Conventional Commits**: first line `<type>: <imperative summary>` ≤ ~72 chars. Allowed types: `feat`, `fix`, `refactor`, `chore`, `test`, `ci`, `docs`. Body explains _why_, not _what_.
- **Code style**: TS for backend + homepage (ES modules). Python 3.11 + Flask for services with separate `requirements.txt` and `requirements-dev.txt`. C++17 for ESP firmware via PlatformIO `esp32cam` env.
- **Don't commit** `.env`, secrets, or large binaries. CAD files (`.FCStd`, `.dxf`) under `assets/` are intentional.

## CI gates

`.github/workflows/tests.yml` runs seven parallel jobs on PRs to `main` and pushes to `main`. All must stay green:

| Job             | What it runs                                             |
| --------------- | -------------------------------------------------------- |
| `esp-native`    | `pio test -e native` in `ESP32-CAM/`                     |
| `esp-firmware`  | `pio run -e esp32cam` in `ESP32-CAM/` (cross-compile)    |
| `backend-unit`  | `npm test` (vitest + supertest) in `backend/`            |
| `duckdb-unit`   | `pytest tests/ -q` in `duckdb-service/`                  |
| `image-unit`    | `pytest tests/ -q` in `image-service/`                   |
| `homepage-unit` | `npm test` (vitest + jsdom) in `homepage/`               |
| `e2e-pipeline`  | `pytest tests/e2e/ -v` (boots full compose, ports +1000) |

Concurrency cancels superseded runs on the same ref. The workflow also runs on pushes to `chore/test-harness`.

## What NOT to do

- **Never force-push to `main`.** A previous discarded production attempt was force-pushed off `main` and broke ESP firmware in the field. Treat `main` as append-only.
- **Never bypass hooks** (`--no-verify`, `--no-gpg-sign`). Fix the hook failure instead.
- **Never `--amend`** a commit when a pre-commit hook fails — the commit didn't happen, so amend would clobber the _previous_ commit. Re-stage and create a new commit.
- **Don't open a DuckDB connection from `image-service`.** That breaks the "duckdb-service owns the DB" invariant (Phase 4). All persistence goes via HTTP.
- **Don't hardcode `localhost`** in inter-service URLs — use the Docker service name.
- **Don't move pure C++ logic out of `ESP32-CAM/lib/`** unless you also drop its unit tests; logic outside `lib/` cannot be tested by the `native` env.
- **Don't add a separate admin-only env var.** `HIGHFIVE_API_KEY` is reused for the admin gate (see commit `a094792`); don't reintroduce a parallel secret.
- **Don't ship the dev API key (`hf_dev_key_2026`) as a production fallback.** Override `HIGHFIVE_API_KEY` for any non-local deploy.

## Branch model

- Default branch: `main`. PRs target `main`. CI must be green to merge.
- Branch off `main` with a typed prefix matching the commit type:
  - `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `refactor/<slug>`, `docs/<slug>`, `test/<slug>`, `ci/<slug>`
- Prefer **new commits** over `--amend`. Prefer staging files by name over `git add -A` (avoids accidentally committing `.env` / large binaries).

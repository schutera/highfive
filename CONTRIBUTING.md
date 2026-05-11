# Contributing to HiveHive

Thanks for working on HiveHive. This document covers the basics: how to run
the full stack, how to run each test suite, branch and commit conventions.

## Running the full stack locally

Prerequisites:

- Docker and `docker compose` v2
- Git

Clone and start:

```bash
git clone https://github.com/schutera/highfive.git
cd highfive
```

Create a `.env` at the repo root (used by `image-service` and
`duckdb-service`):

```env
DEBUG=true
DUCKDB_SERVICE_URL=http://duckdb-service:8000
# Optional — overrides default dev key 'hf_dev_key_2026'
# HIGHFIVE_API_KEY=your-strong-key
```

Then:

```bash
docker compose up --build
```

The four services come up on:

| Service        | URL                   |
| -------------- | --------------------- |
| homepage       | http://localhost:5173 |
| backend        | http://localhost:3002 |
| image-service  | http://localhost:8000 |
| duckdb-service | http://localhost:8002 |

The duckdb-service auto-seeds five sample modules when the DB is empty
and `SEED_DATA=true` (the compose default).

## Running tests

All test suites are wrapped by top-level `make` targets. Run
`make help` to see them.

### ESP32-CAM native unit tests (host, no hardware)

Pure C++ helpers under `ESP32-CAM/lib/{url,ring_buffer,telemetry}` are
covered by Unity tests in `ESP32-CAM/test/test_native_*/`. PlatformIO
runs them on the host.

Prerequisite: `pip install platformio`.

```bash
make test-esp-native
# wraps:  cd ESP32-CAM && python -m platformio test -e native
```

### End-to-end pipeline test

Boots an isolated docker-compose stack (project name `highfive-e2e`,
ports shifted +1000 from dev so it cannot clash) and drives it with the
Python mock ESP (`tools/mock_esp.py`).

Prerequisites: Docker + compose v2, Python 3.10+, and:

```bash
make test-e2e-deps   # pip install -r tests/e2e/requirements.txt
```

Run:

```bash
make test-e2e
# wraps:  python -m pytest tests/e2e/ -v
```

To iterate without tearing the stack down between runs see
[`tests/e2e/README.md`](tests/e2e/README.md).

### Run everything that runs locally

```bash
make test
# == make test-esp-native test-e2e
```

### ESP32-CAM firmware build

CI also cross-compiles the actual firmware (`pio run -e esp32cam`) so a
broken `.ino`/`.cpp` link is caught even though no host can run the
binary. To do the same locally:

```bash
cd ESP32-CAM && python -m platformio run -e esp32cam
```

> **Heads-up:** the Google Geolocation API key used by the firmware
> is **build-time injected**, not in source. A bare `pio run` works,
> but produces a binary that reports `(0, 0, 0)` on first boot — fine
> for a CI smoke test, **not fine** for a binary you intend to flash.
> Before flashing for real, write the key to `ESP32-CAM/GEO_API_KEY`
> (gitignored) or `export GEO_API_KEY=...`. Full setup:
> [`docs/07-deployment-view/esp-flashing.md` → "Provide the
> Geolocation API key"](docs/07-deployment-view/esp-flashing.md#provide-the-geolocation-api-key-one-time-before-first-build).

### CI

`.github/workflows/tests.yml` runs eight parallel jobs on every PR to
`main` and on push to `main`:

- `esp-native` — host unit tests for `ESP32-CAM/lib/*`
- `esp-firmware` — cross-compile firmware (consumes `secrets.GEO_API_KEY`; pre-build guard hard-fails on push-to-main if the secret is missing)
- `backend-unit` — vitest + supertest tests for the Node/Express backend
- `duckdb-unit` — pytest tests for `duckdb-service`
- `image-unit` — pytest tests for `image-service`
- `homepage-unit` — vitest + jsdom smoke tests for the React homepage
- `doc-citations` — verifies `path:line` references in `docs/` and `CLAUDE.md` still resolve
- `e2e-pipeline` — boots the four-service docker-compose stack and drives it with the mock ESP

The badge on `README.md` is wired to this workflow.

## Branch naming

Use descriptive prefixes that mirror the commit type. Examples from
recent history:

- `feat/<short-slug>` — new feature
- `fix/<short-slug>` — bug fix
- `chore/<short-slug>` — tooling, deps, repo housekeeping
- `refactor/<short-slug>` — internal change with no behaviour change
- `docs/<short-slug>` — documentation only
- `test/<short-slug>` — test code only
- `ci/<short-slug>` — CI config only

Branch off `main`, open a PR back to `main`. CI must be green to merge.

## Commit conventions

This repo follows [Conventional Commits](https://www.conventionalcommits.org/).
The first line is `<type>: <imperative summary>` and stays under ~72 chars.

Allowed types (matching recent history):

| Type       | When to use                                     |
| ---------- | ----------------------------------------------- |
| `feat`     | User-visible new behaviour                      |
| `fix`      | Bug fix                                         |
| `refactor` | Internal restructuring with no behaviour change |
| `chore`    | Tooling, dependencies, repo housekeeping        |
| `test`     | Adding or updating tests only                   |
| `ci`       | CI / GitHub Actions config                      |
| `docs`     | Documentation only                              |

Examples from `git log`:

```
feat: gate Telemetry section behind ?admin=1 flag
refactor: reuse HIGHFIVE_API_KEY for admin gate instead of separate secret
feat: v1.0.0 — ESP32-CAM reliability & telemetry
docs: update HiveModule CAD files, add laser cut DXFs and ESP32-CAM stream test docs
```

The body (optional, separated by a blank line) explains _why_, not _what_.

## Code style

- Backend: TypeScript, ES modules. Run `npm run dev` from `backend/`.
- Frontend: TypeScript + React 19 + Vite + Tailwind. Run `npm run dev`
  from `homepage/` (port 5173).
- Python services: Flask, Python 3.11. Per-service `requirements.txt` +
  `requirements-dev.txt`.
- ESP32-CAM: C++17, builds via PlatformIO `esp32cam` env. Pure helpers
  belong under `ESP32-CAM/lib/<name>/` so they can be unit-tested
  natively.

Do not commit `.env`, secrets, or large binaries. The `assets/` folder
holds CAD files (`.FCStd`, `.dxf`) — those are intentional.

## Reporting issues

Open a GitHub issue with reproduction steps, expected vs actual
behaviour, and (where relevant) the telemetry sidecar JSON for an
affected module. The Telemetry admin view in the dashboard
(`?admin=1`) is the fastest way to grab a recent payload.

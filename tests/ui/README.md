# UI tests (Playwright)

Real-browser UI tests that drive a production-built homepage against the
full backend stack. This is the fourth layer of the testing pyramid — see
[`docs/10-quality-requirements/README.md`](../../docs/10-quality-requirements/README.md).

## Why this layer exists

`homepage/` has 17 vitest + jsdom suites with every API call mocked.
Those tests pass while the real wire shapes drift silently — twice
documented in chapter 11:

- **Telemetry sidecar envelope drift** — every `TelemetryRow` field
  rendered `—` for weeks because the wire shape changed under the
  jsdom mocks. `npm test` + `npm run build` both green.
- **Three layers, one rule was actually four surfaces** — the dashboard
  side-list silently filtered out pending modules. Prose contract said
  one thing; code said another. Two senior-review rounds missed it.

`tests/ui/dashboard-telemetry.spec.ts` and `dashboard-side-list.spec.ts`
pin those two regressions in a real browser hitting the real backend.

## What this catches

- Wire-shape drift at the `image-service → backend → homepage` boundary.
- React rendering bugs that vitest + jsdom + mocked `fetch` cannot see.
- SPA route mounting failures (`/dashboard`, `/setup`).

## What it does NOT catch

- Web Serial / ESP32-CAM USB flashing — needs hardware. The setup wizard
  spec uses the `Skip — already flashed` and `Already configured` skip
  branches to walk the step state machine without a device.
- Map tile rendering / leaflet behaviour — out of iteration-1 scope.

## Prerequisites

- Docker + docker compose v2
- Node 22 (`engines` enforces ≥22.12.0)
- `npm ci` inside `tests/ui/` (separate package, not a root workspace)
- `npx playwright install --with-deps chromium`

## Running

From the repo root:

```bash
make test-ui-deps   # once, after a fresh checkout
make test-ui        # boots compose, seeds, runs all specs, tears down
```

That brings up an isolated stack (project `highfive-ui`, ports
9000/9002/4002/6173), waits for health, seeds the UI-specific fixtures,
runs the spec suite, and tears down. ~5 min cold, ~30 s warm.

## Iterating on test code

To keep the stack up between runs while editing specs:

```bash
docker compose -f tests/ui/docker-compose.ui.yml -p highfive-ui up -d --build
python tests/ui/scripts/seed_ui_fixtures.py
cd tests/ui && UI_REUSE_STACK=1 npx playwright test
# ...iterate on specs...
docker compose -f tests/ui/docker-compose.ui.yml -p highfive-ui down -v
```

`UI_REUSE_STACK=1` is read by `make test-ui` — it skips the boot/teardown
phases when set. The variable mirrors `E2E_REUSE_STACK=1` in
`tests/e2e/conftest.py`.

**Re-seeding a reused stack accumulates uploads.** The seed script is
UPSERT-idempotent for module registration, but every run _appends_ new
image uploads (e.g. 6 more gallery images per run). Specs that assume a
fresh seed's exact counts — `admin-image-pagination.spec.ts` assumes the
gallery holds exactly one page + 1 — will fail against a multiply-seeded
volume even though nothing is broken. Before judging a failure real,
`down -v` and re-run clean; `make test-ui` (without `UI_REUSE_STACK`)
does NOT reset the volume at start, only at teardown, so a leftover
stack from an iterating session pollutes it too.

`npx playwright test --ui` opens the Playwright UI runner for stepwise
debugging.

## Port mapping

The UI test stack runs on `+1000` ports (same as the e2e stack) with
the homepage on `:6173`:

| Service        | Dev port | UI test port |
| -------------- | -------- | ------------ |
| image-service  | 8000     | 9000         |
| duckdb-service | 8002     | 9002         |
| backend        | 3002     | 4002         |
| homepage       | 5173     | 6173         |

Volumes and networks are isolated under the `highfive-ui` compose
project. The e2e stack uses `highfive-e2e`; the two can coexist.

## Fixtures

`scripts/seed_ui_fixtures.py` runs after the stack is healthy and adds
what the specs need on top of `SEED_DATA=true`'s five baseline modules:

| MAC            | Module name            | Lat,Lng     | Why it exists                                                                                                                                                          |
| -------------- | ---------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ff0000000001` | UI Test Null Island    | (0, 0)      | Pins the side-list "Location pending" pill regression.                                                                                                                 |
| `ff1111111111` | UI Test Telemetry      | (47.8, 9.6) | Pins the TelemetryRow envelope-drift regression with one upload + sidecar.                                                                                             |
| `ff2222222222` | UI Test Gallery        | (47.8, 9.6) | 6 uploads (> one admin page) for `admin-image-pagination.spec.ts`; its newest (real) capture also drives the ModulePanel nest-snip grid (`module-nest-snips.spec.ts`). |
| `ff3333333333` | UI Test Precise Coords | precise 6dp | Proves server-side ~1 km coarsening end-to-end (ADR-020).                                                                                                              |
| `ff4444444444` | UI Test Heartbeat      | (47.8, 9.6) | Carries the #148 diagnostic heartbeat fields for `module-heartbeat-diagnostics.spec.ts`.                                                                               |

The seed values asserted by `dashboard-telemetry.spec.ts` live in
`seed_ui_fixtures.py::seed_telemetry_upload` — keep the two in sync.

### Seeded image bytes are NOT decodable (except where a spec needs them)

`tools/mock_esp.py`'s default upload body is pseudo-random bytes wrapped
in JPEG SOI/EOI markers — valid enough for the upload pipeline (which
never decodes), **impossible for a browser to render**: `<img>` fires
`error`, `naturalWidth` stays `0`, forever. Two consequences for spec
authors:

- Never assert thumbnail/image _loading_ against default seeds —
  `admin-image-pagination.spec.ts` counts grid cells, not `<img>`
  elements, for exactly this reason.
- If your spec must prove pixels actually decode end-to-end (the whole
  point of `module-nest-snips.spec.ts`'s and `snip-timelapse.spec.ts`'s
  `naturalWidth > 0` polls), the seed must upload a _real_ JPEG for that
  fixture — `seed_ui_fixtures.py` uploads
  `dev-tools/real_captures/block_tungsten_640.jpg` as the gallery module's
  newest capture for this purpose (a synthetic mock JPEG carries valid
  markers but random payload a browser can't decode).

## File layout

```
tests/ui/
  package.json              # standalone npm package, not in root workspaces[]
  playwright.config.ts      # chromium-only, baseURL=$UI_BASE_URL or :6173
  tsconfig.json             # paths -> ../../contracts for wire-shape imports
  docker-compose.ui.yml     # 4 services incl. production homepage
  scripts/seed_ui_fixtures.py
  tests/
    smoke.spec.ts                       # baseline: SPA mounts, dashboard loads
    dashboard-telemetry.spec.ts         # pins envelope-drift regression
    dashboard-side-list.spec.ts         # pins side-list filter regression
    module-panel-rendering.spec.ts      # nest grid + header against real backend
    module-nest-snips.spec.ts           # per-nest snip grid renders real pixels (#165)
    snip-timelapse.spec.ts              # global time-lapse scrubber walks captures (#166)
    module-heartbeat-diagnostics.spec.ts # #148 diagnostic fields end-to-end
    module-battery-history.spec.ts      # battery chart (currently skipped, chart shelved)
    admin-image-pagination.spec.ts      # admin gallery page cap + Load more
    coordinate-generalization.spec.ts   # ADR-020 ~1 km coarsening end-to-end
    setup-wizard-happy-path.spec.ts     # step 1 -> 5 via skip branches
```

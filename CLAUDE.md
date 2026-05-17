# CLAUDE.md

Orientation for the **HiveHive** (a.k.a. `highfive`) bee-monitoring monorepo. Deeper context lives in the arc42 docs at [`docs/`](docs/) and in [`CONTRIBUTING.md`](CONTRIBUTING.md); this file does not duplicate them.

## Project at a glance

HiveHive monitors wild-bee nesting activity. ESP32-CAM modules upload images to a Python image service, a Python DuckDB service owns persistence, a Node/Express backend aggregates for the UI, and a React + Vite homepage renders dashboard, map, and setup wizard. Dev-side everything runs under `docker compose` on the shared bridge network `net`.

## In-flight multi-PR plan (self-removes when complete)

A 3-PR series is in progress to clear cofade's open issues. Update the bullets as PRs land; delete this entire section when all three are merged.

- **PR 1 — Dashboard side-list rework** (closes #103, #102, #101): in progress on `claude/analyze-github-issues-wiqYS`
- **PR 2 — Windows host parity** (closes #100, #99): not started
- **PR 3 — `module_configs.updated_at` semantic split** (closes #97): not started

Out of repo: #80 (nginx HSTS on production — server config, not a code change here).

## Service map

| Service          | Stack                           | Host:Container | Directory         |
| ---------------- | ------------------------------- | -------------- | ----------------- |
| `homepage`       | React 19 + Vite + TS + Tailwind | `5173:5173`    | `homepage/`       |
| `backend`        | Node 22 + Express + TS          | `3002:3002`    | `backend/`        |
| `image-service`  | Python 3.11 + Flask             | `8000:4444`    | `image-service/`  |
| `duckdb-service` | Python 3.11 + Flask + DuckDB    | `8002:8000`    | `duckdb-service/` |
| `ESP32-CAM`      | C++17 + Arduino + PlatformIO    | n/a (edge)     | `ESP32-CAM/`      |

Internal calls use Docker service names (e.g. `http://duckdb-service:8000`), **not** `localhost`. The DuckDB file lives in the named volume `duckdb_data`, mounted at `/data` in both `image-service` and `duckdb-service`. Detailed map and per-service files: [`docs/05-building-block-view/`](docs/05-building-block-view/README.md).

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

`duckdb-service` auto-seeds five sample modules when `SEED_DATA=true` (compose default) and the DB is empty.

Per-service dev (without compose):

```bash
cd backend  && npm install && npm run dev
cd homepage && npm install && npm run dev      # :5173
```

## Run the tests

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
cd ESP32-CAM      && pio test -e native                       # Unity host tests, 114 tests
cd ESP32-CAM      && pio run  -e esp32cam                     # cross-compile firmware
```

The `pio run -e esp32cam` line builds the firmware as a smoke test — it works without `GEO_API_KEY` and produces a binary that reports `(0, 0, 0)` on first boot. **Do not flash that binary** without first writing the Geolocation API key to `ESP32-CAM/GEO_API_KEY` (gitignored) or exporting `GEO_API_KEY` in your shell. Full setup: [`docs/07-deployment-view/esp-flashing.md` → "Provide the Geolocation API key"](docs/07-deployment-view/esp-flashing.md#provide-the-geolocation-api-key-one-time-before-first-build); mechanism + rotation: [`docs/08-crosscutting-concepts/auth.md` → "Third-party API keys: Geolocation"](docs/08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).

Full testing strategy: [`docs/10-quality-requirements/`](docs/10-quality-requirements/README.md). CI gate manifest: [`docs/10-quality-requirements/ci-gates.md`](docs/10-quality-requirements/ci-gates.md).

## Documentation map (arc42)

The `docs/` folder follows arc42. Use this table to find the chapter relevant to your task — and to know **which chapter to update when you finish a change**.

| Chapter                                                             | Topic                                                          | Consider when…                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [01 Introduction & Goals](docs/01-introduction-and-goals/README.md) | Vision, goals, personas, scope                                 | Scoping a new feature; framing a tradeoff                              |
| [02 Constraints](docs/02-constraints/README.md)                     | Tech stack, hardware limits, conventions, what NOT to commit   | Adding a dependency or platform; choosing a tool                       |
| [03 Context & Scope](docs/03-context-and-scope/README.md)           | External actors and systems, in-scope vs out-of-scope          | Integrating a third-party API; adding a new actor                      |
| [04 Solution Strategy](docs/04-solution-strategy/README.md)         | High-level pipeline shape + ADR pointers                       | Cross-service architectural change                                     |
| [05 Building Block View](docs/05-building-block-view/README.md)     | Service map, topology, where-things-live, per-service detail   | Touching one service; refactor; "where is X?"                          |
| [06 Runtime View](docs/06-runtime-view/README.md)                   | Image upload flow, dashboard read flow, ESP reliability        | Changing request/response behaviour or sequence                        |
| [07 Deployment View](docs/07-deployment-view/README.md)             | Docker Compose stack, ESP firmware flashing                    | Deploy / infra / firmware-flashing change                              |
| [08 Crosscutting](docs/08-crosscutting-concepts/README.md)          | Auth, API contracts, hardware notes                            | Cross-service concern; setup gotcha                                    |
| [09 ADRs](docs/09-architecture-decisions/README.md)                 | Recorded design decisions                                      | New dependency / pattern shift / non-obvious tradeoff                  |
| [10 Quality](docs/10-quality-requirements/README.md)                | Testing pyramid, CI gates                                      | Adding a test layer or CI job                                          |
| [11 Risks & Tech Debt](docs/11-risks-and-technical-debt/README.md)  | Known issues, hardcoded secrets, **lessons learned**           | Hit a gotcha → log it here                                             |
| [12 Glossary](docs/12-glossary/README.md)                           | Domain terms (Module, Nest, Cell, MAC, …) and aliases-to-avoid | Naming a new concept; resolving a "what's the canonical name" question |

Operational refs (outside arc42 chapters):

- [`docs/api-reference.md`](docs/api-reference.md) — HTTP API reference
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — symptom-based fixes
- [`docs/roadmap.md`](docs/roadmap.md) — pointer to issues / milestones

## Updating documentation (mandatory)

Every PR that changes behaviour, adds a feature, or fixes a non-obvious bug must leave the docs better than found. After completing your change, run through this lookup and update the named target(s):

| Change type                                                  | Update target                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New service or major component                               | [`docs/05-building-block-view/`](docs/05-building-block-view/README.md) (add a per-service file + link from the index)                                                                                                        |
| New API endpoint or wire-shape change                        | [`docs/api-reference.md`](docs/api-reference.md) **and** [`docs/08-crosscutting-concepts/api-contracts.md`](docs/08-crosscutting-concepts/api-contracts.md)                                                                   |
| Behaviour change in upload / heartbeat / classification flow | [`docs/06-runtime-view/image-upload-flow.md`](docs/06-runtime-view/image-upload-flow.md)                                                                                                                                      |
| Dev Docker Compose change                                    | [`docs/07-deployment-view/docker-compose.md`](docs/07-deployment-view/docker-compose.md)                                                                                                                                      |
| Production deployment change                                 | [`docs/07-deployment-view/production-deployment.md`](docs/07-deployment-view/production-deployment.md) (Docker) **or** [`docs/07-deployment-view/production-runbook.md`](docs/07-deployment-view/production-runbook.md) (PM2) |
| ESP firmware change affecting onboarding                     | [`docs/07-deployment-view/esp-flashing.md`](docs/07-deployment-view/esp-flashing.md) and (if a gotcha) [`docs/troubleshooting.md`](docs/troubleshooting.md)                                                                   |
| New CI job or test layer                                     | [`docs/10-quality-requirements/ci-gates.md`](docs/10-quality-requirements/ci-gates.md)                                                                                                                                        |
| New design decision (dependency, pattern, trade-off)         | [`docs/09-architecture-decisions/`](docs/09-architecture-decisions/README.md) — write a new `adr-NNN-*.md` and add it to the index                                                                                            |
| New domain term, alias to avoid, or naming clarification     | [`docs/12-glossary/README.md`](docs/12-glossary/README.md)                                                                                                                                                                    |
| **Lesson from a bug or incident**                            | [`docs/11-risks-and-technical-debt/README.md`](docs/11-risks-and-technical-debt/README.md) → "Lessons learned" section. Format: what happened / why / how to avoid next time.                                                 |
| New gotcha during setup or config                            | [`docs/troubleshooting.md`](docs/troubleshooting.md) (symptom + fix)                                                                                                                                                          |
| Auth, API key, or secret-handling change                     | [`docs/08-crosscutting-concepts/auth.md`](docs/08-crosscutting-concepts/auth.md)                                                                                                                                              |
| Hardware setup quirk (browser, Wi-Fi, firewall)              | [`docs/08-crosscutting-concepts/hardware-notes.md`](docs/08-crosscutting-concepts/hardware-notes.md)                                                                                                                          |

If unsure, default to [`docs/11-risks-and-technical-debt/`](docs/11-risks-and-technical-debt/README.md) — it is the catch-all for anything you don't want the next person to have to relearn.

### Verifying UI claims, wire shapes, and component-test fixtures

Three structural rules earned across PR-42's review cycle (see [`docs/11-risks-and-technical-debt/`](docs/11-risks-and-technical-debt/README.md) "Telemetry sidecar envelope drift" for the incident). Apply when touching wire shapes that cross service boundaries:

1. **If a doc claims the admin UI renders a field, prove it before pushing.** Run the dev stack (`docker compose up`), hit the relevant view, and confirm the field actually renders. `npm test && npm run build` is necessary, not sufficient — both can pass while every wire-shape field renders as `undefined` (TypeScript optionals collapse silently on level mismatch).
2. **Wire shapes at the backend ↔ homepage boundary live in [`contracts/src/index.ts`](contracts/src/index.ts).** A service-local `interface` declaration for a wire shape is a smell — it means the type isn't pinned across the boundary, and ADR-004's "drift becomes a TypeScript compile error" guarantee doesn't hold. Move the type to the shared workspace package and re-export it where needed.
3. **Component tests for views that render wire-shape data must mount with a realistic fixture, not a mock object the test author guessed at.** The fixture shape is itself the contract under test. Bonus: a wire-shape round-trip test (mock `fetch` with the exact JSON the emitting service produces, feed through the consumer's API client, render the component) catches refactors that would silently break the production code path.

## Critical rules (do NOT violate)

These are the most-violated rules from past incidents. Full list in [`docs/02-constraints/`](docs/02-constraints/README.md). Lessons from individual incidents live in [`docs/11-risks-and-technical-debt/`](docs/11-risks-and-technical-debt/README.md).

- **Never force-push to `main`.** A discarded production attempt once broke ESP firmware in the field this way.
- **Never bypass hooks** (`--no-verify`, `--no-gpg-sign`). Fix the hook failure.
- **Never `--amend`** after a pre-commit hook failure — the commit did not happen; amend would clobber the _previous_ commit. Stage and create a new commit.
- **Never open a DuckDB connection from `image-service`.** See [ADR-001](docs/09-architecture-decisions/adr-001-duckdb-as-sole-writer.md).
- **Never hardcode `localhost`** in inter-service URLs — use the Docker service name.
- **Never ship the dev API key (`hf_dev_key_2026`)** as a production fallback. Override `HIGHFIVE_API_KEY`. Code-side guards catch the obvious shapes; the residual gap (`NODE_ENV=development` is an intentional off-ramp the operator owns) is the reason this prose entry stays. Full off-ramp semantics: [auth.md → "The secret"](docs/08-crosscutting-concepts/auth.md#the-secret).
- **Never trust commit messages over code when documenting behaviour.** When writing or reviewing arc42 chapters, ADRs, or runtime-view docs, read the actual files in `ESP32-CAM/`, `duckdb-service/`, etc. — commit messages summarise intent, not what shipped. Prefer `path's <symbol>` or `path::symbol` over `path:line`; the latter drift silently. Run `make check-citations` before invoking the reviewer. Lesson recorded in [chapter 11](docs/11-risks-and-technical-debt/README.md) "Lessons learned".

## Mandatory end-of-implementation gate

Every non-trivial change — feature work, bug fix, doc restructure, refactor — MUST run through the [`senior-reviewer`](.claude/agents/senior-reviewer.md) subagent before it leaves the working tree. Invoke it via the Agent tool with `subagent_type: senior-reviewer`. It is harsh on purpose: a senior-staff-engineer persona that reads the actual diff, anchors every concrete claim to a path (preferring `` path's `symbol` `` over `path:line`), and ranks issues P0/P1/P2.

When to run it:

1. After tests pass and you believe the change is done.
2. After fixing a previous round of review feedback (run again — re-reviews are independent, baseline credit is not given).
3. Before opening a PR.

How to run it:

- Default scope is `git diff $(git merge-base HEAD main)..HEAD`. Tell the agent which branch, PR, or file set to focus on if not the obvious one.
- **Run `make check-citations` first** and inspect the report. The script flags any `path:line` citation in `docs/` or `CLAUDE.md` that points at a missing file, past-EOF line, or blank line. Humans inspect the OK rows for "drifted but still in valid territory" cases (e.g. citation now lands on a closing brace). Also fires automatically on `git push` via `.husky/pre-push`.
- Address every P0 before pushing for review. P1s should be fixed or have an explicit "out of scope, tracked in issue #N" justification. P2s are nits and may be deferred.
- Treat its findings as input, not as a verdict. If it claims something is wrong, verify against the code yourself — but do not dismiss without checking.

## Shell environment

The user's shell is **PowerShell 5.1** on Windows. When providing manual testing commands or setup instructions:

- Always give **exact, copy-paste-ready commands** — no prose like "run the serial monitor", give the full command.
- Set ports/hosts as variables first: `$PORT = "COM9"` — never use angle-bracket placeholders like `<COMx>` (PowerShell parses `<` as a redirection operator).
- Write files with explicit encoding: `"value" | Out-File -NoNewline -Encoding ascii path\to\file` — PowerShell's default `>` redirect writes UTF-16 LE with BOM, which breaks Python `read_text(encoding="utf-8")`.
- No `&&` chaining — use `;` or `if ($?) { ... }`.
- Bash scripts (`build.sh`, `make`) run via `bash <script>` from PowerShell.

## Dev helper scripts

[`scripts/`](scripts/) holds repeatable dev utilities. Notable for OTA / firmware iteration:

- `scripts/esp_reset.py` — reset the ESP32-CAM via the CH340's RTS line (no physical button press needed).
- `scripts/esp_capture.py` — reset + capture N seconds of serial in one process, useful when `pio device monitor` flakes on the ESP32-CAM-MB.
- `scripts/esp_monitor.py` — passive serial capture (no reset), for observing an in-progress OTA cycle without disturbing setup() state.

See [`scripts/README.md`](scripts/README.md) for the full list and prerequisites.

## Branch model

See [CONTRIBUTING.md](CONTRIBUTING.md). Quick form: branch off `main` with typed prefix (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`, `test/`, `ci/`); first commit line `<type>: <imperative summary>` ≤ ~72 chars; PRs require all CI green.

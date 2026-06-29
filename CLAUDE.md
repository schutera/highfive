# CLAUDE.md

Orientation for the **HiveHive** (a.k.a. `highfive`) bee-monitoring monorepo. Deeper context lives in the arc42 docs at [`docs/`](docs/) and in [`CONTRIBUTING.md`](CONTRIBUTING.md); this file does not duplicate them.

## Project at a glance

HiveHive monitors wild-bee nesting activity. ESP32-CAM modules upload images to a Python image service, a Python DuckDB service owns persistence, a Node/Express backend aggregates for the UI, and a React + Vite homepage renders dashboard, map, and setup wizard. Dev-side everything runs under `docker compose` on the shared bridge network `net`.

## Service map

| Service          | Stack                           | Host:Container | Directory         |
| ---------------- | ------------------------------- | -------------- | ----------------- |
| `homepage`       | React 19 + Vite + TS + Tailwind | `5173:5173`    | `homepage/`       |
| `backend`        | Node 22 + Express + TS          | `3002:3002`    | `backend/`        |
| `image-service`  | Python 3.10 + Flask             | `8000:4444`    | `image-service/`  |
| `duckdb-service` | Python 3.10 + Flask + DuckDB    | `8002:8000`    | `duckdb-service/` |
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
make test-ui-deps       # cd tests/ui && npm ci && npx playwright install --with-deps chromium
make test-ui            # boots docker compose + production homepage, seeds, runs Playwright in real Chromium, tears down
```

Per-service unit tests (what CI runs):

```bash
cd backend        && npm ci && npm test                       # vitest + supertest, 17 tests
cd homepage       && npm ci && npm test                       # vitest + jsdom, 102 tests (17 files)
cd duckdb-service && pip install -r requirements-dev.txt && pytest tests/ -q   # 24 tests
cd image-service  && pip install -r requirements-dev.txt && pytest tests/ -q   # 31 tests
cd ESP32-CAM      && pio test -e native                       # Unity host tests, 114 tests
cd ESP32-CAM      && pio run  -e esp32cam                     # cross-compile firmware
```

The `pio run -e esp32cam` line builds the firmware as a smoke test — it works without `GEO_API_KEY` and produces a binary that reports `(0, 0, 0)` on first boot. **Do not flash that binary** without first writing the Geolocation API key to `ESP32-CAM/GEO_API_KEY` (gitignored) or exporting `GEO_API_KEY` in your shell. Full setup: [`docs/07-deployment-view/esp-flashing.md` → "Provide the Geolocation API key"](docs/07-deployment-view/esp-flashing.md#provide-the-geolocation-api-key-one-time-before-first-build); mechanism + rotation: [`docs/08-crosscutting-concepts/auth.md` → "Third-party API keys: Geolocation"](docs/08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).

Full testing strategy: [`docs/10-quality-requirements/`](docs/10-quality-requirements/README.md). CI gate manifest: [`docs/10-quality-requirements/ci-gates.md`](docs/10-quality-requirements/ci-gates.md).

## Cutting a firmware OTA release

To ship new ESP32-CAM firmware to the field, follow the runbook — do **not** improvise: [`docs/07-deployment-view/firmware-release.md`](docs/07-deployment-view/firmware-release.md). **The one rule:** bump `ESP32-CAM/SEQUENCE` (a new `VERSION` codename alone won't flash) — the on-device comparator requires the manifest's `version` to differ **and** its `sequence` to be strictly greater, so merging firmware source to `main` ships nothing until a higher-`SEQUENCE` build is published and a `prod-<codename>` tag exists. This silent no-op has shipped twice (#150, #132).

Ground truth, in execution order:

- **The checklist** — [`firmware-release.md` → Release checklist](docs/07-deployment-view/firmware-release.md#release-checklist): bump both `ESP32-CAM/VERSION` + `ESP32-CAM/SEQUENCE` → `bash ESP32-CAM/build.sh` (needs `GEO_API_KEY`) → rebuild the **frontend image** (the artifacts are gitignored, so `git pull` doesn't carry them) → commit on `main`, **promote to `production`** (`git push origin <sha>:production`), annotated `prod-<codename>` tag on the deployed commit → verify `curl https://highfive.schutera.com/firmware.json`.
- **Why `SEQUENCE` is the gate** — [`ADR-008` → Sequence + allow_downgrade addendum](docs/09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md#sequence--allow_downgrade-addendum-pr-ii-83) and [`ESP32-CAM/lib/ota_version/ota_version.h`](ESP32-CAM/lib/ota_version/ota_version.h).
- **The build/publish script** — [`ESP32-CAM/build.sh`](ESP32-CAM/build.sh) (writes the 3 artifacts + manifest into `homepage/public/`).
- **Runtime fetch/flash/rollback** — [`docs/06-runtime-view/ota-update-flow.md`](docs/06-runtime-view/ota-update-flow.md).
- **The trap to avoid** — [chapter 11 → "Merging firmware source is not a release"](docs/11-risks-and-technical-debt/README.md#merging-firmware-source-is-not-a-release--the-sequence-bump-is-the-release-150-132).

Since #152 ([ADR-030](docs/09-architecture-decisions/adr-030-production-as-gated-release-branch.md)), **both** the web services **and** firmware OTA deploy from the single gated `production` branch: `main` is the integration line, and a release is a fast-forward of `production` onto a chosen `main` commit (`git push origin <sha>:production`). `prod-*` tags are cut on `production`. The on-host `scripts/deploy.sh` timer (`BRANCH=production`) pulls it and auto-publishes firmware changes ([branch & tag model](docs/07-deployment-view/firmware-release.md#git-branch--tag-model)).

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

Every PR that changes behaviour, adds a feature, or fixes a non-obvious bug must leave the docs better than found. **And every working session that teaches you a lesson — even one that produces no PR and no repo code at all (a debugging dead-end, a hardware / driver / Wi-Fi / firewall quirk, an environment or ops gotcha, a wrong assumption you had to correct mid-task) — owes that lesson to the docs before the task is done.** After completing your work, run through this lookup and update the named target(s):

> **The arc42 docs are the only durable home for a lesson or gotcha — not a commit message, a scratch file, or an assistant's private/agent memory.** If you learn something the next contributor (human or AI) would want — a setup gotcha, a hardware / Wi-Fi / firewall quirk, an incident post-mortem — the change is **not done** until it lands in the doc named in the table below (most often [`docs/troubleshooting.md`](docs/troubleshooting.md), [`docs/08-crosscutting-concepts/hardware-notes.md`](docs/08-crosscutting-concepts/hardware-notes.md), or [chapter 11](docs/11-risks-and-technical-debt/README.md)). Recording it **only** in assistant/agent memory does not count and is never a substitute: that store is private, invisible to the team, and drifts out of sync. Check the docs first, too — if the gotcha is already documented, link it; don't duplicate it.
>
> **This holds when you wrote zero lines of repo code.** If the only artifact of an hour's work is something you now know and the next person doesn't — which driver an FTDI board needs, why a Docker upload stalled, that a "this is unaffected" claim was actually false — then writing that down _is_ the deliverable, not a nicety on top of it. **Do not wait to be asked.** Capturing the lesson is part of finishing the task; a session that ends with the lesson living only in the chat transcript is an unfinished session.

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
4. **When introducing a new view that renders wire-shape data — or changing how an existing one does — add a Playwright spec under [`tests/ui/tests/`](tests/ui/) that mounts the production-built homepage and asserts the field renders against the real backend.** Vitest + jsdom is necessary, not sufficient: every TS-optional wire-shape field collapses to `undefined` silently under mocked APIs, and jsdom never exercises SPA routing or nginx serving. The Playwright layer is the only one that closes both gaps. See [ADR-014](docs/09-architecture-decisions/adr-014-playwright-ui-tests.md) for the rationale and `tests/ui/README.md` for how to add a spec.
5. **For endpoints that aggregate (group-by, bucket, fold), assert that real data lands in the expected bucket — not just that the response envelope has the right shape.** A test that pins `len(response["buckets"]) == 7` is satisfied by `[{count: 0}] * 7`, which is exactly what a silently-broken aggregation looks like. Seed at least one upload (or row, or event) inside the test window and assert it appears in its bucket with the expected count. "Envelope right, behaviour wrong" was the failure mode behind PR-120's all-zeros daily aggregation (see [`docs/11-risks-and-technical-debt/`](docs/11-risks-and-technical-debt/README.md) "`date_trunc('day', ts)` returns DATE not TIMESTAMP" for the incident).

## Critical rules (do NOT violate)

These are the most-violated rules from past incidents. Full list in [`docs/02-constraints/`](docs/02-constraints/README.md). Lessons from individual incidents live in [`docs/11-risks-and-technical-debt/`](docs/11-risks-and-technical-debt/README.md).

- **Never force-push to `main`.** A discarded production attempt once broke ESP firmware in the field this way.
- **Never deploy or cut a release from `main`.** Production — web services **and** firmware OTA — ships only from the gated `production` branch (#152, [ADR-030](docs/09-architecture-decisions/adr-030-production-as-gated-release-branch.md)). `main` is the integration line; a release is a deliberate fast-forward of a reviewed `main` commit onto `production` (`git push origin <sha>:production`), which the on-host `scripts/deploy.sh` timer (`BRANCH=production`) then deploys — never a deploy off `main` directly. `prod-*` tags are cut on `production`. Full mechanics: [Cutting a firmware OTA release](#cutting-a-firmware-ota-release) above and [firmware-release.md → branch & tag model](docs/07-deployment-view/firmware-release.md#git-branch--tag-model).
- **Never bypass hooks** (`--no-verify`, `--no-gpg-sign`). Fix the hook failure.
- **Never `--amend`** after a pre-commit hook failure — the commit did not happen; amend would clobber the _previous_ commit. Stage and create a new commit.
- **Never open a DuckDB connection from `image-service`.** See [ADR-001](docs/09-architecture-decisions/adr-001-duckdb-as-sole-writer.md).
- **Never run AI/ML inference on the ESP, or ship model weights in firmware.** All inference is server-side (`image-service`, behind the lean `onnxruntime`); the ESP only captures + uploads, and models update via a server redeploy, never a fleet OTA. Detection visualizations, when shown, are overlays on the original image in the **Admin view** only (public stays the cropped snips, #154). See [ADR-028](docs/09-architecture-decisions/adr-028-ml-inference-server-side-only.md).
- **Never hardcode `localhost`** in inter-service URLs — use the Docker service name.
- **Never ship the dev API key (`hf_dev_key_2026`)** as a production fallback. Override `HIGHFIVE_API_KEY`. Code-side guards catch the obvious shapes; the residual gap (`NODE_ENV=development` is an intentional off-ramp the operator owns) is the reason this prose entry stays. Full off-ramp semantics: [auth.md → "The secret"](docs/08-crosscutting-concepts/auth.md#the-secret).
- **Never bake any API secret into the homepage bundle.** A single-page app cannot hold a secret — `import.meta.env.VITE_*` is inlined into the shipped JS as a public string literal anyone can read. There is no `VITE_API_KEY`: reads are public and admin actions ride a server-side session cookie minted by `POST /api/admin/login` (or the server-side `X-Admin-Key` machine credential). Incident #142: the prod key shipped in the public bundle and the `/admin` gate only pinged the public `/api/health`, so any typed string "logged in". See [ADR-019](docs/09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md) and [auth.md → "Admin session"](docs/08-crosscutting-concepts/auth.md#admin-session-cookie).
- **Never trust commit messages over code when documenting behaviour.** When writing or reviewing arc42 chapters, ADRs, or runtime-view docs, read the actual files in `ESP32-CAM/`, `duckdb-service/`, etc. — commit messages summarise intent, not what shipped. Prefer `path's <symbol>` or `path::symbol` over `path:line`; the latter drift silently. Run `make check-citations` before invoking the reviewer. Lesson recorded in [chapter 11](docs/11-risks-and-technical-debt/README.md) "Lessons learned".
- **Never write `close[sd]?` / `fix(es|ed)?` / `resolve[sd]?` next to `#N` in commit message _bodies_ or PR _descriptions_ — only in titles.** GitHub's auto-close scanner regex-matches the literal pattern anywhere in a merging PR's text without reading context, so a commit body explaining why an auto-close-keyword leak is bad — by quoting `(closes #100, #99)` — still closes #100 on merge. When discussing the mechanism, use `addresses` / `references` / `for #N` (no keyword); save the actual `closes #N` for the PR title and the commit-subject line of the implementing commit. Verify before push: `git log <merge-base>..HEAD --pretty=full | grep -nE "(close[sd]?|fix(es|ed)?|resolve[sd]?)\s+#"` — every match must be in a subject line or PR title, never a body paragraph. Incident: PR #104's fix commit body documented the buggy `(closes #100, #99)` antipattern by quoting it verbatim; the quoted occurrence closed #100 _and_ #97 prematurely on merge.

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

**Lessons-captured check (same gate, every time).** Before you call the task done, ask: _did this session teach a lesson the next contributor would want?_ If yes — a gotcha, a corrected assumption, a hardware/driver/env quirk, an incident — it MUST already be in the arc42 doc named in the "Updating documentation" table above, **even if the session produced no code change**. This is not optional and not a follow-up: an uncaptured lesson means the task is not finished. (This session's own history is the cautionary tale — the FTDI-driver, flash-voltage, and Docker-upload-stall lessons each needed a human reminder to land; that reminder is exactly the failure this gate exists to prevent.)

## Shell environment

The user's shell is **PowerShell 5.1** on Windows. When providing manual testing commands or setup instructions:

- **Every step in a test plan, walkthrough, or setup list is a copy-paste command** — including prep, verification, browser-launch, and regression checks. No imperative-mood prose without a backticked command. Substitutions:
  - "open DevTools" → `Start-Process chrome -ArgumentList '--incognito','--auto-open-devtools-for-tabs','http://localhost:5173/'`
  - "bring the stack up" → `docker compose up --build -d`
  - "confirm services are healthy" → `curl.exe http://localhost:3002/api/health` (one line per port)
  - "edit your hosts file" → the actual `Add-Content` invocation with the literal path
  - For GUI-only actions (clicking a rendered button, allowing a permission prompt), spell out the literal UI step **and** a CLI equivalent that exercises the same code path where one exists (e.g. a `curl` against the route the button would call). The user does not derive commands; if you catch yourself writing an imperative bullet without a command, rewrite it.
- Set ports/hosts as variables first: `$PORT = "COM9"` — never use angle-bracket placeholders like `<COMx>` (PowerShell parses `<` as a redirection operator).
- Write files with explicit encoding: `"value" | Out-File -NoNewline -Encoding ascii path\to\file` — PowerShell's default `>` redirect writes UTF-16 LE with BOM, which breaks Python `read_text(encoding="utf-8")`.
- No `&&` chaining — use `;` or `if ($?) { ... }`.
- Bash scripts (`build.sh`, `make`) run via `bash <script>` from PowerShell. `ESP32-CAM/build.sh` auto-detects `%LOCALAPPDATA%/Arduino15`, `esptool.exe`, and `python` (vs `python3`) on Windows, so `bash ESP32-CAM/build.sh` works with arduino-cli's default install — no env overrides or manual `esptool.py` copy needed (#99).

## Dev helper scripts

[`scripts/`](scripts/) holds repeatable dev utilities. Notable for OTA / firmware iteration:

- `scripts/esp_reset.py` — reset the ESP32-CAM via the CH340's RTS line (no physical button press needed).
- `scripts/esp_capture.py` — reset + capture N seconds of serial in one process, useful when `pio device monitor` flakes on the ESP32-CAM-MB.
- `scripts/esp_monitor.py` — passive serial capture (no reset), for observing an in-progress OTA cycle without disturbing setup() state.

See [`scripts/README.md`](scripts/README.md) for the full list and prerequisites.

**Two bench gotchas that have burned multiple sessions — read before hardware-testing any RTC/upload feature:**

- **`esp_reset.py` / `esp_capture.py` drive an EN-pin reset = `POWERON_RESET`, which wipes `RTC_NOINIT`.** So they can never make an RTC*NOINIT feature that must survive a *software* reboot \_engage* on the bench — the breadcrumb (#42), `hb_failure` streak (#172), and `capture_gate` throttle (#179) all reset to their power-on state on every bench reset (you'll see `reset_reason=1`, never the accumulated/throttled state). To exercise one you must induce a real software `ESP.restart()` (watchdog / circuit-breaker / liveness path). [esp-reliability.md → "Only software resets preserve the streak"](docs/06-runtime-view/esp-reliability.md).
- **A module that registers but never uploads to a dev box on Windows is often a LAN-reachability problem** — classically the Public-profile WLAN silently dropping inbound LAN TCP even with an explicit firewall Allow rule (fix, admin: `Set-NetConnectionProfile -InterfaceAlias "WLAN" -NetworkCategory Private` — but note a domain-managed machine may have this **blocked by Group Policy**, in which case scope the rule with `-Profile Any` instead). First check the rule profile (`Get-NetFirewallRule -DisplayName "HiveHive*" | Select Profile`) AND the active category (`Get-NetConnectionProfile`); a Private profile + `Profile Any` rule that _still_ fails is a flaky-link / band-isolation issue, not the firewall. [troubleshooting.md → "ArduinoOTA LAN push fails on Windows"](docs/troubleshooting.md), [esp-flashing.md Windows-Firewall note](docs/07-deployment-view/esp-flashing.md).

## Branch model

See [CONTRIBUTING.md](CONTRIBUTING.md). Quick form: branch off `main` with typed prefix (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`, `test/`, `ci/`); first commit line `<type>: <imperative summary>` ≤ ~72 chars; PRs require all CI green.

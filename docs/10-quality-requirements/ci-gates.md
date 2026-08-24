# CI gates

`.github/workflows/tests.yml` runs **fifteen parallel jobs** on PRs to
`main` and pushes to `main` and `production`. All must stay green to
merge.

| Job                          | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esp-native`                 | `pio test -e native` in `ESP32-CAM/`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `esp-firmware`               | `pio run -e esp32cam` in `ESP32-CAM/` (cross-compile). Consumes `secrets.GEO_API_KEY`; a pre-build guard hard-fails the job on push-to-main if the secret is missing. See [`auth.md`](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).                                                                                                                                                                                                                                      |
| `backend-unit`               | `npm test` (vitest + supertest) in `backend/`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `duckdb-unit`                | `pytest tests/ -q` in `duckdb-service/`, across a Python **3.10–3.14** matrix (`fail-fast: false`). The repo specifies its Python runtime inconsistently (the container path runs `3.12-slim`, deploy-docs prose says 3.11, and the bare-metal host that crashed ran 3.10), so the matrix spans a conservative 3.10 floor to a 3.14 ceiling — closing the single-version gap that crashed prod (#180). See [ADR-029](../09-architecture-decisions/adr-029-python-version-matrix-floated-pins.md). |
| `image-unit`                 | `pytest tests/ -q` in `image-service/`, across the same Python **3.10–3.14** matrix; native deps (`numpy`, `onnxruntime`) are floated to `>=` so each cell resolves a per-interpreter wheel (no single pin spans cp310…cp314). See [ADR-029](../09-architecture-decisions/adr-029-python-version-matrix-floated-pins.md).                                                                                                                                                                         |
| `homepage-unit`              | `npm test` (vitest + jsdom) in `homepage/`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ts-quality`                 | `npm run typecheck` (`tsc --noEmit` across `contracts/`, `backend/`, `homepage/`) then `npm run lint` (root ESLint flat config). **Neither unit job type-checks anything**: vitest compiles with esbuild and `tsx` runs the dev server the same way — both strip types without checking them, and `backend/tsconfig.json` excludes `backend/tests/` entirely. Before #208 the first `tsc` in the pipeline ran on the production host inside `scripts/deploy.sh` with its output discarded, so a type-broken change merged green, was promoted to `production`, and then rolled back on every timer tick with a reason-less message. |
| `doc-citations`              | `bash scripts/check-doc-citations.sh` — verifies `path:line` references in `docs/` and `CLAUDE.md` still resolve to non-blank lines of the current source                                                                                                                                                                                                                                                                                                                                         |
| `shellcheck`                 | `shellcheck -S info scripts/*.sh ESP32-CAM/build.sh` — lints the deploy + firmware-release scripts. These are the highest-blast-radius files in the repo and the only ones no other job exercises: `scripts/deploy.sh` runs as root on the live host every 2 minutes and can reload services, reset the tree, and publish an irreversible fleet OTA. Added in #196, where a `bash -n` in a PR description had been the entire verification story. `-S info` includes SC2086 (unquoted expansion). |
| `duckdb-bind-claims`         | `bash scripts/check-duckdb-bind-claims.sh` — asserts dev keeps duckdb-service LAN-reachable while prod stays loopback-bound, and that no doc claims both. The 2026-07 audit (#203) matched dev to prod and silently broke ESP registration + heartbeat on every bench, because the LAN-dev firmware posts straight at `:8002` with no Nginx in front; the revert then left a contradicting sentence in `auth.md`. Added in #222. |
| `python-version-consistency` | `bash scripts/check-python-version.sh` — asserts the two `Dockerfile.dev` `FROM` lines, the root `ruff.toml` ruff floor, and the `duckdb-unit`/`image-unit` matrix floors all match `/.python-version` (=`3.10`). Guards the #180 root cause (the runtime named three disagreeing ways). See [ADR-029](../09-architecture-decisions/adr-029-python-version-matrix-floated-pins.md) (#197).                                                                                                           |
| `python-lint`                | `ruff check duckdb-service image-service` + `ruff format --check duckdb-service image-service` under the repo-root `ruff.toml` (pinned `ruff==0.14.1`, matching both services' `requirements-dev.txt`). Scoped to the two services, not `.` — `ESP32-CAM/`, `scripts/`, `tools/`, and `tests/e2e/` carry Python that has never been linted (38 pre-existing findings, tracked in #257). Until #209 ruff ran **only** in the lint-staged pre-commit hook, so anyone bypassing hooks shipped unlinted code — and the `target-version = "py310"` pin that stops `UP`-family autofixes rewriting `datetime.now(timezone.utc)` into the 3.11-only `datetime.UTC` (the #180 crash) existed in `image-service/pyproject.toml` alone, leaving `duckdb-service` on ruff defaults. One root config now governs both. See [ADR-029](../09-architecture-decisions/adr-029-python-version-matrix-floated-pins.md). |
| `repo-guards`                | `bash scripts/check-no-hardcoded-api-keys.sh`, `check-stale-display-name-rule.sh`, `check-stale-reset-prose.sh`, `check-python-twins.sh`. The first three ran **only** from `.husky/pre-push` until #210 — bypassable with `--no-verify`, absent for fork PRs and web IDEs, and structurally absent on the production host, which installs with `HUSKY=0` and then pushes the firmware auto-bump to `production` itself. The hardcoded-secret scan in particular is a security control and must not be optional. `check-python-twins.sh` is new in #241: it keeps the five hand-duplicated `image-service`/`duckdb-service` Python modules byte-identical (docstring-tolerant on two pairs), which nothing enforced before — `discord.py` had already drifted. |
| `e2e-pipeline`               | `pytest tests/e2e/ -v` (boots full compose, ports +1000)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ui-playwright`              | `npx playwright test` in `tests/ui/` (boots compose incl. production homepage on :6173, seeds UI fixtures, runs real Chromium specs). Catches wire-shape drift and SPA-rendering bugs that jsdom + mocked APIs cannot. See [ADR-014](../09-architecture-decisions/adr-014-playwright-ui-tests.md).                                                                                                                                                                                                |

Concurrency cancels superseded runs on the same ref. The workflow
also runs on pushes to `chore/test-harness`.

`production` was added to the push triggers with `repo-guards` (#210).
It is not a second merge gate — nothing can block a push that has
already landed — but it is the only way the guard scripts ever see the
firmware auto-bump commit that `scripts/deploy.sh` pushes to
`production` from the live host, which runs no pre-push hook at all
(`HUSKY=0`, deliberately). A red `repo-guards` there is an alert, not a
gate; enforcing promotion is [#237](https://github.com/schutera/highfive/issues/237).

## What CI does *not* check

Worth stating explicitly, because two of these read as covered and are
not:

- **`tsx` and vitest do not type-check.** Both strip types through
  esbuild. `ts-quality` is the only job that runs `tsc`.
- **`ruff` is a linter, not a type checker.** No mypy/pyright runs
  anywhere; the Python services have no static type gate.
- **Hooks are not gates.** `.husky/pre-push` is bypassable by design and
  absent on the deploy host — every guard that matters needs a CI twin,
  which is what #210 exists to enforce.

## When you add a new gate

1. Add the job to `.github/workflows/tests.yml`.
2. Add a row to the table above.
3. If the job runs a new test layer (not just more tests in an
   existing one), add it to the [testing pyramid](README.md#testing-pyramid).
4. If the gate enforces an architectural rule (e.g. "no DuckDB import
   outside `duckdb-service/`"), record the rule as an ADR.

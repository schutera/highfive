# 2. Constraints

## Technical constraints

| Constraint                                                       | Notes                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker required for dev stack**                                | All four services start via `docker compose up --build`. The shared `net` bridge network and the `duckdb_data` named volume are wired in compose. Running services without Docker is supported per-service but not recommended for cross-service work.  |
| **Python 3.11** for `image-service` and `duckdb-service`         | Lower versions break Pydantic v2 / DuckDB pinned versions. Higher versions are not gated but not tested in CI.                                                                                                                                          |
| **Node 22 + TypeScript ES modules** for `backend` and `homepage` | Vite + Vitest pipeline. ES modules only — no CommonJS. Floor is `>=22.12.0` (Vite 7's supported LTS line); enforced via `engines.node` in `backend/package.json` and `homepage/package.json`, and pinned in CI + Dockerfiles.                           |
| **C++17 + Arduino framework + PlatformIO** for `ESP32-CAM/`      | Compiled against the `esp32cam` env (AI Thinker board). Pure C++ helpers live in `ESP32-CAM/lib/<name>/` so the `native` env can host-test them — see [ADR-002](../09-architecture-decisions/adr-002-esp-host-testable-lib.md).                         |
| **Single-file DuckDB** for persistence                           | Lives in the `duckdb_data` named volume. Only `duckdb-service` opens it — see [ADR-001](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md).                                                                                                 |
| **2.4 GHz Wi-Fi only on ESP32**                                  | The chip cannot connect to 5 GHz networks. If the home router uses band-steered single SSID for 2.4/5 GHz, the ESP should be steered down — but aggressive steering can reject it. See [hardware-notes](../08-crosscutting-concepts/hardware-notes.md). |
| **ESP32-CAM flash budget**                                       | The default partition layout has no OTA region. Adding OTA requires switching to "Minimal SPIFFS with OTA" — a one-time breaking USB flash. Tracked in [issue #26](https://github.com/schutera/highfive/issues/26).                                     |
| **Frontend / backend share types via `@highfive/contracts`**     | Both `backend` and `homepage` import from the npm workspace package at `contracts/src/index.ts`. Field-shape drift becomes a TypeScript compile error. See [api-contracts](../08-crosscutting-concepts/api-contracts.md).                               |

## Conventions (enforced by review, not always by tooling)

- **Conventional Commits** — first line `<type>: <imperative summary>` ≤ ~72 chars. Types: `feat`, `fix`, `refactor`, `chore`, `test`, `ci`, `docs`. Body explains _why_, not _what_.
- **Branch prefixes** match commit type: `feat/`, `fix/`, `docs/`, `refactor/`, `chore/`, `test/`, `ci/`.
- **`git add` by name**, not `-A` / `.` — protects against committing `.env`, secrets, or large binaries.
- **PRs target `main`**; CI must be green to merge. See [10-quality-requirements/ci-gates.md](../10-quality-requirements/ci-gates.md).

## What NOT to commit

- `.env` files at repo root or per-service.
- Any secret (API keys for third-party services, signing keys).
- Large binaries — except the intentional CAD `.FCStd` and `.dxf` files
  under `assets/` (laser-cut module enclosures).

## What NOT to do

These rules exist because of past incidents. Each one cost real time
to recover from.

- **Never force-push to `main`.** A discarded production attempt was
  force-pushed off `main` and broke ESP firmware in the field.
- **Never bypass git hooks** (`--no-verify`, `--no-gpg-sign`). Fix the
  hook failure instead.
- **Never `--amend` after a pre-commit hook fails** — the commit
  didn't happen, so amend would clobber the _previous_ commit. Re-stage
  and create a new commit.
- **Never open a DuckDB connection from `image-service`** — see
  [ADR-001](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md).
- **Never hardcode `localhost`** in inter-service URLs — use Docker
  service names.
- **Never ship the dev API key** (`hf_dev_key_2026`) as a production
  fallback. Override `HIGHFIVE_API_KEY` for any non-local deploy.

---
name: analyze-pr
description: Analyze a GitHub PR for the HiveHive repo — fetch metadata + linked issues, check out the branch, run every test layer the agent can run locally, and produce a copy-paste-ready manual-test plan for whatever's left. Invoke with a PR number ("analyze-pr 125"), with no argument (auto-pick if exactly one open PR), or on the current branch ("analyze-pr current").
user_invocable: true
---

# analyze-pr

Single purpose: take a HiveHive PR, validate everything an agent can validate, and hand the user a short list of _only_ the things they still have to do by hand. Stay terse — the user runs this often.

---

## Phase 1 — Resolve the target PR

Argument handling:

- `analyze-pr <N>` → use PR #N.
- `analyze-pr current` → resolve from the current branch: `gh pr view --json number,title,headRefName,baseRefName,body,url,state,mergeable,mergeStateStatus,statusCheckRollup,author,labels`. If no PR exists for the branch, stop and say so.
- `analyze-pr` (no arg) → `gh pr list --state open --json number,title,headRefName --limit 20`. If exactly **one** is open, use it. If more than one, list them and use `AskUserQuestion` to ask which.

Once the PR number is known, fetch the full payload once and reuse it (set `$N` first to avoid the `<` redirection-parser trap):

```powershell
$N = 125
gh pr view $N --json number,title,body,headRefName,baseRefName,state,mergeable,mergeStateStatus,additions,deletions,changedFiles,statusCheckRollup,labels,author,url,closingIssuesReferences
```

Extract issue refs two ways and **union** them — neither alone is sufficient:

1. `closingIssuesReferences[].number` from the payload above (explicit GitHub-tracked links — survives wording variations).
2. Regex over title + body — `(?i)(closes?|closed|fix(es|ed)?|resolves?)\s+#(\d+)` (catches refs the author wrote but GitHub didn't auto-link, e.g. cross-repo or formatting quirks).

For each unique issue number:

```powershell
gh issue view $M --json title,body,state,labels,url
```

If the PR body references roadmap items by issue number rather than auto-close keyword (e.g. "keystone of #111, #114, #115"), also fetch those — their acceptance criteria feed into Phase 4.

---

## Phase 2 — Get onto the branch (only if safe)

```powershell
git status --porcelain
```

If non-empty, **stop and ask the user** before switching — they may have in-progress work. Do not stash, do not discard.

Otherwise:

```powershell
gh pr checkout $N
git log --oneline (git merge-base HEAD main)..HEAD
git diff --stat (git merge-base HEAD main)..HEAD
```

> Base branch is `main`, not `master` or `develop`.

The diff stat tells you which service layers were touched. Use it for two things: skip irrelevant test suites if the diff is narrow (e.g. ESP-only docs → skip backend/homepage), and drive the **risk-surface manual checks** in Phase 4c. When in doubt, run everything — CI does.

---

## Phase 3 — Run every test layer the agent can run

Launch the independent layers as **parallel `Bash` calls in a single message**, and prefer `run_in_background: true` for anything that might take more than ~10 s (you get re-invoked on completion — do not poll). Use **absolute `cd` paths** because parallel bash sessions resolve CWD inconsistently:

```powershell
cd "c:/Users/wienh/VSCode/highfive/backend"; npm test --silent
cd "c:/Users/wienh/VSCode/highfive/homepage"; npm test --silent
cd "c:/Users/wienh/VSCode/highfive/homepage"; npm run build
cd "c:/Users/wienh/VSCode/highfive/duckdb-service"; python -m pytest tests/ -q
cd "c:/Users/wienh/VSCode/highfive/image-service"; python -m pytest tests/ -q
cd "c:/Users/wienh/VSCode/highfive/ESP32-CAM"; pio test -e native
make check-citations
```

Per-layer reporting format — for each layer, capture:

- the command that ran
- the **last 10–20 lines** of output (so failures stay visible without flooding the report)
- a one-word verdict: ✅ / ❌ / ⚠️

If any layer fails, **surface the failure at the top of the final report** and stop. Do not propose fixes speculatively — the user will direct.

Notes on each layer (cite when reporting):

| Layer                             | Command                                         | Coverage                                                                                                                                         | Skip if…                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doc-citation gate                 | `make check-citations`                          | Catches drifted `path:line` citations in `docs/` and `CLAUDE.md`. Pre-push hook also fires.                                                      | Never. Always run.                                                                                                                                         |
| Backend (vitest + supertest)      | `cd backend; npm test --silent`                 | Express routes, snake→camel mapping, auth, error envelopes.                                                                                      | No changes under `backend/` AND `contracts/`.                                                                                                              |
| Homepage (vitest + jsdom)         | `cd homepage; npm test --silent`                | Component-level wire-shape rendering with realistic fixtures (CLAUDE.md rule 3).                                                                 | No changes under `homepage/` AND `contracts/`.                                                                                                             |
| Homepage build                    | `cd homepage; npm run build`                    | Type errors + bundle. **Necessary, not sufficient** — jsdom + build can pass while wire-shape fields collapse to `undefined` (CLAUDE.md rule 1). | Same as above.                                                                                                                                             |
| duckdb-service (pytest)           | `cd duckdb-service; python -m pytest tests/ -q` | Routes, SQL aggregation, atomicity. Rule 5: aggregation tests must seed data and assert real values land in real buckets.                        | No changes under `duckdb-service/` AND no schema-affecting change anywhere.                                                                                |
| image-service (pytest)            | `cd image-service; python -m pytest tests/ -q`  | Upload validation, classifier stub, telemetry passthrough.                                                                                       | No changes under `image-service/`.                                                                                                                         |
| ESP32-CAM native                  | `cd ESP32-CAM; pio test -e native`              | Host-side Unity tests, ~10 s. MinGW already installed.                                                                                           | No changes under `ESP32-CAM/`.                                                                                                                             |
| Firmware cross-compile (optional) | `cd ESP32-CAM; pio run -e esp32cam`             | Smoke check that firmware still builds. CI runs it.                                                                                              | Almost always — the previous layer covers regressions for non-firmware PRs.                                                                                |
| Playwright UI (heavy)             | `make test-ui`                                  | Real Chromium against the production-built homepage + real backend. CLAUDE.md rule 4 / ADR-014.                                                  | Almost always — CI runs it green; only re-run locally if the diff touches the production nginx serving, SPA routing, or a wire-shape field's UI rendering. |

Also pull the GitHub CI rollup from the PR view — `statusCheckRollup[].conclusion`. If CI is green and the local layers above are green, the PR's automated story is complete.

---

## Phase 4 — Hand the user the manual-only list

Build the list from three sources, in order. Format every entry as **"do X → expect Y"** — a falsifiable observation, not "verify it works". One line per check where possible.

### 4a. Unchecked items from the PR body

Read every checkbox under "Test plan" / "Manual" / "Out of scope". Anything **unchecked** is a candidate; cross-reference against what the automated layers covered. Carry the wording over verbatim where it's already concrete.

### 4b. Per-feature acceptance walkthroughs

For each linked issue / roadmap item, derive a tight walkthrough from its **acceptance criteria**. Include:

- the **page / route / curl** to trigger the feature
- the **golden path** (do X → see Y)
- at least one **edge case** (empty input, gap in data, an offline module, save/reload roundtrip)

### 4c. Risk-surface checks the diff implies but the PR body forgot

The diff stat from Phase 2 tells you what was touched. For each touched area, add the corresponding manual check — even if the PR body didn't:

| If the diff touches…                                   | Add a manual check for…                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duckdb-service/db/schema.py` (seed / migration)       | Run on **both** a fresh `docker compose down -v && up --build` **and** a pre-existing volume. The fresh-volume path masks operator-volume seed bugs (PR #125 incident: Playwright was green in CI but the chart was empty on every dev machine because the seed gate skipped).                                       |
| `contracts/src/index.ts` (wire shapes)                 | Hit the **production-built homepage** at `:5173`, not `npm run dev`. Wire-shape fields collapse to `undefined` silently under vite HMR if snake→camel is broken (CLAUDE.md rule 1).                                                                                                                                  |
| Backend route under `backend/src/`                     | `curl.exe -H "X-API-Key: hf_dev_key_2026"` the route directly. **Homepage routes use `X-API-Key`; only admin-gated routes use `x-admin-key`** — mixing them up returns 401 and looks like a render bug.                                                                                                              |
| Heartbeat / dual-write path                            | `Invoke-RestMethod -Method Post -Uri http://localhost:8002/heartbeat -Body (@{module_mac='aabbccddeeff';battery=72} \| ConvertTo-Json) -ContentType 'application/json'`, then `curl.exe "http://localhost:8002/modules/aabbccddeeff/measurements?metric=battery_pct&interval=hourly"` to confirm both tables landed. |
| Auth / API-key handling                                | Set `NODE_ENV=production` locally and confirm the dev-key off-ramp refuses. The residual auth gap CLAUDE.md mentions is operator-owned only in dev.                                                                                                                                                                  |
| `homepage/src/i18n/translations.ts`                    | Switch language to Deutsch → confirm new strings render with no English fallback. Hardcoded f-strings bypass `t()` and only show here.                                                                                                                                                                               |
| `ESP32-CAM/src/` firmware                              | Flash to a real board (`pio run -e esp32cam -t upload`). `pio test -e native` doesn't exercise the camera, Wi-Fi, HTTPS, or geolocation stacks.                                                                                                                                                                      |
| Geolocation / `GEO_API_KEY` handling                   | Flash with `GEO_API_KEY` empty — first boot must emit `(0, 0, 0)` lat/lng/acc sentinel, not crash. See `docs/07-deployment-view/esp-flashing.md`.                                                                                                                                                                    |
| `docker-compose.yml` / service env / volume mounts     | Full `docker compose down -v && up --build` cycle. Service-only `restart` hides bind-mount and volume-init changes.                                                                                                                                                                                                  |
| ESP-CAM-MB serial behaviour                            | Use `python scripts/esp_capture.py COM<N> 60` (positional args, per memory) to capture a full boot; `pio device monitor` flakes on the MB CH340.                                                                                                                                                                     |
| Aggregation / bucketing SQL (`duckdb-service/routes/`) | Seed at least one row inside the test window and assert it lands in its bucket with the expected count (CLAUDE.md rule 5). Envelope-shape assertions pass on all-zeros silently broken aggregates.                                                                                                                   |

### 4d. PowerShell substitutions and gotchas

Common imperative-to-command rewrites for any UI step that can be partially CLI-shadowed:

| Imperative bullet                                  | Becomes                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "bring the stack up"                               | `docker compose up --build -d`                                                                                                                                                                                                 |
| "confirm services are healthy"                     | `curl.exe http://localhost:3002/api/health; curl.exe http://localhost:8002/health` (image-service `/health` returns empty-reply during boot; backend is the load-bearing one)                                                  |
| "open the dashboard"                               | `Start-Process chrome -ArgumentList '--incognito','--auto-open-devtools-for-tabs','http://localhost:5173/dashboard'`                                                                                                           |
| "click the seed module / verify the panel renders" | Spell out the literal click step **and** the CLI equivalent that hits the same backend route, e.g. `curl.exe -H "X-API-Key: hf_dev_key_2026" "http://localhost:3002/api/modules/000000000002/measurements?metric=battery_pct"` |

PowerShell reminders that bite the user (per memory):

- No `&&` chaining → `;` or `if ($?) { ... }`.
- No `curl.exe -d $jsonVar` → use `Invoke-RestMethod -Body (... \| ConvertTo-Json)` or `curl.exe -d "@file.json"`.
- No `2>&1` on native exes — stderr is already captured; wrapping it makes `$?` lie.
- No angle-bracket placeholders (`<N>`, `<COMx>`) in copy-paste blocks — PowerShell parses `<` as a redirection operator. Define `$N = 125` first.
- `docker compose exec /abs/path` is MSYS-translated on Windows — prefix `$env:MSYS_NO_PATHCONV='1'; ` if you must pass an absolute container path.
- Python edits to `duckdb-service` need `docker compose up -d --build duckdb-service`, not `restart` — no bind mount.
- Homepage Vite HMR misses Windows-host edits — bind mount works, watcher doesn't. `docker compose restart homepage` to force re-read.
- File writes for non-ASCII (German UI strings, etc.) — use the `Edit` tool, not `Set-Content -Encoding UTF8` (double-encodes UTF-8 → mojibake).

---

## Phase 5 — Output a tight report

Structure (markdown, keep it under one screen):

1. **PR summary** — title, branch, additions/deletions, mergeable status, CI rollup (X/Y green), labels.
2. **Connected tickets** — `#N — title (state)`, one line each. If none auto-closed, list any referenced roadmap-cluster issues from Phase 1.
3. **Scope** — one-sentence "what this PR does", plus the diff stat by service area.
4. **Local validation** — table: layer → verdict → tail-of-output (10–20 lines per failure; one count line per pass). Mark CI-only layers as "CI green (not re-run locally)" where applicable.
5. **Manual tests remaining** — numbered list from Phase 4 (groupings + falsifiable "do X → expect Y" steps). If nothing unchecked AND no wire-shape-rendering UI touched, say so explicitly: "Nothing left to validate manually."
6. **CLAUDE.md gate reminders** — only mention if the PR description does not already show evidence:
   - Senior-reviewer pass (`subagent_type: senior-reviewer`)
   - Doc updates per the "Updating documentation" table
   - The five "Verifying UI claims, wire shapes, and component-test fixtures" rules if wire-shape-rendering UI is touched
7. **Verdict** — one sentence: "ready for manual QA" / "blocked on automated failure: …" / "needs senior-review pass before merge" / "ready to merge after manual walkthrough".

Do **not** narrate intermediate steps in the final output. The user wants results.

---

## Phase 6 — Stay on the branch, do not push, do not amend

This skill is read-only on git state past `gh pr checkout`. Do not commit, push, rebase, version-bump, or update docs unless the user asks. If automated tests fail, report the failure verbatim and stop — don't try to fix it speculatively. **Do not auto-launch sibling skills** (`senior-reviewer`, `commit-push-pr`, `verify`, etc.) — those are separate workflows the user starts when they're ready.

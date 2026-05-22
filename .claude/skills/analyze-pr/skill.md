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

Once the PR number is known, fetch the full payload once and reuse it:

```powershell
gh pr view <N> --json number,title,body,headRefName,baseRefName,state,mergeable,mergeStateStatus,additions,deletions,changedFiles,statusCheckRollup,labels,author,url
```

Extract closed/linked issue refs from the title and body — match `(?i)(closes?|closed|fix(es|ed)?|resolves?)\s+#(\d+)` (the same regex GitHub uses). For each unique issue number, fetch it:

```powershell
gh issue view <M> --json title,body,state,labels,url
```

---

## Phase 2 — Get onto the branch (only if safe)

```powershell
git status --porcelain
```

If non-empty, **stop and ask the user** before switching — they may have in-progress work. Do not stash, do not discard.

Otherwise:

```powershell
gh pr checkout <N>
git log --oneline (git merge-base HEAD main)..HEAD
git diff --stat (git merge-base HEAD main)..HEAD
```

The diff stat tells you which service layers were touched. Use it to skip irrelevant test suites if the diff is narrow (e.g. ESP-only docs → skip backend/homepage). When in doubt, run everything — CI does.

---

## Phase 3 — Run every test layer the agent can run

Run in parallel where independent (separate `Bash` tool calls in a single message). Use **absolute `cd` paths** — `cd backend` from `/c/...` works, but spawning multiple parallel bash sessions sometimes resolves CWD inconsistently. Safer:

```powershell
cd "c:/Users/wienh/VSCode/highfive/backend"; npm test --silent
cd "c:/Users/wienh/VSCode/highfive/homepage"; npm test --silent
cd "c:/Users/wienh/VSCode/highfive/homepage"; npm run build
cd "c:/Users/wienh/VSCode/highfive/duckdb-service"; python -m pytest tests/ -q
cd "c:/Users/wienh/VSCode/highfive/image-service"; python -m pytest tests/ -q
cd "c:/Users/wienh/VSCode/highfive/ESP32-CAM"; pio test -e native
make check-citations
```

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

Open the PR description and find every checkbox under "Test plan" / "## Manual" / "Out of scope". Anything **unchecked** is a candidate for manual work; cross-reference against what the automated layers above just covered. What remains is the manual list.

For each manual item, write a **copy-paste PowerShell block**, not prose (CLAUDE.md "Shell environment" section). Common substitutions:

| Imperative bullet                                      | Becomes                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "bring the stack up"                                   | `docker compose up --build -d`                                                                                                                                                                                                                     |
| "confirm services are healthy"                         | `curl.exe http://localhost:3002/api/health; curl.exe http://localhost:8000/health; curl.exe http://localhost:8002/health`                                                                                                                          |
| "open the dashboard"                                   | `Start-Process chrome -ArgumentList '--incognito','--auto-open-devtools-for-tabs','http://localhost:5173/dashboard'`                                                                                                                               |
| "click the seed module / verify the new panel renders" | Spell out the literal click step **and** add a CLI equivalent that hits the same backend route the UI would call, e.g. `curl.exe -H "x-admin-key: hf_dev_key_2026" http://localhost:3002/api/modules/000000000002/measurements?metric=battery_pct` |
| "send a test heartbeat"                                | `Invoke-RestMethod -Method Post -Uri http://localhost:8002/heartbeat -Body (@{module_mac='aabbccddeeff';battery=72} \| ConvertTo-Json) -ContentType 'application/json'`                                                                            |

PowerShell reminders that bite the user (per memory):

- No `&&` chaining → `;` or `if ($?) { ... }`.
- No `curl.exe -d $jsonVar` → use `Invoke-RestMethod -Body (... \| ConvertTo-Json)` or `curl.exe -d "@file.json"`.
- No `2>&1` on native exes — stderr is already captured.
- No angle-bracket placeholders (`<N>`, `<COMx>`) — PowerShell parses `<` as a redirection operator. Use a `$N = 125` line first.
- `docker compose exec /abs/path` is MSYS-translated on Windows — prefix `$env:MSYS_NO_PATHCONV='1'; ` if you must pass an absolute container path.

---

## Phase 5 — Output a tight report

Structure (use markdown, keep it under one screen):

1. **PR summary** — title, branch, additions/deletions, mergeable status, CI rollup (X/Y green).
2. **Connected tickets** — `#N — title (state)`, one line each.
3. **Scope** — one-sentence "what this PR does", plus the diff stat by service.
4. **Local validation** — table: layer → result → count. Mark CI-only layers as "CI green (not re-run locally)" where applicable.
5. **Manual tests remaining** — numbered list, each item with a copy-paste PowerShell block. If the PR description's test plan has zero unchecked items AND nothing wire-shape-renders, say so explicitly: "Nothing left to validate manually."
6. **CLAUDE.md gate reminders** — only mention if the PR description does not already show evidence:
   - Senior-reviewer pass (`subagent_type: senior-reviewer`)
   - Doc updates per the "Updating documentation" table
   - The five "Verifying UI claims, wire shapes, and component-test fixtures" rules if wire-shape-rendering UI is touched

Do **not** narrate intermediate steps in the final output. The user wants results.

---

## Phase 6 — Stay on the branch, do not push, do not amend

This skill is read-only on git state past `gh pr checkout`. Do not commit, push, rebase, or rerun the senior-reviewer agent unless the user asks. If automated tests fail, report the failure verbatim and stop — don't try to fix it speculatively.

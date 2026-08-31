---
name: deliver-package
description: >
  Pick the next package of pending work and deliver it end to end — establish ground truth
  from GitHub and the priority queue, choose the package, plan against the issue bodies,
  implement in dependency order, run the full gate battery, verify on the running dev stack,
  senior-review to clean, open a draft PR, and report only the manual tests the owner must
  still do. Use when asked to "take the next package", "pick the next issues and implement
  them", "deliver package N", or to work autonomously through a cluster of related issues
  rather than a single user story.
user_invocable: true
---

# Deliver a package

One pass from "what's next?" to a draft PR that has already survived everything an agent can
throw at it. A **package** here is a cluster of open issues (or queue items) that ship
together — not a single issue.

This skill **sequences** work and adds only what is specific to package scale. Every process
rule it needs already lives in `AGENTS.md`/`CLAUDE.md` (Critical rules, Updating
documentation, Mandatory end-of-implementation gate) and `CONTRIBUTING.md` (branch model);
this file points at them rather than restating them, because a second copy of a gate list is
how a gate goes missing. Where this file and AGENTS.md/CLAUDE.md disagree, **they win and
this file is the bug**.

## 1. Establish ground truth before choosing anything

Read the canonical sources first:

- `gh issue list --state open` and each candidate's full `gh issue view <n>` — the real
  source for scope, status, dependencies and the decisions an issue is waiting on. **The
  issue tracker is the only work list.**
- `AGENTS.md`/`CLAUDE.md` → "Immediate priority queue (self-removing)" — the repo's own
  ranking of what is next, tracking epic #262. Queue entries are the natural seed of a
  package, and the queue deletes an entry when its work ships: if the package clears one,
  deleting the entry is part of the package's commit.
- `docs/roadmap.md` — track snapshot (security / ci / hardening / enhancement / dx) with
  ordering notes. It is a dated snapshot by construction; treat it as a pointer, with the
  issues themselves authoritative.
- merged PRs and `git log` — delivery history, used to verify work is actually on `main`.

**Packages are identified by convention, not by GitHub structure.** This repo does not use
GitHub sub-issues or "Package D2" title markers. Membership comes from queue placement, from
the roadmap's track rows, and from issues that reference the same epic or each other. Read
the issue bodies — that is the most current statement of a package's shape that exists. Do
not assume a number range is a package.

**GitHub outranks the roadmap.** If the roadmap or a queue entry says a fix shipped but the
issue is still open — or the fix shipped but `git log` cannot find it on `main` — the stale
text is a finding to correct **in this package's PR**: a stale table is why the next person
picks the wrong work.

```powershell
gh issue list --state open --limit 60
git log --oneline -15 origin/main
gh pr list --state all --limit 10 --json number,title,headRefName,state,baseRefName
git branch -a --contains $SHA      # is that merged PR's work really ON main?
```

**Stacked PRs are a trap.** A PR whose base is another feature branch is invisible in
every "what is on main" view, and GitHub **permanently closes it** when that base branch is
deleted by the parent's merge — closed PRs cannot be retargeted. The recipe that actually
works: **rebase the child branch onto `main` and open a fresh PR**. Better still, retarget
the child to `main` _before_ merging the parent. If you find stranded work, land it first as
its own PR and say so.

## 2. Choose the package

Prefer, in order:

1. The work on the **stated critical path** — the priority queue's first item, or a roadmap
   ordering note — unless step 1 just invalidated it.
2. A cluster whose blockers are now resolved — recheck, the note may be stale (the queue's
   own items 2 and 3 say "operational, not code": the _code_ shipped on `main`, the ops
   work did not).
3. A cluster whose issues form a real dependency chain, so shipping them together is cheaper
   than shipping them apart.

**An issue that states a recommendation is implementable — up to where the decision stops
being the owner's call.** Decision-carrying issues here use a `decision + fix:`-style title
with a bolded _"Recommendation: …"_ in the body (issue #234 is the exemplar). The
recommendation authorises implementing the recommended option, not making the decision
itself: an acceptance item whose subject is a _"Maintainer decision … is recorded"_ box
stays open until the owner picks — name it in the PR instead of ticking it. Never decide a
product call silently in code. **Exclude only an issue that poses an open question with no
recommendation**, or one whose resolution requires input the issue does not provide.

If a blocker is _inside_ the package (issue A blocks issue B), that is an argument **for**
taking both, not for skipping B.

State the choice and the reasoning in one short paragraph before writing any code. If the
honest answer is that the highest-value package is blocked on the owner, say so and pick the
next one — do not invent work to look busy.

## 3. Plan against the issue specs, not against a summary

Read each issue body in full. Issues and queue entries here carry citations (`file:line`),
Contract, Acceptance criteria, Order/dependencies, Docs to update and Gates — usually more
current than the docs, and the citations may still have rotted. **Verify every `file:line`
claim against the code before building on it.** Where the spec is wrong about the code,
trust the code, follow it, and say so in the PR.

Load the skills each issue names, plus `analyze-pr` when a PR of your own needs the same
treatment before it lands. Branch off `main` — one branch and one draft PR per package, typed
prefix per CONTRIBUTING.md. If the package is genuinely too large to review in one sitting,
slice it (3a/3b/3c) and heed the stacked-PR rule above.

## 4. Implement in dependency order, gating incrementally

Build the blocker first, then what it unblocks. Run the cheap gates for what you touched
after each substantial piece, before moving on — a failure found three files later is three
files of rework:

```powershell
npm run typecheck
npm run lint
bash scripts/ruff.sh check duckdb-service image-service
```

Three disciplines that apply specifically at package scale:

- **One canonical path, never a second one.** The repo's recorded failure mode is drift in
  hand-duplicated code: shared `image-service`/`duckdb-service` Python modules had already
  drifted before `scripts/check-python-twins.sh` started pinning the five it knows about. If
  a package needs behaviour another service already has, **extract the shared path** and have
  both call it — never copy it. Anything crossing the backend ↔ homepage boundary lives in
  `contracts/src/index.ts`, never in a service-local interface (ADR-004).
- **Sweep user-facing strings alongside the code, not in a cleanup pass.** Translations live
  in `homepage/src/i18n/translations.ts`, and the two recorded i18n drifts (the 7→5 second
  drift, the `HiveHive-Access-Point` SSID — documented in
  `docs/11-risks-and-technical-debt/README.md`) broke through doc-only checks: user-facing
  strings are a documentation surface.
- **Aggregation endpoints need bucket tests.** Group-by / bucket / fold endpoints must have
  a test that seeds real data and asserts it lands in the expected bucket, not just an
  envelope-shape assertion — see AGENTS.md rule 5 and the `date_trunc('day', ts)` incident.

Route firmware work through `esp32-onboarding` for onboarding concerns, and read
`docs/06-runtime-view/esp-reliability.md` before touching anything on the device — the
reset/streak gotchas there have burned multiple sessions.

## 5. Test every layer the change touches

A package PR runs the **full** gate battery after every review-driven fix, not the subset
near the fix. From the repo root, per AGENTS.md "Run the tests" + "Static gates":

```powershell
npm run typecheck
npm run lint
bash scripts/ruff.sh check duckdb-service image-service
bash scripts/ruff.sh format --check duckdb-service image-service
make test-esp-native
make test-e2e
make test-ui
```

…plus the per-service unit suites CI runs (`npm test` in `backend/` and `homepage/`, `pytest
tests/` in `duckdb-service/` and `image-service/`) and, for any firmware source change, a
`pio run -e esp32cam` cross-compile smoke. Run `make check-citations` and
`bash scripts/check-agent-context.sh` before pushing — and never bypass the hooks to work
around a failure; fix the hook failure (Critical rules).

Beyond running them, four habits that repeatedly find real defects here (AGENTS.md
"Verifying UI claims, wire shapes, and component-test fixtures"):

- **Assert the refusal path, not just the happy path.** A write endpoint that half-applies
  and then errors passes a happy-path test perfectly. The image-upload no-overwrite
  semantics and the unknown-MAC drop are exactly this shape of contract.
- **Mount wire-shape views with a realistic fixture** — the fixture shape is the contract
  under test (rule 3) — and **give every new or changed view a Playwright spec** under
  `tests/ui/tests/` (rule 4, ADR-014). jsdom mocks cannot catch what breaks against the real
  backend and SPA routing.
- **Parametrise over the parameter a defect scales with.** A bug proportional to bucket
  width, day-truncation, or empty input is exactly 0 at the default value, so coverage of
  the default proves nothing. Same for empty collections, single-element lists, and unset
  optionals.
- **Add a drift guard for anything inlined from elsewhere** — enum name sets, duplicated
  module copies, tool-name lists — or the next silent divergence escapes the package's
  coverage. `check-python-twins.sh` protects only the five modules it knows about.

## 6. Verify on the running stack, not only in pytest

**Always.** Unit and pytest suites run the services in isolation; the gap between "tests
pass" and "the page actually shows it" has produced this repo's most expensive regressions
(telemetry sidecar envelope drift, dashboard side-list filtering). Per AGENTS.md rule 1: **if
a doc or PR claims the admin UI renders a field, prove it in a running dev stack before
pushing** — `docker compose up --build` — and look at it in a real browser (or run
`make test-ui`, which boots compose, seeds, and drives real Chromium). `npm test && npm run
build` passing is not sufficient.

**Read what the run says, do not just read the exit code.** A failure is three different
things and they want opposite responses:

| The run shows                                       | It probably means                                      | Do                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| a service fails to boot in compose                  | a Dockerfile / seeding / health-probe break            | fix the compose/Dockerfile; never settle for "works on my host"                                                            |
| an upload or heartbeat fails only over the real LAN | a firewall / WLAN-profile / port issue, not logic      | check `Get-NetFirewallRule -DisplayName "HiveHive*"` and `Get-NetConnectionProfile`; an in-process test does not refute it |
| the UI renders plausible but wrong data             | a genuine contract or logic defect the fixtures missed | that is a finding — fix the fixture, never adjust the assertion                                                            |

Record what a live run _surprised_ you with in `docs/11-risks-and-technical-debt/`. A run
that only confirmed what you already believed was not worth the electricity.

## 7. Documentation duty — before it counts as done

The matrix is in AGENTS.md/CLAUDE.md "Updating documentation (mandatory)"; follow it. Four
items are easy to forget at package scale and are checked here because a package touches
several rows of the table at once:

- **`docs/roadmap.md`** — correct any track row or ordering note the package invalidates. The
  snapshot is dated by construction; fixing it is part of the package, not a follow-up.
- **`docs/api-reference.md` + `docs/08-crosscutting-concepts/api-contracts.md`** — every new
  or changed endpoint and wire-shape field lands in both; the "Field-name drift to watch
  for" section exists precisely because one of the two was skipped once.
- **`docs/11-risks-and-technical-debt/README.md`** — anything the package learned the hard
  way, in "Lessons learned" format (what happened / why / how to avoid), and an **ADR
  addendum** for every decision an issue asked you to make.
- **`CLAUDE.md` + `AGENTS.md`** — process or rule changes update both in the same commit
  (byte-identical pair), then `bash scripts/check-agent-context.sh` certifies the pair.

Docs are **English-only** — never let a UI label from
`homepage/src/i18n/translations.ts` leak into doc prose, and write in plain, unambiguous
prose (`asd-ste100` when another agent or system will parse the text).

## 8. Senior-reviewer loop, then stop at a draft PR

Run the `senior-reviewer` agent (task tool, `subagent_type: senior-reviewer`) against the
branch diff — **once per PR, and again after every round of fixes, until it comes back
clean**. The gate, severity rules, the "run `make check-citations` first" requirement and
the reviews-are-not-oracles rule all live in AGENTS.md "Mandatory end-of-implementation
gate"; read it rather than this paragraph.

Four things that only bite at package scale:

- **Once per PR, not once per package.** A package that ships as two or three PRs needs a
  review per branch — a clean pass on one says nothing about the others.
- **Rounds compound.** Round 2 catches what round 1's _fix_ broke, round 3 what rounds 1 and
  2 obscured. Budget for three, and re-run after every round of fixes.
- **This skill never overrides a live instruction from the user.** It only refuses to let an
  unmet gate go unreported.
- **Assume the reviewer's environment carries no `.env` and no real credentials.** Any claim
  it makes about "live-confirmed" behaviour is unverified; confirm it yourself.

Then hand off: this workflow's landing convention is **a draft PR against `main`, and stop
there** — do not mark it ready or merge it yourself until the owner confirms the manual
tests from §9 passed. If the package includes firmware _source_ changes, say in the PR that
shipping to the field is a separate release: `SEQUENCE` bump + frontend rebuild + promotion
to `production` + `prod-<codename>` tag per
`docs/07-deployment-view/firmware-release.md`. A merged PR alone ships no firmware — that
silent no-op has happened twice (#150, #132).

## 9. Report

Close with, in this order:

1. what shipped, **per issue**;
2. what the gates say — each layer with its **actual numbers**, and any gate not run, named;
3. what the live run found, including anything it broke;
4. **only** the manual tests the owner must do — each with what to do, what a pass looks
   like, and what a failure would mean;
5. anything deliberately left out, and why;
6. confirm CI is green (`gh pr checks $N --watch --fail-fast` — the one gate that runs on a
   different machine than yours), and that the close keywords are where they belong:
   **`Closes #N` goes in the PR title and the commit subject, never in a commit body or PR
   description** — GitHub's auto-close scanner regex-matches anywhere in a merging PR's
   text, and this repo got burned by a body that was quoting the pattern (#104). Verify
   before push:
   `git log <merge-base>..HEAD --pretty=full | grep -nE "(close[sd]?|fix(es|ed)?|resolve[sd]?)\s+#"`
   — every match must be in a subject line. Then:
   ```powershell
   gh pr view $N --json closingIssuesReferences,baseRefName,isDraft
   ```
   A package is by construction a multi-issue PR — the highest-density case for one issue
   silently missing its keyword and staying open forever.

A short honest list beats a long padded one. If something is blocked on the owner, name it
and stop there — **stopping at a draft PR with an honest checklist is a successful outcome.**

## When NOT to use this skill

- A single user story or a one-issue fix → the AGENTS.md process rules + CONTRIBUTING.md.
- Reviewing someone else's PR → `analyze-pr`.
- Onboarding or troubleshooting a physical module → `esp32-onboarding`.
- Cutting a firmware release (a `SEQUENCE`-bumped field shipment) → the
  `docs/07-deployment-view/firmware-release.md` runbook.
- Writing prose another agent or system will parse → `asd-ste100`.

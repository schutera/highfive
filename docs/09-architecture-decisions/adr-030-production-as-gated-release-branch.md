# ADR-030: `production` is the single gated release branch (services + firmware)

## Status

Accepted

## Context

Issue #152 asked which git branch the web services actually deploy from,
because the docs and reality had diverged. Investigation (see
[chapter 11 → "`production` branch drifted from the deployed services"](../11-risks-and-technical-debt/README.md#production-branch-drifted-from-the-deployed-services-resolved-152))
found three problems stacked on top of each other:

1. **Docs said `production`; the live auto-deploy used `main`.** The on-host
   `scripts/deploy.sh` (systemd timer, every 2 min) polled `origin/main` and
   `git pull --ff-only`. Nothing keyed off `production`. The
   `production`-deploy docs were stale narrative; live prod ran `main`-only
   code (e.g. the #142 admin session, absent on `production`).
2. **Firmware OTA and the services track were documented as separate.**
   Firmware was "cut on `main` + `prod-*` tags"; services "deployed from
   `production`". Two deploy tracks, two stories, one repo.
3. **`production` was simply never fast-forwarded after the live source was
   repointed at `main`.** No mechanism kept it current, nobody owned it, and
   nothing failed when it fell behind — so it rotted quietly for two months.

   > **Correction (PR #194 review).** An earlier revision of this ADR claimed
   > the two branches "shared no common git ancestor" because `main`'s history
   > had been squashed/rebuilt into an orphan root, and that `production` was
   > therefore *structurally unable* to fast-forward. **That is false**, and it
   > mattered: it was the sole recorded justification for discarding history
   > with a force-reset rather than merging. Verified against the repo:
   >
   > ```
   > git rev-list --max-parents=0 main    → d9ac93d  (2025-06-24, one root)
   > git rev-list --max-parents=0 bf8b314 → d9ac93d  (the SAME root)
   > git merge-base main bf8b314          → da1b21d  (2026-04-26)
   > ```
   >
   > One root, shared, with a real merge base. A merge was always possible; it
   > was rejected for tidiness, not blocked by topology. The cited `#124` is
   > `f6a89c8`, a senior-reviewer config commit unrelated to history rewriting.
   > Recorded here rather than quietly deleted because CLAUDE.md's "never trust
   > commit messages over code" rule exists for exactly this, and this document
   > broke it while adopting it.

`production` carried **25** unique commits
(`git rev-list --count main..bf8b314`). What follows is what was actually
checked, rather than a summary — this paragraph is now the *only* justification
for discarding them, so it states its own evidence:

- **21 of 25 are homepage/setup UI work** (the Phase-1/2 a11y pass, the type
  ramp, the skill-audit refactors). Superseded wholesale by the homepage
  redesign already on `main`.
- **17 paths exist on the archived branch and not on `main`**
  (`git diff --name-only --diff-filter=D bf8b314 origin/main`): the superseded
  `documentation/` folder (9 files), the root `ARCHITECTURE.md` /
  `FRONTEND_PLAN.md` / `UBIQUITOUS_LANGUAGE.md` planning docs — all three
  superseded by the arc42 tree — the old `homepage/src/assets/firmware.bin`
  location, and three test files (`backend/tests/auth.test.ts`,
  `homepage/src/__tests__/App.test.tsx`, `espConfig.test.ts`) whose subjects
  are covered by the current suites.
- **4 are ESP32 commits, and one of them is NOT content-equal on `main`.**
  The archived tip `bf8b314` ("use `esp_task_wdt_reconfigure` and defer
  loopTask subscribe past AP setup") uses an API that does not appear anywhere
  on `main`: `git grep esp_task_wdt_reconfigure origin/main -- ESP32-CAM/`
  returns nothing, and `main` still uses the IDF-4 `esp_task_wdt_init` /
  `esp_task_wdt_add` pair. **`main` solves the same problem a different way** —
  a ≥60 s `TASK_WDT_TIMEOUT_S` (with a `static_assert` and ADR-007 behind it)
  plus `runAccessPoint()` feeding the watchdog — and the AP-mode reboot loop is
  recorded as fixed in
  [troubleshooting.md](../troubleshooting.md). So the *defect* is closed on
  `main`; the *commit* is not an ancestor of it. Nothing live is lost, but
  "already exists on `main`" would have been the wrong description.

> **Two corrections from the PR #194 review.** An earlier revision of this
> paragraph said **136** commits (actual: 25) and described the only-on-branch
> files as just "the superseded `documentation/` folder, old planning docs, and
> the old firmware.bin location" — which omits four test files and says nothing
> about the ESP work. Both are recorded rather than silently edited: this
> paragraph is load-bearing for a destructive act, and the review dimension it
> failed is precisely "an assertion of verification is not verification."

Options weighed: (1) adopt `main` as the source and retire `production`;
(2) keep `production` and fast-forward it each deploy; (3) treat
`production` as an intentional gated/staging branch. The maintainer chose a
variant of (2)+(3): `production` as a **gated release branch** carrying
**both** tracks.

## Decision

`production` is the single release branch for both the web services and the
firmware OTA. `main` is the continuous-integration line; **a release is a
deliberate fast-forward of `production` onto a chosen `main` commit**
(`git push origin <sha>:production`), so `main` may run ahead of what is
live. The on-host `scripts/deploy.sh` tracks `production` (`BRANCH=production`),
pulls it `--ff-only`, rebuilds only changed services, and — for
firmware-source changes, and only when `FIRMWARE_AUTO_OTA=1` in
`.deploy.env` — publishes the OTA and cuts the `prod-<codename>` tag on
`production`. To make future promotions clean fast-forwards, the
divergence was reconciled once: the old branch was archived (tag
`archive/production-2026-05-02` → `bf8b314`) and `production` was force-reset
onto `main`'s history. (A merge was possible — see the correction above — but
the 25 divergent commits were verified stale and replacing them was chosen for
tidiness.)

## Consequences

- **Single, unambiguous deploy source.** Docs, `scripts/deploy.sh`, and
  reality now agree; the issue-#152 "verify your actual deploy source"
  hedges are removed.
- **A promotion gate by convention, NOT by enforcement.** `main` accumulates
  merged work continuously; promoting to `production` is the explicit "ship
  it" act. The 2-minute timer still automates the _deploy_; the _decision_ is
  the `production` push.

  Be precise about what is and isn't enforced, because the word "gate"
  invites a dangerous assumption:
  - Neither branch has GitHub branch protection.
  - `.github/workflows/tests.yml` triggers on `main` (push + PR) and never on
    `production`, so a promoted commit is not re-tested at promotion time.
  - `git push origin <sha>:production` accepts **any** fast-forwarding commit.
    It need not be on `main` and need not have passed CI. Nothing mechanical
    distinguishes a promotion from a stray push.

  **`production` must stay unprotected.** `scripts/deploy.sh`'s
  `publish_firmware` commits the SEQUENCE/VERSION auto-bump and pushes it to
  `BRANCH` from the host. Enabling branch protection would reject that push,
  and because the OTA manifest is already published by then, the fleet would
  receive firmware whose bump is **not recorded in git** — the "merging
  firmware source is not a release" trap from the other direction. If a real
  enforced gate is ever wanted, move the auto-bump commit to `main` first
  (see [#225](https://github.com/schutera/highfive/issues/225)).
- **Future updates are fast-forwards.** Because `production` was reset onto
  `main`, it is now a prefix of `main`'s history; the `--ff-only` pull on
  the host keeps working and a non-fast-forward push is a loud failure
  rather than silent drift.
- **Firmware and services ship together.** One `production` push can carry a
  service change and a firmware bump. The trade-off: an on-host auto-bump
  (`scripts/deploy.sh` `publish_firmware`) commits to `production`, so that
  commit must be **merged** back to `main` to keep the integration line in
  sync — otherwise `production` gains a commit `main` lacks and the next
  promotion is no longer a pure fast-forward. It must be a *merge* (or
  re-promotion), **not a cherry-pick**: cherry-picking creates a distinct
  content-equal commit on `main`, leaving `production`'s actual bump commit
  off main's history, so `production` stays a non-ancestor and the next
  `main:production` push is still rejected. The cleaner long-term fix is to
  have `publish_firmware` commit to `main` and then promote (mirroring the
  manual checklist), so the auto path stops being the one exception to the
  fast-forward invariant — tracked in [#225](https://github.com/schutera/highfive/issues/225).
- **One-time operator cutover required.** The prod host previously tracked
  `main`; it must `git checkout production` once (see
  [production-deployment.md → Releasing](../07-deployment-view/production-deployment.md#releasing-the-gated-production-branch)).
- **History loss is bounded — but the recovery point is not on the remote
  yet.** The pre-#152 `production` history is discarded from the branch and
  preserved in the local tag `archive/production-2026-05-02`.
  `git ls-remote --tags origin | grep archive` currently returns nothing, so
  on GitHub those 25 commits survive only because the stale branch
  `origin/fix/cutover-blockers-prod-2026-05-02` happens to contain
  `bf8b314` — and that branch is a prime candidate for the repo's own
  `clean_gone` cleanup. Run `git push origin archive/production-2026-05-02`
  to make the claim in this bullet true.

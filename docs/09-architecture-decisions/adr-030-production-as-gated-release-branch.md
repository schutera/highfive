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
3. **`main` and `production` shared no common git ancestor.** `main`'s
   history had been squashed/rebuilt (orphan root, 2026-05-21, `#124`),
   while `production` still rooted at the original 2025-06-24 "Initial
   commit". With unrelated histories, `production` could never be
   fast-forwarded or cleanly merged from `main` — which is *why* it silently
   rotted once the live source was quietly repointed at `main`.

`production`'s 136 unique commits were verified stale (their content —
contracts package, `ModuleId`, the homepage redesign — already exists on
`main`; the only-on-`production` files were the superseded `documentation/`
folder, old planning docs, and the old `homepage/src/assets/firmware.bin`
location). Nothing live would be lost by replacing them.

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
firmware-source changes — publishes the OTA and cuts the `prod-<codename>`
tag on `production`. To make future promotions clean fast-forwards, the
unrelated-history split was reconciled once: the old branch was archived
(tag `archive/production-2026-05-02`, pointing at `bf8b314`) and
`production` was force-reset to `main`'s tip.

## Consequences

- **Single, unambiguous deploy source.** Docs, `scripts/deploy.sh`, and
  reality now agree; the issue-#152 "verify your actual deploy source"
  hedges are removed.
- **A real promotion gate.** `main` accumulates merged work continuously;
  promoting to `production` is the explicit "ship it" act. The 2-minute
  timer still automates the *deploy*, but the *decision* is the
  `production` push.
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
  fast-forward invariant — tracked as a follow-up.
- **One-time operator cutover required.** The prod host previously tracked
  `main`; it must `git checkout production` once (see
  [production-deployment.md → Releasing](../07-deployment-view/production-deployment.md#releasing-the-gated-production-branch)).
- **History loss is bounded.** The pre-#152 `production` history is
  discarded from the branch but preserved in `archive/production-2026-05-02`.

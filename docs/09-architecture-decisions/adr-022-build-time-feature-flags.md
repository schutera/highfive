# ADR-022: Homepage feature flags are build-time `VITE_*` env vars, default off

## Status

Accepted. First instance: the public dashboard "Latest captures" gallery (#154), which was
shipped, then reverted ([PR #176](https://github.com/schutera/highfive/pull/176)) because
showing un-vetted ESP32-CAM photos publicly is risky until segmentation guarantees only bee
nests are visible — and was reintroduced disabled behind the flag this ADR describes. (That
gallery was later removed in favour of the #165/#166 hole-detection snip grid + time-lapse,
which the same flag now gates; the build-time-flag mechanism this ADR establishes is unchanged.)

## Context

We want to develop a feature, merge it to `main`, and keep it **off** until it is ready to
show — without parking it on a long-lived branch that drifts and accrues merge conflicts,
and without a code change to turn it on or off later. The carousel is the motivating case:
the mechanic took several iterations and is worth keeping in-tree, but it must not render in
production yet.

The homepage is a Vite single-page app served as a static bundle (nginx serves
`homepage/dist`). It already reads build-time config through `import.meta.env.VITE_*`
(`VITE_API_URL`, `VITE_STRIPE_LINK`), which Vite **inlines into the bundle at build time**
— the homepage `Dockerfile` bakes them via build ARGs. There is no server-side runtime
config channel to the homepage today (a config so served would have to come from the
backend, e.g. `GET /api/config`).

## Decision

Homepage feature toggles are plain **build-time `VITE_*` boolean env vars**, read through a
single module, [`homepage/src/lib/featureFlags.ts`](../../homepage/src/lib/featureFlags.ts),
which exports one `const` per flag (`=== 'true'`). Unset or any non-`'true'` value reads as
**off** — the safe default. Components gate UI on the exported const; the flag lives only at
the mount site, not threaded through the feature's own code. First flag:
`VITE_ENABLE_DASHBOARD_IMAGES`, which gates the per-module imagery in `ModulePanel.tsx`
(originally `LatestCaptures` #154; now the `NestSnipGrid` snip grid + time-lapse, #165/#166).
Off in the
production image; the dev `docker-compose.yml` and the UI-test stack
(`tests/ui/docker-compose.ui.yml`) set it `true`, and `homepage/vitest.config.ts` defines it
`true` so jsdom suites exercise the gated path.

### Alternatives rejected

- **Runtime flag served by the backend** (`process.env` → `GET /api/config` → fetched by the
  homepage). This is the only way to flip a homepage feature **without a rebuild**, and is
  the right tool if/when we need per-environment runtime toggling. Rejected for now: it adds
  an endpoint, a contract type, and a fetch/loading path for a need we don't yet have. The
  goal here is "in `main`, disabled, restorable without re-coding", which build-time meets.
- **Keep the feature on a branch.** Exactly the long-branch drift / merge-conflict cost we
  are avoiding.

## Consequences

- A feature can ship to `main` disabled and be turned on later by setting one env var — no
  code change, no revert-of-a-revert.
- **Build-time, not runtime:** flipping a flag in production requires a fresh `vite build` /
  homepage image rebuild and redeploy. It is a deploy-time toggle, not a hot switch. This is
  the documented trade-off; if a future flag needs runtime flipping, use the rejected
  backend-served approach (and supersede this ADR for that flag).
- The disabled feature's code still ships in the bundle (it is gated, not tree-shaken out).
  Acceptable: the homepage holds no secrets (ADR-019), so dead UI code is not a leak.
- One obvious home for "what flags exist": `featureFlags.ts`. Each flag is one line; default
  is uniformly off.

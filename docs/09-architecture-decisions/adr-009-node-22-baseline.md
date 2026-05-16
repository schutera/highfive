# ADR-009: Node.js 22.12+ as the baseline for `backend` and `homepage`

## Status

Accepted

## Context

The `homepage` workspace builds with Vite 7. Vite 7 emits a deprecation warning on every invocation under Node 18:

```
You are using Node.js 18.17.1. Vite requires Node.js version 20.19+ or 22.12+. Please upgrade your Node.js version.
```

Builds and tests still succeed under Node 18 today, but the warning is forward-looking: a future Vite minor will drop 18.x support outright and break the homepage build without further notice. The fleet also runs Node-side tooling across three surfaces with no shared floor:

- **Local dev** — contributors free-pick whatever `node --version` resolves on their machine. PR #88's smoke test surfaced Node 18.17 in active use.
- **CI** — `.github/workflows/tests.yml` pinned `node-version: '20'` in two jobs prior to this decision.
- **Production containers** — four Dockerfiles pinned `node:20-alpine` (`backend/Dockerfile` ×2 stages, `backend/Dockerfile.dev`, `homepage/Dockerfile`, `homepage/Dockerfile.dev`).
- **Bare-metal production** — [`production-runbook.md`](../07-deployment-view/production-runbook.md) told operators to install "Node.js 18+" — directly contradicting any Vite-imposed floor.

Node 18 reached end-of-life April 2025; Node 20's active-support window ended April 2026. Node 22 is the current LTS line (Iron, supported through April 2027) and matches the upper of Vite 7's two supported tracks.

Rejected alternatives:

- **Stay on Node 20 (20.19+).** Closes the immediate warning but lines us up for another forced bump within ~6 months when the next Vite minor drops 20.x. Choosing the LTS that has the longest remaining runway is the cheaper option.
- **Pin a single minor (e.g. `=22.12.0`).** Over-constrains. The Vite floor is `22.12+`; any Node 22.x patch ≥ 22.12 satisfies it. A range floor is the right semantics.
- **Treat `engines` as advisory only.** This is npm's default — `engines.node` emits a warning, not an error, unless `engine-strict=true` is set. Leaving it advisory means `docs/02-constraints/` can claim a floor that the install machinery doesn't actually enforce. Mismatched claim and reality is the failure mode `docs/11-risks-and-technical-debt/` "Telemetry sidecar envelope drift" warns about in a different shape; we don't want to repeat the pattern.

## Decision

The baseline Node runtime for `backend` and `homepage` is **`>=22.12.0`**, enforced at three layers:

1. **Hard at install time.** `engines.node: ">=22.12.0"` is declared in `package.json` at the workspace root and in every workspace (`contracts`, `backend`, `homepage`). A root `.npmrc` sets `engine-strict=true` so `npm ci` / `npm install` **fails** on a sub-22.12 runtime instead of printing an advisory warning.
2. **Hard in CI.** Both Node-using jobs in `.github/workflows/tests.yml` (`backend-unit`, `homepage-unit`) pin `node-version: '22'` via `actions/setup-node@v4`.
3. **Hard in containers.** All four Dockerfiles use `FROM node:22-alpine`. Re-tagging from Docker Hub would also work, but pinning the major in the Dockerfile keeps the dev / CI / prod runtime aligned without rebuild trickery.

The advisory `engines.node` field is intentionally backed by `engine-strict=true`. A floor advertised in one place and enforced nowhere is a lie that the next contributor will discover the hard way.

## Consequences

**Enables:**

- Vite 7's Node-version warning disappears from local builds and CI logs.
- The constraints table in [`docs/02-constraints/`](../02-constraints/README.md) can truthfully claim the floor is enforced — `engine-strict=true` turns the field from advice into a gate.
- Future Node bumps follow a single mechanical path: bump four Dockerfiles, two CI jobs, four `engines.node` fields, and the runbook prose. No hidden surfaces.

**Costs:**

- Contributors on Node 18 / 20 get a hard install failure (`EBADENGINE`) on first `npm ci`. The error names the violated constraint, so the next step is unambiguous (`nvm install 22 && nvm use 22`), but it is a sharper edge than the previous warning. Updated docs and the README make the requirement discoverable before someone hits the install gate.
- Production runbook's `apt install nodejs` shortcut no longer works on Ubuntu 22.04 (default `nodejs` package is too old). [NodeSource](https://github.com/nodesource/distributions) or `nvm install 22` replaces it. Called out in [`production-runbook.md` Prerequisites](../07-deployment-view/production-runbook.md).

**Forecloses:**

- Operators on platforms where Node 22 is unavailable (very old long-term-support Linux distros, exotic ARM SoCs) can't run HighFive backend/frontend without a NodeSource workaround. Acceptable: the project's deployment story is Docker-first; the bare-metal runbook is explicitly "non-recommended legacy path".

## References

- [Vite 7 release notes — supported Node versions](https://vite.dev/guide/migration.html)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases) — Node 22 supported through 2027-04
- [GitHub issue #90](https://github.com/schutera/highfive/issues/90) — original trigger
- [`docs/02-constraints/README.md`](../02-constraints/README.md) — runtime-floor row in the constraints table
- [`docs/07-deployment-view/production-runbook.md`](../07-deployment-view/production-runbook.md) — bare-metal install prerequisite

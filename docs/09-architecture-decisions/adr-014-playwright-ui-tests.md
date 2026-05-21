# ADR-014: UI tests run real Chromium against the production-built homepage via Playwright

## Status

Accepted

## Context

Before this ADR the testing pyramid had three layers: per-service unit
tests, ESP host tests, and an HTTP-only e2e pipeline test. None of them
exercise the homepage in a real browser. The vitest + jsdom suites
under `homepage/src/__tests__/` mock `fetch` via `vi.mock('../services/api', …)`
and render React into jsdom — so a wire-shape mismatch between
backend and homepage that compiles cleanly (every field optional)
ships green tests, green builds, and a broken dashboard.

Chapter 11 records two regressions that show this gap is real, not
theoretical:

- **Telemetry sidecar envelope drift** — every `TelemetryRow` field
  rendered `—` for weeks because the wire shape changed under the
  jsdom mocks. The author trusted `npm test && npm run build` as
  proof the fix was real and never opened the dev stack.
- **Three layers, one rule was actually four surfaces** — the dashboard
  side-list silently filtered out pending modules. Prose contract said
  the pill appeared; code said otherwise. Two senior-review rounds
  missed it; an operator opening the dev stack caught it on pre-merge
  smoke.

The chapter-11 meta-lesson is explicit: _a behavioural contract
asserted only in a comment block, a PR description, or a chapter-11
entry is not a contract — it is a wish._ The fix is a test layer that
mounts the production-built homepage in a real browser and asserts on
rendered output.

We considered three options:

1. **Playwright (TS)** — auto-wait, trace viewer, ships its own
   Chromium, native TS bindings, MS-maintained.
2. **Playwright (Python)** — same engine, Python bindings; matches
   `tests/e2e/`'s language for consistency.
3. **Cypress / Puppeteer** — Cypress is heavier and harder to drive
   from a headless agent; Puppeteer is Chrome-only with no first-class
   trace viewer.

TypeScript Playwright won because the load-bearing motivation is wire-
shape drift, and ADR-004 already pins those wire shapes in
`@highfive/contracts`. A Python test would re-encode the shape in
dicts and recreate the prose-contract antipattern at one more layer;
a TypeScript test can `import { TelemetryEntry } from '@highfive/contracts'`
so the fixture shape is the same artifact `homepage/` consumes.

The runner package lives outside the root npm workspaces array so the
~300 MB Playwright browser cache stays out of homepage/backend/contracts
resolution.

## Decision

UI tests live under `tests/ui/` as a standalone npm package (not a
root workspace) with the following structural rules:

1. **TypeScript Playwright bindings.** Specs `import` wire-shape
   types from `@highfive/contracts` so a future contracts rename is a
   compile error in the spec, not a silent `undefined`-pluck.
2. **Production-built homepage as the test artifact.** Specs run
   against the `homepage/Dockerfile` (nginx-served), not vite dev. The
   production build is what users hit; the test must pin the same
   artifact.
3. **Compose project name `highfive-ui`** so the stack coexists with
   the dev stack (`highfive`) and the e2e pipeline stack (`highfive-e2e`).
4. **Iteration-1 scope is chromium-only.** Firefox/WebKit are deferred
   until a real cross-browser bug surfaces.
5. **Specs that render wire-shape data must drive both the wire
   surface and the DOM surface separately.** The chapter-11 envelope
   drift was a DOM-surface failure with a correct wire surface; asserting
   on either alone misses the inverse defect.

## Consequences

**Positive.**

- Chapter-11 regressions are now pinned by automated checks
  (`dashboard-telemetry.spec.ts`, `dashboard-side-list.spec.ts`).
- The Claude Code agent running in the cloud sandbox can drive UI
  tests itself, rather than only running unit tests, so refactor
  PRs get a real-browser gate without requiring a maintainer's local
  smoke check.
- The contracts package's "drift becomes a compile error" guarantee
  (ADR-004) now reaches the test layer too — Playwright specs that
  type their fixtures against `@highfive/contracts` fail to compile
  when the wire shape changes.

**Negative.**

- CI cold-build cost increases by ~5 min (homepage production build +
  Chromium install). Browser cache (`actions/cache@v4` keyed on
  `tests/ui/package-lock.json`) keeps warm runs near 1 min.
- `tests/` now contains two language toolchains (Python for `tests/e2e/`,
  TypeScript for `tests/ui/`). The split is documented in
  `tests/ui/README.md`.
- The setup wizard's flash step (W3C Web Serial in `Step2Flash`) is
  not exercised — `setup-wizard-happy-path.spec.ts` uses the skip
  branch. That surface still needs hardware-in-the-loop testing.

**Forecloses.**

- Cypress in this repo. Two browser-automation frameworks would
  fragment the wire-shape import discipline rule 1 establishes.

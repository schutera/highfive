# ADR-020: Module coordinates are generalized to ~1 km for every caller

## Status

Accepted ([#145](https://github.com/schutera/highfive/issues/145)). Follow-up to
[ADR-019](adr-019-admin-session-no-bundle-secret.md) (which made reads public and
flagged this as deferred work).

## Context

ADR-019 / [#142](https://github.com/schutera/highfive/issues/142) made the read
endpoints public — the dashboard and map must render for anonymous visitors, and
a single-page app cannot hold a secret, so the old `X-API-Key` gate protected
nothing. A direct consequence: `GET /api/modules` and `/api/modules/:id` returned
**exact** module coordinates (full float precision) to anyone with no credential.
For wild-bee nest sites that is a privacy/safety problem — vandalism, nest
disturbance, specimen collection.

A `fuzzLocation()` already existed in `homepage/src/components/MapView.tsx`, but
it was **cosmetic only**: it ran in the browser _after_ the exact coordinates had
already shipped over the wire (visible in DevTools / the raw JSON), and its offset
was re-derivable from `moduleId` alone — the algorithm shipped in the public JS
bundle with no secret, so it was trivially reversible. It protected nothing.

Two design forces, both from #145:

- **Statistical robustness.** A jitter that re-randomizes per request can be
  averaged back to the true centre over many samples. Whatever transform we pick
  must be _constant per module_.
- **Data minimization (GDPR).** Exact nest locations are personal/sensitive data;
  the less of it retained, the better. The issue explicitly asks that _even admins_
  not have access to exact GPS, and suggests rounding at the source (the ESP).

## Decision

Generalize every served and stored coordinate to **2 decimal places** (~1.1 km
grid cells). Two sub-decisions follow from the forces above:

1. **Round (lossy), don't offset.** Rounding to a fixed grid is deterministic and
   _irreversibly lossy_ — the served value omits the precise digits, so it can be
   neither statistically averaged back nor reversed if the code/secret leaks. A
   secret-seeded offset, by contrast, still encodes full precision under the
   offset and is reversible if the secret leaks. Lossy rounding is the stronger
   privacy posture.
2. **Coarsen for everyone.** The API never returns >2 dp to any caller, admin
   included. There is therefore **no per-request auth branch** on the read routes,
   and (after round-on-write) no precise coordinate is persisted anywhere.

Implemented as **one rule, mirrored at three layers** — the same pattern already
used for `isPlausibleFix` (firmware / server / homepage):

- **ESP firmware** rounds the Google fix the moment it is parsed
  (`hf::roundCoord` in `ESP32-CAM/lib/geolocation/`, applied in
  `esp_init.cpp`'s `attemptGeolocation`) — data minimization at source, so the
  precise value never even traverses the network. Ships via an OTA release.
- **duckdb-service** rounds on **every write** — the `ModuleData` validator
  (registration) and the heartbeat geo-patch in `routes/heartbeats.py` — and a
  one-shot migration in `db/schema.py` coarsens rows already stored on operator
  volumes. This is the **enforcement boundary**: the server cannot trust the
  client (old firmware, spoofed `/upload`), and after it runs no precise
  coordinate is persisted. **Destructive by design** — the precise value is gone.
- **backend** re-rounds at the DTO boundary (`database.ts`) via
  `coarsenLocation` from `@highfive/contracts` — defence-in-depth so the public
  API never emits >2 dp even for a not-yet-migrated row or a future write path
  that forgets. `PUBLIC_COORD_DECIMALS` in the contracts package is the canonical
  declaration for the TS layers; Python and C++ hardcode the same `2` with a
  cross-reference comment.

The client-side `fuzzLocation()` is removed — coordinates now arrive already
generalized, so the browser plots them directly.

## Consequences

**Positive**:

- The #145 acceptance holds: unauthenticated reads return generalized
  coordinates, no caller (incl. admin) receives finer precision, and the
  precision contract is pinned in `@highfive/contracts` and tested at the backend
  (`coarsen-location.test.ts`), duckdb (`test_modules.py` / `test_heartbeats_endpoint.py`
  / `test_schema_migration.py`), firmware (`test_native_geolocation`), and
  Playwright (`coordinate-generalization.spec.ts`) layers.
- No secret to manage (lossy rounding needs none) and nothing reversible at rest.

**Negative**:

- **Irreversible.** The migration permanently rounds existing coordinates; the
  precise values collected before this shipped are gone. This is the intended
  embodiment of the policy, not a regret, but it means an operator who later wants
  exact pins cannot recover them — a module would have to re-onboard, and even
  then only the 2-dp value is kept.
- ~1 km is coarse enough that two genuinely distinct nests <1 km apart collapse to
  the same grid cell on the map (the 12 km clustering already grouped them, so the
  visible effect is minor).
- The firmware layer only takes effect after an OTA release (SEQUENCE bump per the
  [firmware release runbook](../07-deployment-view/firmware-release.md)); until a
  module updates, the server-side round-on-write is what protects its coordinates.

**Forbidden**:

- **Do not** reintroduce a client-side-only coordinate transform as a privacy
  control — anything the browser computes ships the exact input first.
- **Do not** add an auth branch that serves exact coordinates to admins. "Coarsen
  for everyone" is the decision; exact GPS is not retained, so there is nothing
  finer to serve.
- **Do not** switch to a re-randomized per-request jitter — it is averageable back
  to the true centre. The transform must stay constant and lossy.

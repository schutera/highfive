# API contracts and field-name discipline

Frontend and backend share a single source of truth for typed DTOs:

- **`contracts/src/index.ts`** — npm workspace package
  `@highfive/contracts`, imported by both `backend/` and `homepage/`.
  Field-shape drift becomes a TypeScript compile error.

For HTTP shapes (request/response examples), see
[../api-reference.md](../api-reference.md).

## Why the shared package exists

Both `backend` and `homepage` previously declared their own copies of
`Module`, `ModuleDetail`, `NestData`, `DailyProgress`. They drifted
(e.g. `nestId: number` on the homepage vs `nest_id: string` on the
wire — fixed in `ab0ef3d`). Moving the canonical types into a
workspace package made any future drift fail at TypeScript compile.

If you change a wire field, update `contracts/src/index.ts` first
and let the compile errors guide the rest.

## `HeartbeatSnapshot` and the extended `Module`

PR 17 added the **telemetry heartbeat** channel
(`POST /heartbeat` — `heartbeat` route in
`duckdb-service/routes/heartbeats.py`, fired hourly by firmware's
`sendHeartbeat` in `ESP32-CAM/client.cpp`) and
surfaced the most recent snapshot on every `Module`. This is
**distinct from** the post-upload aggregate at
`POST /modules/<mac>/heartbeat`
(`duckdb-service/routes/modules.py:266`), which is a separate
endpoint with a different body and different side effects — see
[duckdb-service.md](../05-building-block-view/duckdb-service.md)
and the [glossary](../12-glossary/README.md) for the full
disambiguation.

Both heartbeat endpoints canonicalise their `mac` / `<module_id>`
input through `ModuleId.model_validate(...)` before any DB write, so
colon-form, dash-form, and uppercase MACs all collapse onto the same
canonical 12-hex `module_id` PK. This mirrors the `/upload` seam in
`image-service/app.py` — see
[../api-reference.md](../api-reference.md) §3.7 for the wire-level
behaviour.

The wire shape:

```ts
export interface HeartbeatSnapshot {
  receivedAt: string; // ISO timestamp
  battery: number | null;
  rssi: number | null;
  uptimeMs: number | null;
  freeHeap: number | null;
  fwVersion: string | null; // bee-name string, see ADR-006
}
```

`Module` gained `email`, `updatedAt`, `lastSeenAt`, and
`latestHeartbeat`. The shape lives in the shared package by
deliberate decision —
[ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md).

`Module.lastSeenAt` is **derived** in the backend, not stored. The
formula at `backend/src/database.ts:174-184` reads three wire
fields off the duckdb response and takes the freshest:

```ts
// pseudocode of backend/src/database.ts:174-184
const candidates = [
  m.updated_at, // module_configs.updated_at
  m.last_image_at, // SELECT MAX(uploaded_at) FROM image_uploads ...
  m.latestHeartbeat?.receivedAt, // SELECT MAX(received_at) FROM module_heartbeats ...
].filter(Boolean);
const lastSeenAt = max(candidates.map(toEpoch));
```

The DTO field that exposes `last_image_at` to the frontend is
`Module.lastApiCall` (database.ts:205) — same data, different name
on the wire vs. the DTO. If the Python side renames any of the
three source columns, the e2e test in
`tests/e2e/test_upload_pipeline.py` is the canary.

## Field-name drift to watch for

These three patterns have caused real bugs. Grep before changing
anything in this neighbourhood.

### `modul_id` (still live)

`POST /add_progress_for_module` carries `modul_id` (typo, missing
"e"). Everywhere else (DB column, route param, DTO) the canonical
name is `module_id`. Verified in `duckdb-service/models/progress.py`'s
`ClassificationOutput` and `duckdb-service/routes/progress.py`.

**Why it exists**: original misspelling, kept on the wire to avoid
breaking image-service ↔ duckdb-service in lockstep.

**Recommendation**: keep on the wire for now. When the contract next
needs a breaking change, rename to `module_id` on both ends in the
same PR. Add a Pydantic alias in the transition.

### `progess` / `hateched` (fixed, do not regress)

Backend `database.ts` was reading `p.progess_id` and `p.hateched`
when normalising rows from `duckdb-service /progress`. The DB and
API actually emitted the correctly spelled `progress_id` and
`hatched`. The code worked at runtime because both spellings were
JS object keys — every cached `DailyProgress` had `progress_id` and
`hatched` set to `undefined` for the lifetime of the bug.

Fixed in commit `778c9b1`. Comments in `database.ts`
("Backend name!") had asserted the typos were canonical. No contract
test covered the read.

### TS interface duplication (resolved)

Resolved on 2026-04-26 by introducing the `@highfive/contracts`
workspace package. Don't reintroduce per-service DTO copies.

## General mitigation

Treat any field whose spelling differs by one letter from a real
English word as a smell. Add a contract-level integration check
(or a Pydantic alias with the correct spelling) before the next
firmware refactor.

Full glossary of field names with aliases-to-avoid:
[../12-glossary/README.md](../12-glossary/README.md).

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

## Field-name drift to watch for

These three patterns have caused real bugs. Grep before changing
anything in this neighbourhood.

### `modul_id` (still live)

`POST /add_progress_for_module` carries `modul_id` (typo, missing
"e"). Everywhere else (DB column, route param, DTO) the canonical
name is `module_id`. Verified in
`duckdb-service/models/progress.py:6` and
`duckdb-service/routes/progress.py`.

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

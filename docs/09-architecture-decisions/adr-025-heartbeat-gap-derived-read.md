# ADR-025: Server-side heartbeat gaps are a derived read, not a persisted table

## Status

Accepted ([#172](https://github.com/schutera/highfive/issues/172), option 3). Companion
to the device-reported failure streak (`last_hb_fail_*`, #172 option 1, already shipped)
and the stage breadcrumb now carried on the heartbeat (#172 option 2).

## Context

When a field module reboot-loops, an hourly heartbeat that fails **never reaches the
server** (no 2xx), so the device can only report failures it _lived through and recovered
from_ (the `last_hb_fail_*` streak on the next 2xx). The silent windows — power loss, a
hang before the send, a timeout — leave no device-side trace. #172 option 3 asks for
those gaps to be **queryable on the server side**.

`duckdb-service` already runs `services/silence_watcher.py`
([ADR-005](adr-005-silence-watcher-in-duckdb-service.md)): a background thread that flags
a module silent after 3 h and fires a Discord alert, recording suppression state in the
single-writer `module_configs.last_silence_alert_at`. It does **not** keep a queryable
per-gap record, and a 3 h power-loss looks identical to 3 h of 5xx.

## Decision

Expose heartbeat gaps as a **read-only derived query** over the already-persisted
`module_heartbeats.received_at` timeline — no new table, no new writer, no background job.
`GET /heartbeats/<id>/gaps` (duckdb-service) computes intervals between consecutive
heartbeats with a `LAG(received_at) OVER (ORDER BY received_at)` window function and
returns those wider than a 90 min threshold (one missed hourly ping plus margin, under
the 2 h liveness watchdog), newest first. The backend proxies it admin-gated at
`GET /api/modules/:id/heartbeat-gaps` (camelCased to the `HeartbeatGap` contract); the
homepage renders a compact list in the admin Telemetry section beside
`HeartbeatDiagnostics`.

### Alternatives rejected

- **A `heartbeat_gaps` table + a gap-detector background job.** Duplicates data that is
  fully derivable from `module_heartbeats` (so it can drift), and adds a second writer to
  module state — exactly what ADR-005 keeps `duckdb-service` from doing. A derived read
  can never disagree with the source rows.
- **Extend `silence_watcher` to log every gap.** Conflates coarse "is it down now?"
  alerting with a fine-grained per-gap audit trail, and still persists derivable data.
- **Server-side logging of rejected/5xx heartbeats.** The server cannot see a timeout (a
  request that never arrived leaves no trace), so this would capture only the rare
  malformed-but-delivered case — marginal value for new ingestion-path surface.

## Consequences

- Zero schema/migration cost and no drift risk: the gap list is a pure function of the
  heartbeat rows. Adding/backfilling heartbeats automatically corrects past gaps.
- Cost is per-request computation, bounded by `LIMIT` and the per-module row count
  (indexed by `idx_heartbeat_module`/`idx_heartbeat_received`). Fine for an admin
  diagnostic; not intended for high-frequency polling.
- **No alerting** on a newly opened gap — that stays `silence_watcher`'s job. This is a
  query for after-the-fact diagnosis, the server-side complement to the device-reported
  streak.
- **Verified at every layer, including end-to-end.** The `/heartbeat` ingestion API
  stamps `received_at = now()`, so a >90 min gap can only be created by backdated rows
  written directly (the sole writer, ADR-001). The `SEED_DATA` block in
  `duckdb-service/db/schema.py` does exactly that for module `000000000005`, which lets
  `tests/ui/tests/module-heartbeat-gaps.spec.ts` (Playwright, per ADR-014) assert the
  card renders against the real backend — on top of the duckdb-service unit tests (seeded
  rows + asserted bounds), the backend proxy test (snake→camel mapping + malformed-shape
  guard), and the homepage component test.

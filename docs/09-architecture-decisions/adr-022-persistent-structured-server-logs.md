# ADR-022: Server logs become structured, disk-persisted, and SSE-streamed

## Status

Accepted ([#178](https://github.com/schutera/highfive/issues/178)). Supersedes the
in-memory-only and raw-`string[]` consequences of
[ADR-021](adr-021-admin-server-log-ring.md); builds directly on its per-service ring +
backend-proxy topology and its admin gate (which are unchanged). Delivered in phases:
structured entries + access logging + disk persistence (this ADR's core), then SSE live
tail. Auth model: [ADR-019](adr-019-admin-session-no-bundle-secret.md) /
[ADR-003](adr-003-shared-api-key-for-admin.md).

## Context

ADR-021 shipped the admin **Server Logs** panel and a per-service ring, but the data
source was nearly empty: the services barely wrote to stdout (boot banners + error-branch
`console.error`/`print`), the ring was **in-memory only** (reset on every restart), and
each line was an unstructured `string`. The panel worked; it just had ~2 lines to show,
none of which survived a deploy. Operators wanted a genuine live console: structured,
timestamped, filterable lines; per-request access logs (so traffic is visible on success
too); history that survives a restart; and a live "tail -f" without manual refresh.

Three forces shaped the decision:

- **Structure must be pinned once.** Per CLAUDE.md / ADR-004 the wire type crosses the
  backend ↔ homepage boundary, so it must live in `@highfive/contracts`, not be re-declared
  per service.
- **Persistence raises the credential stakes.** A secret printed to stdout no longer just
  flashes past in `docker logs`; it lands in the ring **and on disk for up to 30 days**.
  The "never print secrets" rule becomes load-bearing rather than advisory.
- **Retention must be bounded two ways.** Disk is finite and access logs accumulate, so
  the store is capped by **both** age (30 days) and total size (100 MB) — whichever bites
  first prunes oldest.

## Decision

Replace the raw line ring with a ring of structured **`LogEntry { ts, level, msg }`**
(`ts` ISO 8601, `level` ∈ `info|warn|error`), defined once in
[`contracts/src/index.ts`](../../contracts/src/index.ts) and used by every consumer.
`ServerLogsResponse` carries `entries: LogEntry[]` (was `lines: string[]`).

Each service feeds its ring through **two no-double-capture paths**: the existing
stdout/stderr tee (stray `print`/`console.*` → `info`/`error` entries) and a **structured
logger** (`backend/src/log.ts` `log.*`; Flask `log_ring.log_event`) that pushes an entry
directly and writes a human line to the *saved original* stream so the tee can't re-capture
it. A per-request **access-log** middleware (Express `accessLog`; Flask
`@app.after_request`) emits one `method path status ms` entry per request, level by status
(`≥500` error, `≥400` warn, else info) — logged **path-only**, never headers, body, or
query string, so no credential can reach the ring.

**Persistence** is gated on a `LOG_DIR` env var (set in compose; unset = in-memory only, as
ADR-021). When set, each entry is also appended as one JSON object per line (**JSONL**) to a
rotating file, and at startup the ring is **backfilled** from the file's tail so the panel
shows pre-restart history immediately. Rotation keeps **≤30 daily files AND ≤100 MB total**
(prune oldest past either bound). The backend uses the `rotating-file-stream` npm package
(both bounds native via `maxFiles` + `maxSize`); the Flask services use stdlib
`TimedRotatingFileHandler` subclassed with a 100 MB size-prune sweep after each rollover.
The backend writes to its own `backend_logs` volume; the two Flask services write to
**distinct subdirs** of the shared `duckdb_data` volume (`/data/logs/duckdb`,
`/data/logs/image`) so they never collide on one file.

Live tail is **SSE** (`GET /api/admin/logs/stream`, `requireAdmin`): the backend streams its
own ring's emitter and pipes the Flask services' internal `/logs/stream`; the REST
`GET /api/admin/logs` stays for the initial backfill. (SSE lands in the streaming phase of
#178; the contract and ring emitter are designed for it here.)

## Consequences

### Positive

- The panel is a real operations console: structured, color-coded, timestamped lines that
  fill with live traffic and **survive restarts** (history from disk).
- One wire type in `contracts/` — drift is a compile error (ADR-004), and the backend proxy
  rejects a drifted Flask envelope (`502`) rather than leaking `undefined` to the UI.
- Retention is bounded on both axes, so the store can't grow without limit.
- `LOG_DIR`-gating keeps unit tests and any "in-memory is fine" deployment on the old path
  with zero file I/O.

### Negative

- **Secrets-on-disk risk is real now.** Anything printed to stdout persists up to 30 days.
  Mitigations: access logs are path-only; the dev admin-key banner is written via the
  ring-bypassing `writeStdout` (terminal only, not the ring/disk) and is suppressed in prod
  by `auth.ts`'s boot guards; the endpoint stays admin-only. See
  [auth.md](../08-crosscutting-concepts/auth.md).
- **Access logs are closer to an audit log** than ADR-021's "recent tail" — 30 days of
  request paths. Paths must carry no personal data (they don't today: MACs and module ids,
  no PII). Tracked in [chapter 11](../11-risks-and-technical-debt/README.md).
- **The SSE emitter is per-process.** A future multi-worker backend (gunicorn/PM2 cluster)
  would stream only the serving worker's live entries; history via the shared disk file is
  still complete. Revisit if/when workers multiply.
- New runtime dependency (`rotating-file-stream`) on the Node side.

### Forbidden

- **Never `console.log` / `print` a secret** (API key, admin password, session token, auth
  header). It now lands on disk, not just in a transient stream. Use `writeStdout`/the
  original stream for terminal-only dev hints that must stay out of the ring.
- **Never log request bodies, headers, or query strings** in the access path — `method`,
  `path`, `status`, `duration` only.
- **Never re-declare `LogEntry` / `ServerLogsResponse` as a service-local interface** — the
  type lives only in `@highfive/contracts`.

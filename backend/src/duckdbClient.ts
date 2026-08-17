// `DUCKDB_SERVICE_URL` is the in-compose address (http://duckdb-service:8000).
// The default below is the docker host-port mapping (8002:8000) for a backend
// running on the host against a composed duckdb-service. A bare-metal/pm2
// deploy (duckdb-service on :8000 directly) MUST set the env var explicitly —
// see the ecosystem.config.js template in
// docs/07-deployment-view/production-runbook.md.
export const DEFAULT_DUCKDB_URL = 'http://127.0.0.1:8002';

/** The wire shape of duckdb-service's `GET /health` (routes/health.py). */
export type DuckdbHealthResult = { ok: boolean; db?: string };

/**
 * Why we fell back to the default, or `ok` if we didn't.
 *
 * Kept as a discriminated reason rather than a boolean because the startup
 * warning has to be able to say *which* mistake the operator made. Telling
 * someone their variable is "unset" when they can plainly see it set — the
 * shape a single boolean forces — is precisely the misleading-boot-warning
 * problem this whole change exists to remove.
 */
export type DuckdbUrlReason = 'ok' | 'unset' | 'malformed';

/**
 * Resolve the duckdb-service base URL from the env-string and report whether
 * the caller should warn.
 *
 * Pure function — caller owns the side effect (log.warn), mirroring port.ts's
 * `resolvePort` so the resolution logic stays unit-testable without env
 * juggling or module-cache resets.
 *
 * Rejects three shapes, all of which used to sail through and then die with an
 * opaque `Invalid URL` at *every* hop instead of once, loudly, at boot:
 *
 *   - unset            → the ordinary "operator didn't configure it" case
 *   - blank / spaces   → `DUCKDB_SERVICE_URL=` in a compose env_file became
 *                        the literal fetch base under the previous `??`
 *   - not an http(s) URL → `duckdb-service:8000` (scheme omitted) PARSES, as a
 *                        URL with protocol `duckdb-service:`, so a bare
 *                        `new URL()` check is not enough
 *
 * This mirrors `resolvePort` rejecting `3002junk`: a docstring that promises
 * warn-on-misconfiguration has to actually validate, or "bind the prefix and
 * stay quiet" creeps back in.
 */
export function resolveDuckdbUrl(envValue: string | undefined): {
  url: string;
  reason: DuckdbUrlReason;
} {
  const trimmed = envValue?.trim();
  if (!trimmed) return { url: DEFAULT_DUCKDB_URL, reason: 'unset' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: DEFAULT_DUCKDB_URL, reason: 'malformed' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: DEFAULT_DUCKDB_URL, reason: 'malformed' };
  }
  // Strip trailing slashes: every call site builds `${DUCKDB_URL}/path`, so a
  // trailing slash yields `//health`, `//modules`, … Werkzeug and nginx both
  // merge duplicate slashes, so this survives — at the cost of a 308 per
  // request and every logged upstream URL looking broken.
  return { url: trimmed.replace(/\/+$/, ''), reason: 'ok' };
}

const resolved = resolveDuckdbUrl(process.env.DUCKDB_SERVICE_URL);

export const DUCKDB_URL = resolved.url;

/** Why DUCKDB_SERVICE_URL was rejected, or `ok`. Drives the startup warning. */
export const duckdbUrlReason = resolved.reason;

/**
 * `timeoutMs` is required, not defaulted: callers have genuinely different
 * budgets (the boot probe wants ~2 s so it can retry, a request path wants
 * more), and a default here would just be a number nobody chose.
 *
 * NOTE for anyone extending this file: most `DUCKDB_URL` hops in app.ts and
 * *all four* in database.ts's `fetchJsonOk` are still unbounded `fetch()`
 * calls — only 3 of the 17 `fetch` calls in app.ts carry an
 * `AbortSignal.timeout`. Node's fetch has NO default timeout, so those hops
 * hang forever against an accepting-but-silent upstream. Tracked in
 * https://github.com/schutera/highfive/issues/223 — do not read this
 * function's signal as evidence the proxy chain is covered.
 */
export async function duckdbHealth(timeoutMs: number): Promise<DuckdbHealthResult> {
  // Without the abort signal, a duckdb host that accepts the TCP connection
  // but never answers (hung, not refused) blocks this await forever — and with
  // it every caller, including the boot probe's retry loop, which is how the
  // backend ends up never binding its port at all.
  const res = await fetch(`${DUCKDB_URL}/health`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DuckDB health failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as DuckdbHealthResult;
  // A 200 carrying `{"ok": false}` is duckdb-service saying "I'm listening but
  // not serving" (e.g. the DB file failed to open). Reporting that as
  // "reachable" is exactly the false-green this probe exists to remove.
  // duckdb-service's routes/health.py hardcodes ok=True today, so this is a
  // guard against a future regression, not a live case.
  if (!body?.ok) throw new Error(`DuckDB health reported not-ok: ${JSON.stringify(body)}`);
  return body;
}

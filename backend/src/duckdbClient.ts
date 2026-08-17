// `DUCKDB_SERVICE_URL` is the in-compose address (http://duckdb-service:8000).
// The default below is the docker host-port mapping (8002:8000) for a backend
// running on the host against a composed duckdb-service. A bare-metal/pm2
// deploy (duckdb-service on :8000 directly) MUST set the env var explicitly —
// see ecosystem.config.js.
export const DEFAULT_DUCKDB_URL = 'http://127.0.0.1:8002';

/**
 * Resolve the duckdb-service base URL from the env-string and signal whether
 * the caller should warn that we fell back to the default.
 *
 * Pure function — caller owns the side effect (log.warn), mirroring port.ts's
 * `resolvePort` so the resolution logic stays unit-testable without env
 * juggling or module-cache resets.
 *
 * `||`-style fallback (not `??`) is deliberate: a blank `DUCKDB_SERVICE_URL=`
 * in a compose `env_file` used to become the literal fetch base, so every hop
 * failed with an opaque URL-parse error. Blank is a misconfiguration, not an
 * intent to override — it takes the default *and* the warning.
 */
export function resolveDuckdbUrl(envValue: string | undefined): {
  url: string;
  fromDefault: boolean;
} {
  const trimmed = envValue?.trim();
  return trimmed
    ? { url: trimmed, fromDefault: false }
    : { url: DEFAULT_DUCKDB_URL, fromDefault: true };
}

const resolved = resolveDuckdbUrl(process.env.DUCKDB_SERVICE_URL);

export const DUCKDB_URL = resolved.url;

/** True when DUCKDB_SERVICE_URL was unset/blank and we fell back to the default. */
export const duckdbUrlFromDefault = resolved.fromDefault;

/**
 * Fetch ceiling for the health probe. Matches the `AbortSignal.timeout(15000)`
 * that every other `DUCKDB_URL` hop in app.ts uses, so no fetch in the proxy
 * chain is unbounded.
 */
export const DUCKDB_HEALTH_TIMEOUT_MS = 15000;

export async function duckdbHealth(
  timeoutMs: number = DUCKDB_HEALTH_TIMEOUT_MS,
): Promise<{ ok: boolean; db?: string }> {
  // Without the abort signal, a duckdb host that accepts the TCP connection
  // but never answers (hung, not refused) blocks this await forever — and
  // with it every caller, including the boot probe's retry loop.
  const res = await fetch(`${DUCKDB_URL}/health`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DuckDB health failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { ok: boolean; db?: string };
  // A 200 carrying `{"ok": false}` is duckdb-service saying "I'm listening but
  // not serving" (e.g. the DB file failed to open). Reporting that as
  // "reachable" is exactly the false-green this probe exists to remove.
  // duckdb-service's routes/health.py hardcodes ok=True today, so this is a
  // guard against a future regression, not a live case.
  if (!body?.ok) throw new Error(`DuckDB health reported not-ok: ${JSON.stringify(body)}`);
  return body;
}

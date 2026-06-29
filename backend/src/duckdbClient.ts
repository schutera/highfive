// `DUCKDB_SERVICE_URL` is the in-compose address (http://duckdb-service:8000).
// The default below is the docker host-port mapping (8002:8000) for a backend
// running on the host against a composed duckdb-service. A bare-metal/pm2
// deploy (duckdb-service on :8000 directly) MUST set the env var explicitly —
// see ecosystem.config.js. We track the fallback so startup can warn loudly
// instead of silently pointing at the wrong port.
const envDuckdbUrl = process.env.DUCKDB_SERVICE_URL?.trim();

/** True when DUCKDB_SERVICE_URL was unset/blank and we fell back to the default. */
export const duckdbUrlFromDefault = !envDuckdbUrl;

export const DUCKDB_URL = envDuckdbUrl || "http://127.0.0.1:8002";

export async function duckdbHealth(): Promise<{ ok: boolean; db?: string }> {
  const res = await fetch(`${DUCKDB_URL}/health`);
  if (!res.ok)
    throw new Error(`DuckDB health failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<{ ok: boolean; db?: string }>;
}

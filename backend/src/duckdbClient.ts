const DUCKDB_URL =
  process.env.DUCKDB_SERVICE_URL ?? "http://duckdb-service:8000";

export async function duckdbHealth(): Promise<{ ok: boolean; db?: string }> {
  const res = await fetch(`${DUCKDB_URL}/health`);
  if (!res.ok)
    throw new Error(`DuckDB health failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<{ ok: boolean; db?: string }>;
}

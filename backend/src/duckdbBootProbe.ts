// Boot-time duckdb-service reachability probe, split out from server.ts so
// tests can import it without triggering server.ts's bootstrap() (which binds
// a socket). Same convention as port.ts's split — a helper that encodes a real
// decision lives where it can be exercised in isolation.
//
// Why the probe exists: on the PM2 host the API and duckdb-service are started
// together with no ordering, so a one-shot health check races the service
// binding its port. The resulting spurious "⚠ DuckDB service not reachable"
// then sits near the top of the admin log panel (#171) long after the service
// is fine, reading like a live outage. Dev compose has the same gap; prod
// compose does not (it gates the backend on `service_healthy`).
//
// The probe is ADVISORY. It reports a result; it never gates app.listen. See
// server.ts — putting the retry loop in front of the bind turned a cosmetic
// log problem into a real availability regression (PR #193 review).

import { setTimeout as delay } from 'node:timers/promises';

/**
 * Wall-clock budget for the whole probe. Deadline-based, NOT attempt-based:
 * in the actual failure mode the port is *refusing*, so each attempt fails in
 * ~1 ms and a "10 attempts" budget silently collapses to 9 × the retry delay.
 * 15 s comfortably covers duckdb-service's own `start_period: 10s` cold start
 * (docker-compose.yml's duckdb-service healthcheck).
 */
export const DUCKDB_BOOT_PROBE_DEADLINE_MS = 15_000;

/** Gap between attempts. Constant, not exponential — the window is short. */
export const DUCKDB_BOOT_PROBE_RETRY_DELAY_MS = 500;

/**
 * Per-attempt fetch ceiling. Deliberately shorter than a request-path timeout:
 * against a host that accepts TCP but never answers, a long ceiling would burn
 * the entire deadline on a single attempt and report nothing useful.
 */
export const DUCKDB_BOOT_PROBE_TIMEOUT_MS = 2_000;

export type DuckdbHealthResult = { ok: boolean; db?: string };

export type BootProbeOutcome =
  | { reachable: true; health: DuckdbHealthResult; attempts: number }
  | { reachable: false; error: unknown; attempts: number };

export interface BootProbeOptions {
  /** The health check to retry. Injected so tests need no network. */
  health: (timeoutMs: number) => Promise<DuckdbHealthResult>;
  /** Injected in tests to keep the deadline arithmetic deterministic. */
  now?: () => number;
  /** Injected in tests so the retry delay costs no wall-clock. */
  sleep?: (ms: number) => Promise<unknown>;
  deadlineMs?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Retry `health` until it succeeds or the wall-clock deadline passes.
 *
 * Never rejects: every failure is captured into the returned outcome, so the
 * caller can fire-and-forget without risking an unhandled rejection. Returns
 * the outcome rather than logging it — the caller owns the side effect,
 * mirroring port.ts's `resolvePort`.
 */
export async function probeDuckdbHealth({
  health,
  now = Date.now,
  // ref:false so a pending retry can never hold the process open at shutdown.
  // No SIGTERM handler exists today, but this is exactly the timer that would
  // become a silent 0.5–2.5 s drain the day someone adds `server.close()`.
  sleep = (ms: number) => delay(ms, undefined, { ref: false }),
  deadlineMs = DUCKDB_BOOT_PROBE_DEADLINE_MS,
  retryDelayMs = DUCKDB_BOOT_PROBE_RETRY_DELAY_MS,
  timeoutMs = DUCKDB_BOOT_PROBE_TIMEOUT_MS,
}: BootProbeOptions): Promise<BootProbeOutcome> {
  const deadline = now() + deadlineMs;
  let attempts = 0;
  let lastError: unknown;

  // do/while: always make at least one attempt, even with a zero deadline.
  do {
    attempts++;
    try {
      return { reachable: true, health: await health(timeoutMs), attempts };
    } catch (err) {
      lastError = err;
    }
    // Don't sleep past the deadline just to fail on the far side of it.
    if (now() + retryDelayMs >= deadline) break;
    await sleep(retryDelayMs);
  } while (now() < deadline);

  return { reachable: false, error: lastError, attempts };
}

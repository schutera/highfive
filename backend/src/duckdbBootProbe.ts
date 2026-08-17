// Boot-time duckdb-service reachability probe, split out from server.ts so
// tests can import it without triggering server.ts's bootstrap() (which binds
// a socket). Same convention as port.ts's split — a helper that encodes a real
// decision lives where it can be exercised in isolation.
//
// Why the probe exists: on the PM2 host the API and duckdb-service are started
// together with no ordering, so a one-shot health check races the service
// binding its port. The resulting spurious "⚠ DuckDB service not reachable"
// then sits in the admin log panel (#171) long after the service is fine,
// reading like a live outage. All four compose stacks in this repo instead
// gate the backend declaratively on `service_healthy`, so this retry earns its
// keep only on the (non-recommended) bare-metal path.
//
// The probe is ADVISORY. It reports a result; it never gates app.listen. See
// server.ts — putting the retry loop in front of the bind turned a cosmetic
// log problem into a real availability regression (PR #193 review).

import { setTimeout as delay } from 'node:timers/promises';
import type { DuckdbHealthResult } from './duckdbClient';

/**
 * Wall-clock budget for the whole probe, and a deliberate trade-off between
 * two measured failure shapes:
 *
 *   - **Refused port** (the race this exists for): each attempt fails fast —
 *     ~6 ms on loopback, ~70 ms across the docker bridge to a live container.
 *     Nearly the whole budget is the retry delay, so 15 s buys ~30 attempts
 *     (measured: 30 attempts / 14806 ms against a refused loopback port).
 *   - **Stopped / hung service**: each attempt burns its full `timeoutMs`, so
 *     15 s buys ~6 attempts.
 *
 * The budget is a deadline rather than an attempt count *because* those two
 * costs differ by ~300×: "10 attempts" means 4.5 s in the first shape and 25 s
 * in the second, i.e. the number you write is not the budget you get.
 *
 * Note this is SHORTER than the old 10-attempt loop in the stopped-service
 * shape (15 s vs ~25 s). That is intended: the probe's job is to out-wait a
 * startup race measured in *seconds* on the PM2 host, not to wait out a
 * genuinely down service — nothing useful happens in the extra 10 s, and the
 * boot verdict lands sooner.
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

export type BootProbeOutcome =
  | { reachable: true; health: DuckdbHealthResult; attempts: number; elapsedMs: number }
  | { reachable: false; error: unknown; attempts: number; elapsedMs: number };

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
 *
 * `deadlineMs` is a true ceiling: the last attempt's timeout is clamped to the
 * remaining budget, so the probe cannot start an attempt at `deadline - ε` and
 * then run a further `timeoutMs` past it.
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
  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  let attempts = 0;
  let lastError: unknown;

  // do/while: always make at least one attempt, even with a zero deadline —
  // reporting "unreachable" without ever asking would be a lie.
  do {
    attempts++;
    // Clamp so the final attempt cannot overshoot the stated deadline. Floor
    // at 1ms: AbortSignal.timeout(0) fires immediately, which would turn the
    // last attempt into a guaranteed synthetic failure.
    const remaining = deadline - now();
    const attemptTimeout = attempts === 1 ? timeoutMs : Math.max(1, Math.min(timeoutMs, remaining));
    try {
      const health_ = await health(attemptTimeout);
      return { reachable: true, health: health_, attempts, elapsedMs: now() - startedAt };
    } catch (err) {
      lastError = err;
    }
    // Don't sleep past the deadline just to fail on the far side of it. With
    // retryDelayMs=0 this still terminates: the loop guard below re-checks the
    // clock, and each attempt costs at least its own fetch.
    if (now() + retryDelayMs >= deadline) break;
    await sleep(retryDelayMs);
  } while (now() < deadline);

  return { reachable: false, error: lastError, attempts, elapsedMs: now() - startedAt };
}

/**
 * How long after a failed boot probe to look once more.
 *
 * Without this, a backend that boots while duckdb is down leaves a scary WARN
 * near the top of the admin Server Logs panel that is never superseded — the
 * ring evicts it only after 2000 newer entries, not on recovery. One late
 * re-check turns "permanently misleading" into "corrected within a minute",
 * which is the difference between mitigating #171's symptom and fixing it.
 */
export const DUCKDB_RECOVERY_RECHECK_MS = 60_000;

/**
 * Wait, then probe exactly once. Returns the health payload if duckdb has come
 * back, or `null` if it is still unreachable. Never rejects.
 *
 * Deliberately a single late check rather than a background poller: this is a
 * boot diagnostic, not a monitoring system. Runtime request failures are
 * surfaced by the request paths themselves.
 */
export async function recheckDuckdbHealth({
  health,
  sleep = (ms: number) => delay(ms, undefined, { ref: false }),
  delayMs = DUCKDB_RECOVERY_RECHECK_MS,
  timeoutMs = DUCKDB_BOOT_PROBE_TIMEOUT_MS,
}: {
  health: (timeoutMs: number) => Promise<DuckdbHealthResult>;
  sleep?: (ms: number) => Promise<unknown>;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<DuckdbHealthResult | null> {
  await sleep(delayMs);
  try {
    return await health(timeoutMs);
  } catch {
    return null;
  }
}

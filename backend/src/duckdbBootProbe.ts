// Boot-time duckdb-service reachability probe, split out from server.ts so
// tests can import it without triggering server.ts's bootstrap() (which binds
// a socket). Same convention as port.ts's split — a helper that encodes a real
// decision lives where it can be exercised in isolation. That includes the
// *reporting* (`reportDuckdbHealth` below), not just the retry maths: the
// operator-facing strings are where the last two bugs in this file lived.
//
// Why the probe exists: an off-compose host (the PM2 runbook) has no
// orchestrator to gate on, so start ordering is whatever the operator
// arranged — and a one-shot health check can easily race duckdb-service
// binding its port. The resulting spurious "⚠ DuckDB service not reachable"
// then sits in the admin log panel (#171) long after the service is fine,
// reading like a live outage. (#193's author observed the two processes
// starting ~1s apart on the production PM2 box.) All four compose stacks in
// this repo instead gate the backend declaratively on `service_healthy`, so
// this retry earns its keep only on that non-recommended bare-metal path.
//
// The probe is ADVISORY. It reports a result; it never gates app.listen. See
// server.ts — putting the retry loop in front of the bind turned a cosmetic
// log problem into a real availability regression (PR #193 review).

import { setTimeout as delay } from 'node:timers/promises';
import { describeError, redactCredentials, type DuckdbHealthResult } from './duckdbClient';

/**
 * Wall-clock budget for the whole probe, and a deliberate trade-off between
 * two measured failure shapes:
 *
 *   - **Refused port** (the race this exists for): each attempt fails fast —
 *     ~6 ms on loopback, ~70 ms across the docker bridge to a live container.
 *     Nearly the whole budget is the retry delay, so 15 s buys ~29 attempts
 *     (measured: 29 attempts / 14794 ms against a refused loopback port).
 *   - **Stopped / hung service**: each attempt burns its full `timeoutMs`, so
 *     15 s buys ~6 attempts.
 *
 * The budget is a deadline rather than an attempt count *because* those two
 * costs differ by ~300×: "10 attempts" means 4.5 s in the first shape and 25 s
 * in the second, i.e. the number you write is not the budget you get.
 *
 * Note this is SHORTER than the old 10-attempt loop in the stopped-service
 * shape (15 s vs ~25 s). That is intended: the probe's job is to out-wait a
 * startup race measured in *seconds*, not to wait out a genuinely down
 * service — nothing useful happens in the extra 10 s.
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

/**
 * Smallest budget worth starting an attempt with.
 *
 * Without this floor, the deadline clamp happily granted a final attempt
 * whatever scrap of time remained — measured as low as **1 ms**, which
 * guarantees an abort. That synthetic `TimeoutError` then became `lastError`
 * and so the operator-facing message, overwriting the real `ECONNREFUSED`:
 * a boot line saying "aborted due to timeout" about a refused port, which is
 * the exact misdiagnosis this whole change exists to delete. The odds are
 * roughly `cost / (cost + retryDelay)` — ~1% on loopback (6/506) but ~12%
 * across the docker bridge (70/570) — so it is routine, not a corner case.
 *
 * 250 ms, not 50: the floor only helps if it exceeds a *successful-failure*
 * attempt's cost, and a 50 ms floor still leaves the window
 * `remaining ∈ [50, 70)` where a ~70 ms bridge attempt aborts early. 250 ms
 * clears both measured costs with room to spare, and costs nothing — the
 * retry-delay guard already stops the loop below ~500 ms remaining.
 */
export const DUCKDB_BOOT_PROBE_MIN_ATTEMPT_MS = 250;

/**
 * Structural backstop against a non-terminating loop. Unreachable at the
 * shipped constants (the deadline stops things ~29 attempts in); it exists so
 * that a future zero-cost `health` + `retryDelayMs: 0` combination cannot spin
 * forever.
 */
export const DUCKDB_BOOT_PROBE_MAX_ATTEMPTS = 1_000;

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
  minAttemptMs?: number;
}

/**
 * Retry `health` until it succeeds or the wall-clock deadline passes.
 *
 * Never rejects: every failure is captured into the returned outcome, so the
 * caller can fire-and-forget without risking an unhandled rejection. Returns
 * the outcome rather than logging it — the caller owns the side effect,
 * mirroring port.ts's `resolvePort`.
 *
 * `deadlineMs` is a true ceiling for every attempt **after the first**: later
 * attempts are clamped to the remaining budget, and one that cannot be given
 * at least `minAttemptMs` is not started at all. The *first* attempt is
 * deliberately exempt and always gets the full `timeoutMs` — reporting
 * "unreachable" without ever asking would be a lie — so with the pathological
 * config `deadlineMs < timeoutMs` the probe can outlast its stated deadline by
 * design. Not reachable at the shipped constants (15000 > 2000).
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
  minAttemptMs = DUCKDB_BOOT_PROBE_MIN_ATTEMPT_MS,
}: BootProbeOptions): Promise<BootProbeOutcome> {
  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  let attempts = 0;
  let lastError: unknown;

  for (;;) {
    const remaining = deadline - now();
    // Always make one attempt, even with a spent deadline. Later attempts need
    // a budget worth having — see DUCKDB_BOOT_PROBE_MIN_ATTEMPT_MS.
    if (attempts > 0 && remaining < minAttemptMs) break;
    if (attempts >= DUCKDB_BOOT_PROBE_MAX_ATTEMPTS) break;

    attempts++;
    const attemptTimeout = attempts === 1 ? timeoutMs : Math.min(timeoutMs, remaining);
    try {
      const result = await health(attemptTimeout);
      return { reachable: true, health: result, attempts, elapsedMs: now() - startedAt };
    } catch (err) {
      lastError = err;
    }

    // Don't sleep past the deadline just to fail on the far side of it.
    if (now() + retryDelayMs >= deadline) break;
    await sleep(retryDelayMs);
  }

  return { reachable: false, error: lastError, attempts, elapsedMs: now() - startedAt };
}

/**
 * How long AFTER BOOT (not after the probe gives up) to look once more.
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
  if (delayMs > 0) await sleep(delayMs);
  try {
    return await health(timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Run the boot probe and emit the operator-facing verdict, following up with a
 * recovery re-check if it failed.
 *
 * Lives here rather than in server.ts so the four strings it can emit are
 * testable — server.ts calls `bootstrap()` at module scope and so cannot be
 * imported by a test. The previous revision left this glue in server.ts, and
 * that is exactly where the "60s after boot" timing bug survived review.
 *
 * Never rejects; the caller fires and forgets after `app.listen`.
 */
export async function reportDuckdbHealth({
  health,
  log,
  duckdbUrl,
  recoveryDelayMs = DUCKDB_RECOVERY_RECHECK_MS,
  probeOptions,
  recheckSleep,
}: {
  health: (timeoutMs: number) => Promise<DuckdbHealthResult>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /**
   * Safe to log by construction: `resolveDuckdbUrl` rejects URLs carrying
   * userinfo, so `DUCKDB_URL` cannot hold a credential.
   */
  duckdbUrl: string;
  recoveryDelayMs?: number;
  /**
   * `health` is deliberately excluded: it is supplied once above and used for
   * BOTH the probe and the recovery re-check. Allowing it here would let a
   * caller silently probe one endpoint and re-check another — and `Partial`
   * would additionally permit `health: undefined`, turning every attempt into
   * a caught TypeError reported to the operator as the cause of the outage.
   */
  probeOptions?: Omit<BootProbeOptions, 'health'>;
  recheckSleep?: (ms: number) => Promise<unknown>;
}): Promise<void> {
  const outcome = await probeDuckdbHealth({ ...probeOptions, health });
  if (outcome.reachable) {
    log.info(`🗄 DuckDB service reachable: ${JSON.stringify(outcome.health)}`);
    return;
  }

  // Elapsed, not just attempts: attempt count is the unit this probe
  // deliberately stopped budgeting in, since one attempt costs ~6 ms against a
  // refused port and a full 2 s against a hung one.
  // The error text is redacted too, not just the URL: undici embeds the full
  // request URL in its own message ("Request cannot be constructed from a URL
  // that includes credentials: http://user:pass@host/health"), so passing a
  // pre-redacted `duckdbUrl` alone still leaks the password one field over.
  log.warn(
    `⚠ DuckDB service not reachable after ${outcome.attempts} attempts / ` +
      `${outcome.elapsedMs}ms (${duckdbUrl}): ${redactCredentials(describeError(outcome.error))}`,
  );

  // Subtract what the probe already spent so the follow-up really lands
  // `recoveryDelayMs` after BOOT, matching what the log line claims. The probe
  // burns up to 15 s of that window, so sleeping the full amount here would
  // put a line saying "60s after boot" at t≈75 s.
  const remainingDelay = Math.max(0, recoveryDelayMs - outcome.elapsedMs);
  // Derive the reported figure from the wait actually performed, never from
  // the nominal constant. If recoveryDelayMs ever drops below the probe's
  // elapsed time, remainingDelay clamps to 0 — and a `seconds` computed from
  // the constant would go straight back to misstating its own timing, which is
  // the bug this function was extracted to pin.
  const seconds = Math.round((outcome.elapsedMs + remainingDelay) / 1000);
  let recheckError: unknown;
  const recovered = await recheckDuckdbHealth({
    // Capture the late error too: duckdb may be down for a *different* reason
    // at t=60s than at boot (refused → DNS → TLS), and a follow-up that says
    // only "still unreachable" hides that.
    health: async (timeoutMs) => {
      try {
        return await health(timeoutMs);
      } catch (err) {
        recheckError = err;
        throw err;
      }
    },
    delayMs: remainingDelay,
    // Keep the re-check's per-attempt ceiling consistent with the probe's when
    // a caller overrode it; otherwise recheckDuckdbHealth's own default wins.
    ...(probeOptions?.timeoutMs !== undefined ? { timeoutMs: probeOptions.timeoutMs } : {}),
    ...(recheckSleep ? { sleep: recheckSleep } : {}),
  });

  // "re-checked Ns after boot" describes when the check was MADE. It answers a
  // moment later (bounded by one attempt's ceiling), so the wording is
  // deliberately about the check, not the log timestamp.
  if (recovered) {
    log.info(
      `🗄 DuckDB service recovered — re-checked ${seconds}s after boot: ` +
        `${JSON.stringify(recovered)}. The warning above is stale.`,
    );
  } else {
    log.warn(
      `⚠ DuckDB service still unreachable when re-checked ${seconds}s after boot ` +
        `(${duckdbUrl}): ${redactCredentials(describeError(recheckError))}. ` +
        `No further boot checks — request paths surface live errors.`,
    );
  }
}

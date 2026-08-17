import { describe, it, expect, vi } from 'vitest';
import {
  DUCKDB_BOOT_PROBE_DEADLINE_MS,
  DUCKDB_BOOT_PROBE_RETRY_DELAY_MS,
  DUCKDB_BOOT_PROBE_TIMEOUT_MS,
  DUCKDB_RECOVERY_RECHECK_MS,
  probeDuckdbHealth,
  recheckDuckdbHealth,
} from '../src/duckdbBootProbe';

// The boot probe is the part of PR #193 that actually carries risk: it decides
// whether the operator sees "reachable" or a scary warning, and an earlier
// revision of it blocked app.listen (every route connection-refused while the
// loop ran) and could hang forever on an accepting-but-silent upstream.
//
// `now` and `sleep` are injected so the deadline arithmetic is deterministic
// and the suite costs no wall-clock.
//
// CRITICAL: the fake clock must be advanced by the *health check* too, not
// only by `sleep`. An earlier version of this suite advanced time only in
// sleep, which made every attempt free and so could only ever simulate
// instant-failure. That is the one shape the per-attempt `AbortSignal.timeout`
// was NOT added for — a regression deleting the timeout would have passed.
// `failingAfter(ms)` below is what closes that gap.

/** Fake clock. Advanced explicitly by sleeps and by attempt costs. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    advance: (ms: number) => {
      t += ms;
    },
    get elapsed() {
      return t - start;
    },
  };
}

/**
 * A health check that burns `costMs` of fake time, then fails — but never more
 * than the timeout it was granted, because a real `AbortSignal.timeout` fetch
 * cannot outlive its own ceiling. Honouring that is what makes the deadline
 * assertions meaningful rather than off-by-one-attempt.
 */
function failingAfter(
  clock: ReturnType<typeof fakeClock>,
  costMs: number,
  message = 'ECONNREFUSED',
) {
  return vi.fn(async (timeoutMs: number) => {
    clock.advance(Math.min(costMs, timeoutMs));
    throw new Error(message);
  });
}

describe('probeDuckdbHealth', () => {
  it('returns reachable on the first attempt when duckdb answers', async () => {
    const clock = fakeClock();
    const health = vi.fn().mockResolvedValue({ ok: true, db: '/data/hive.duckdb' });

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome).toMatchObject({
      reachable: true,
      health: { ok: true, db: '/data/hive.duckdb' },
      attempts: 1,
    });
    expect(health).toHaveBeenCalledTimes(1);
    // The happy path must not sleep at all — a normal boot cannot pay a
    // retry delay for a service that was up the whole time.
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('retries and succeeds once duckdb finishes binding its port', async () => {
    // The exact race the probe exists for: ECONNREFUSED, then ECONNREFUSED,
    // then the service is up.
    const clock = fakeClock();
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ ok: true, db: '/data/hive.duckdb' });

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome.reachable).toBe(true);
    expect(outcome.attempts).toBe(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledWith(DUCKDB_BOOT_PROBE_RETRY_DELAY_MS);
  });

  it('reports the LAST error when it gives up, not the first', async () => {
    const clock = fakeClock();
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValue(new Error('final failure'));

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome.reachable).toBe(false);
    if (outcome.reachable) throw new Error('unreachable');
    // Reporting the first error would tell the operator about a transient
    // that may long since have changed shape.
    expect(String(outcome.error)).toContain('final failure');
  });

  // ----- the two measured failure shapes -----
  //
  // These are the reason the budget is a wall-clock deadline and not an
  // attempt count: the same "10 attempts" means 4.5s in one shape and 25s in
  // the other. Both are pinned so a future edit can't silently pick one.

  it('shape 1 — refused port (~6ms/attempt): spends the deadline on ~26 attempts', async () => {
    const clock = fakeClock();
    // ~6ms measured on loopback; ~70ms across the docker bridge.
    const health = failingAfter(clock, 6);

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome.reachable).toBe(false);
    // Nearly all the budget is retry delay, so attempts ~= deadline/delay.
    expect(outcome.attempts).toBeGreaterThan(20);
    expect(outcome.elapsedMs).toBeLessThanOrEqual(DUCKDB_BOOT_PROBE_DEADLINE_MS);
    // The old attempt-capped loop stopped at 10 here, i.e. after ~4.5s —
    // under half duckdb-service's own 10s healthcheck start_period.
    expect(outcome.attempts).toBeGreaterThan(10);
  });

  it('shape 2 — hung upstream (full timeout/attempt): ~6 attempts, still inside the deadline', async () => {
    const clock = fakeClock();
    // Every attempt burns its whole ceiling, as measured against a
    // net.createServer(() => {}) blackhole and a stopped compose service.
    const health = failingAfter(clock, DUCKDB_BOOT_PROBE_TIMEOUT_MS, 'TimeoutError');

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome.reachable).toBe(false);
    // 2000ms + 500ms per cycle => ~6 attempts in 15s. Pins the shape the
    // per-attempt AbortSignal.timeout exists for: without it, attempt 1 never
    // returns and this is an infinite hang.
    expect(outcome.attempts).toBe(6);
    expect(outcome.elapsedMs).toBeLessThanOrEqual(DUCKDB_BOOT_PROBE_DEADLINE_MS);
  });

  it('treats the deadline as a true ceiling, clamping the final attempt', async () => {
    // Regression guard: with the break-check before the sleep, an unclamped
    // final attempt could start just under the deadline and then run a full
    // timeoutMs past it (~17s against a stated 15s budget).
    const clock = fakeClock();
    const seen: number[] = [];
    const health = vi.fn(async (timeoutMs: number) => {
      seen.push(timeoutMs);
      clock.advance(timeoutMs);
      throw new Error('TimeoutError');
    });

    const outcome = await probeDuckdbHealth({
      health,
      now: clock.now,
      sleep: clock.sleep,
      deadlineMs: 5_000,
      timeoutMs: 2_000,
      retryDelayMs: 500,
    });

    expect(outcome.elapsedMs).toBeLessThanOrEqual(5_000);
    // No attempt may be granted more than the budget still remaining.
    expect(Math.max(...seen)).toBeLessThanOrEqual(2_000);
  });

  it('makes exactly one attempt when the deadline is already spent', async () => {
    const clock = fakeClock();
    const health = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const outcome = await probeDuckdbHealth({
      health,
      now: clock.now,
      sleep: clock.sleep,
      deadlineMs: 0,
    });

    // A zero budget must still probe once — reporting "unreachable" without
    // ever asking would be a lie.
    expect(outcome.attempts).toBe(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('terminates rather than hot-spinning when the retry delay is zero', async () => {
    // retryDelayMs:0 is a plausible-looking override; it must not turn the
    // loop into a busy wait that never ends.
    const clock = fakeClock();
    const health = failingAfter(clock, 6);

    const outcome = await probeDuckdbHealth({
      health,
      now: clock.now,
      sleep: clock.sleep,
      retryDelayMs: 0,
      deadlineMs: 1_000,
    });

    expect(outcome.reachable).toBe(false);
    expect(outcome.elapsedMs).toBeLessThanOrEqual(1_000);
  });

  it('passes the short boot timeout down to the health check', async () => {
    const clock = fakeClock();
    const health = vi.fn().mockResolvedValue({ ok: true });

    await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(health).toHaveBeenCalledWith(DUCKDB_BOOT_PROBE_TIMEOUT_MS);
    expect(DUCKDB_BOOT_PROBE_TIMEOUT_MS).toBeLessThan(DUCKDB_BOOT_PROBE_DEADLINE_MS);
  });

  it('never rejects, so the caller can fire-and-forget safely', async () => {
    // server.ts does not await this before app.listen. A rejection escaping
    // here would be an unhandled rejection on every boot with duckdb down.
    const clock = fakeClock();
    const health = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep, deadlineMs: 0 }),
    ).resolves.toMatchObject({ reachable: false });
  });

  it('treats a non-Error rejection as a failure without crashing', async () => {
    const clock = fakeClock();
    const health = vi.fn().mockRejectedValue('a bare string');

    const outcome = await probeDuckdbHealth({
      health,
      now: clock.now,
      sleep: clock.sleep,
      deadlineMs: 0,
    });

    expect(outcome).toMatchObject({ reachable: false, error: 'a bare string' });
  });
});

describe('recheckDuckdbHealth', () => {
  it('reports recovery when duckdb came up after the boot probe gave up', async () => {
    // Without this, the boot WARN stands uncorrected in the admin panel until
    // 2000 newer entries evict it — the ring does not clear it on recovery.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const health = vi.fn().mockResolvedValue({ ok: true, db: '/data/hive.duckdb' });

    await expect(recheckDuckdbHealth({ health, sleep })).resolves.toEqual({
      ok: true,
      db: '/data/hive.duckdb',
    });
    expect(sleep).toHaveBeenCalledWith(DUCKDB_RECOVERY_RECHECK_MS);
  });

  it('returns null when duckdb is still down, without throwing', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const health = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(recheckDuckdbHealth({ health, sleep })).resolves.toBeNull();
  });

  it('checks exactly once — it is a boot diagnostic, not a poller', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const health = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await recheckDuckdbHealth({ health, sleep });

    expect(health).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

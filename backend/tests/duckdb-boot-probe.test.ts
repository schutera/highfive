import { describe, it, expect, vi } from 'vitest';
import {
  DUCKDB_BOOT_PROBE_DEADLINE_MS,
  DUCKDB_BOOT_PROBE_MIN_ATTEMPT_MS,
  DUCKDB_BOOT_PROBE_RETRY_DELAY_MS,
  DUCKDB_BOOT_PROBE_TIMEOUT_MS,
  DUCKDB_RECOVERY_RECHECK_MS,
  probeDuckdbHealth,
  recheckDuckdbHealth,
  reportDuckdbHealth,
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
    const health = vi.fn().mockResolvedValue({ ok: true, db: '/data/app.duckdb' });

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome).toMatchObject({
      reachable: true,
      health: { ok: true, db: '/data/app.duckdb' },
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
      .mockResolvedValue({ ok: true, db: '/data/app.duckdb' });

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

  it('shape 1 — refused port (~6ms/attempt): spends the deadline on ~30 attempts (29 on a real clock)', async () => {
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
    // timeoutMs past it.
    //
    // The parameters matter. deadlineMs must NOT be a multiple of
    // (timeoutMs + retryDelayMs), or the loop lands exactly on the deadline
    // and an unclamped build passes anyway — which is what an earlier version
    // of this test did, making it detect nothing. At 4000: unclamped runs
    // 2000+500+2000 = 4500 (fails); clamped runs 2000+500+1500 = 4000 (passes).
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
      deadlineMs: 4_000,
      timeoutMs: 2_000,
      retryDelayMs: 500,
    });

    expect(outcome.elapsedMs).toBeLessThanOrEqual(4_000);
    // The final attempt must have been granted strictly less than the full
    // ceiling — i.e. actually clamped, not merely under the nominal maximum.
    expect(seen[seen.length - 1]).toBeLessThan(2_000);
  });

  it('never starts an attempt too small to be meaningful, so the real error survives', async () => {
    // Measured pathology this closes: the clamp granted a final attempt as
    // little as 1ms, which guarantees an abort. That synthetic TimeoutError
    // became `lastError` and so the operator-facing message, overwriting the
    // real ECONNREFUSED — a boot line blaming a timeout for a refused port,
    // the exact misdiagnosis this branch exists to delete.
    const clock = fakeClock();
    const granted: number[] = [];
    const health = vi.fn(async (timeoutMs: number) => {
      granted.push(timeoutMs);
      const cost = Math.min(6, timeoutMs);
      clock.advance(cost);
      // A too-small budget aborts before the connection is even refused.
      throw new Error(cost < 6 ? 'TimeoutError(synthetic)' : 'ECONNREFUSED');
    });

    const outcome = await probeDuckdbHealth({
      health,
      now: clock.now,
      sleep: clock.sleep,
      // Chosen so the budget does NOT divide evenly by the retry delay,
      // leaving a ragged remainder — the condition that produced the 1ms
      // attempt in the measured run.
      deadlineMs: 5_061,
      retryDelayMs: 500,
    });

    expect(Math.min(...granted)).toBeGreaterThanOrEqual(DUCKDB_BOOT_PROBE_MIN_ATTEMPT_MS);
    expect(outcome.reachable).toBe(false);
    if (outcome.reachable) throw new Error('unreachable');
    // The operator must be told what actually happened.
    expect(String(outcome.error)).toContain('ECONNREFUSED');
    expect(String(outcome.error)).not.toContain('synthetic');
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
    const health = vi.fn().mockResolvedValue({ ok: true, db: '/data/app.duckdb' });

    await expect(recheckDuckdbHealth({ health, sleep })).resolves.toEqual({
      ok: true,
      db: '/data/app.duckdb',
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

describe('reportDuckdbHealth', () => {
  // These four strings are what an operator actually reads in the admin
  // Server Logs panel, and they are the reason this function was pulled out of
  // server.ts: server.ts calls bootstrap() at module scope, so nothing in it
  // can be imported by a test — which is precisely how a log line claiming
  // "60s after boot" while firing at t≈75s survived a review round.

  function fakeLog() {
    const info: string[] = [];
    const warn: string[] = [];
    return {
      info: (m: string) => info.push(m),
      warn: (m: string) => warn.push(m),
      info_: info,
      warn_: warn,
    };
  }

  const URL_ = 'http://duckdb-service:8000';

  it('logs a single reachable line and does NOT re-check when duckdb answers', async () => {
    const log = fakeLog();
    const health = vi.fn().mockResolvedValue({ ok: true, db: '/data/app.duckdb' });

    await reportDuckdbHealth({ health, log, duckdbUrl: URL_ });

    expect(log.info_).toHaveLength(1);
    expect(log.info_[0]).toContain('DuckDB service reachable');
    expect(log.warn_).toHaveLength(0);
    // A healthy boot must not schedule a 60s follow-up.
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('warns with attempts AND elapsed when the probe gives up', async () => {
    const log = fakeLog();
    const health = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await reportDuckdbHealth({
      health,
      log,
      duckdbUrl: URL_,
      probeOptions: { deadlineMs: 0 },
      recoveryDelayMs: 0,
    });

    expect(log.warn_[0]).toContain('not reachable');
    expect(log.warn_[0]).toContain('ECONNREFUSED');
    expect(log.warn_[0]).toContain(URL_);
    // Elapsed is the unit the deadline redesign switched to; attempts alone
    // is the number the same change argued was meaningless.
    expect(log.warn_[0]).toMatch(/\d+ attempts/);
    expect(log.warn_[0]).toMatch(/\d+ms/);
  });

  it('supersedes the stale warning with a recovery line when duckdb comes back', async () => {
    const log = fakeLog();
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ ok: true, db: '/data/app.duckdb' });

    await reportDuckdbHealth({
      health,
      log,
      duckdbUrl: URL_,
      probeOptions: { deadlineMs: 0 },
      recoveryDelayMs: 0,
    });

    expect(log.warn_).toHaveLength(1);
    expect(log.info_).toHaveLength(1);
    expect(log.info_[0]).toContain('recovered');
    // The operator must be told the earlier line no longer applies.
    expect(log.info_[0]).toContain('stale');
  });

  it('logs an explicitly terminal line when duckdb is still down at the re-check', async () => {
    const log = fakeLog();
    const health = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await reportDuckdbHealth({
      health,
      log,
      duckdbUrl: URL_,
      probeOptions: { deadlineMs: 0 },
      recoveryDelayMs: 0,
    });

    expect(log.warn_).toHaveLength(2);
    // "No further boot checks" matters: silence afterwards must not be
    // mistaken for "we are still watching".
    expect(log.warn_[1]).toContain('still unreachable');
    expect(log.warn_[1]).toContain('No further boot checks');
  });

  it('subtracts the probe time so the re-check lands the stated interval after BOOT', async () => {
    // The bug this pins: the probe burns up to 15s of the window, so sleeping
    // the full 60s afterwards put a line reading "60s after boot" at t≈75s —
    // a boot log line misstating its own timing, in a change whose thesis is
    // that exactly that is the bug.
    const clock = fakeClock();
    const slept: number[] = [];
    const health = failingAfter(clock, DUCKDB_BOOT_PROBE_TIMEOUT_MS, 'TimeoutError');
    const log = fakeLog();

    await reportDuckdbHealth({
      health,
      log,
      duckdbUrl: URL_,
      probeOptions: { now: clock.now, sleep: clock.sleep },
      recheckSleep: async (ms: number) => {
        slept.push(ms);
        clock.advance(ms);
      },
    });

    const probeElapsed = Number(/(\d+)ms/.exec(log.warn_[0])![1]);
    expect(probeElapsed).toBeGreaterThan(0);
    // The re-check must BEGIN exactly the advertised interval after boot —
    // probe time + follow-up sleep == 60s. Sleeping the full 60s after a 15s
    // probe would put it at 75s while the log line still said 60s.
    expect(probeElapsed + slept[0]).toBe(DUCKDB_RECOVERY_RECHECK_MS);
    // It concludes a little later, bounded by one attempt's own ceiling. The
    // log wording says "re-checked 60s after boot" (when it was made), not
    // "at 60s" (when it answered), so this slack is described, not hidden.
    expect(clock.elapsed).toBeLessThanOrEqual(
      DUCKDB_RECOVERY_RECHECK_MS + DUCKDB_BOOT_PROBE_TIMEOUT_MS,
    );
  });

  it('never rejects, even if the health check throws a non-Error', async () => {
    const log = fakeLog();
    const health = vi.fn().mockRejectedValue('a bare string');

    await expect(
      reportDuckdbHealth({
        health,
        log,
        duckdbUrl: URL_,
        probeOptions: { deadlineMs: 0 },
        recoveryDelayMs: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('reportDuckdbHealth — the operator-facing warning is the deliverable', () => {
  function collectLog() {
    const info: string[] = [];
    const warn: string[] = [];
    return {
      info: (m: string) => info.push(m),
      warn: (m: string) => warn.push(m),
      all: () => [...info, ...warn].join('\n'),
    };
  }

  it('surfaces the CAUSE of a fetch failure, not just "fetch failed"', () => {
    // The whole point of this warning is telling the operator why duckdb is
    // unreachable. Node's fetch rejects with TypeError: fetch failed and puts
    // the reason on .cause, so String(err) alone makes a refused port
    // indistinguishable from a DNS typo. Fixture is the shape undici really
    // produces, not a guessed `new Error('ECONNREFUSED')`.
    const log = collectLog();
    const health = vi.fn().mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:8002'),
      }),
    );

    return reportDuckdbHealth({
      health,
      log,
      duckdbUrl: 'http://duckdb-service:8000',
      probeOptions: { deadlineMs: 0 },
      recoveryDelayMs: 0,
    }).then(() => {
      expect(log.all()).toContain('ECONNREFUSED 127.0.0.1:8002');
    });
  });

  it('keeps a credential out of the log even when the error text embeds one', async () => {
    // Pins the WIRING, not the regex. The bug that shipped was a wiring bug:
    // the redactor existed and was simply not attached to this path. Every
    // helper test passed throughout.
    const log = collectLog();
    const health = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          'Request cannot be constructed from a URL that includes credentials: ' +
            'http://admin:hunter2@127.0.0.1:8002/health',
        ),
      );

    await reportDuckdbHealth({
      health,
      log,
      duckdbUrl: 'http://127.0.0.1:8002',
      probeOptions: { deadlineMs: 0 },
      recoveryDelayMs: 0,
    });

    expect(log.all()).not.toContain('hunter2');
    expect(log.all()).toContain('***@');
  });
});

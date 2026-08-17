import { describe, it, expect, vi } from 'vitest';
import {
  DUCKDB_BOOT_PROBE_DEADLINE_MS,
  DUCKDB_BOOT_PROBE_RETRY_DELAY_MS,
  DUCKDB_BOOT_PROBE_TIMEOUT_MS,
  probeDuckdbHealth,
} from '../src/duckdbBootProbe';

// The boot probe is the part of PR #193 that actually carries risk: it decides
// whether the operator sees "reachable" or a scary warning, and an earlier
// revision of it blocked app.listen (every route connection-refused while the
// loop ran) and could hang forever on an accepting-but-silent upstream.
//
// `now` and `sleep` are injected so the deadline arithmetic is deterministic
// and the suite costs no wall-clock: a fake clock advances only when the probe
// sleeps, which is exactly the budget being asserted.

/** Fake clock that advances only via the injected `sleep`. */
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

describe('probeDuckdbHealth', () => {
  it('returns reachable on the first attempt when duckdb answers', async () => {
    const clock = fakeClock();
    const health = vi.fn().mockResolvedValue({ ok: true, db: '/data/hive.duckdb' });

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome).toEqual({
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

  it('gives up at the deadline and reports the LAST error', async () => {
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
    // Deadline is honoured, and the probe never sleeps past it.
    expect(clock.elapsed).toBeLessThanOrEqual(DUCKDB_BOOT_PROBE_DEADLINE_MS);
  });

  it('spends its full deadline even when every attempt fails instantly', async () => {
    // The regression that a "10 attempts" budget hides: in the real failure
    // mode the port REFUSES, so each attempt costs ~0ms and an attempt-count
    // budget silently collapses to 9 x 500ms = 4.5s — less than half
    // duckdb-service's own 10s healthcheck start_period. Deadline-based
    // budgeting is what keeps the window honest.
    const clock = fakeClock();
    const health = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const outcome = await probeDuckdbHealth({ health, now: clock.now, sleep: clock.sleep });

    expect(outcome.reachable).toBe(false);
    expect(clock.elapsed).toBeGreaterThanOrEqual(10_000);
    // ~30 attempts at a 500ms delay, versus 10 under the old attempt cap.
    expect(outcome.attempts).toBeGreaterThan(20);
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

  it('passes the short boot timeout down to the health check', async () => {
    // The per-attempt ceiling is the difference between "warns in 15s" and
    // "hangs forever" against an accepting-but-silent host.
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

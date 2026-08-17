import { describe, it, expect, vi, afterEach } from 'vitest';
import { duckdbHealth } from '../src/duckdbClient';

// `duckdbHealth` gained two behaviours in PR #193 that are easy to regress and
// were previously unexercised: an abort signal (without which a hung upstream
// blocks boot forever) and rejection of a 200 carrying `{"ok": false}`.

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

describe('duckdbHealth', () => {
  it('returns the parsed body when duckdb reports ok', async () => {
    stubFetch(() => jsonResponse({ ok: true, db: '/data/app.duckdb' }));

    await expect(duckdbHealth(2000)).resolves.toEqual({ ok: true, db: '/data/app.duckdb' });
  });

  it('requests /health on the configured base URL', async () => {
    const spy = stubFetch(() => jsonResponse({ ok: true }));

    await duckdbHealth(2000);

    expect(spy.mock.calls[0][0]).toMatch(/\/health$/);
  });

  it('passes an AbortSignal carrying the caller-supplied timeout', async () => {
    // The P1 this closes: a bare fetch() has NO default timeout in Node, so a
    // host that accepts TCP but never answers blocks the await forever — and
    // with it the boot probe, and with that app.listen.
    const spy = stubFetch(() => jsonResponse({ ok: true }));

    await duckdbHealth(2000);

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects when the abort signal fires (hung upstream)', async () => {
    // Simulates undici's behaviour on timeout rather than asserting on the
    // signal object alone: the caller must see a rejection, not a hang.
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
          );
        }),
    );

    await expect(duckdbHealth(20)).rejects.toThrow(/aborted due to timeout/);
  });

  it('rejects on a non-2xx status', async () => {
    stubFetch(() => jsonResponse({ error: 'nope' }, 503));

    await expect(duckdbHealth(2000)).rejects.toThrow(/DuckDB health failed: 503/);
  });

  it('rejects a 200 that carries ok:false instead of calling it reachable', async () => {
    // "Listening but not serving" (e.g. the DB file failed to open) is exactly
    // the false-green the boot probe exists to remove — a 200 is not enough.
    stubFetch(() => jsonResponse({ ok: false, db: '/data/app.duckdb' }));

    await expect(duckdbHealth(2000)).rejects.toThrow(/reported not-ok/);
  });

  it('rejects a 200 with a null body rather than throwing on property access', async () => {
    stubFetch(() => jsonResponse(null));

    await expect(duckdbHealth(2000)).rejects.toThrow(/reported not-ok/);
  });
});

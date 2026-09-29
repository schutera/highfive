import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ModulesUnavailableError } from '../services/api';

/**
 * Issue #230 — round-trip tests for the multi-leg incompleteness
 * header. The mocked `fetch` returns the EXACT header string the
 * backend emits (`X-Highfive-Data-Incomplete: nests,progress`), not a
 * hand-built object — the fixture shape is the contract under test
 * (per CLAUDE.md rule 3).
 */

function mockModulesFetch(status: number, header: string | null, body: unknown = []) {
  globalThis.fetch = vi.fn(async () => {
    const headers = new Headers();
    if (header !== null) {
      headers.set('X-Highfive-Data-Incomplete', header);
    }
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
}

describe('ApiService.getAllModulesWithMeta (#230)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps a multi-leg header onto per-leg booleans', async () => {
    mockModulesFetch(200, 'nests,progress');

    const { modules, dataIncomplete } = await api.getAllModulesWithMeta();

    expect(modules).toEqual([]);
    expect(dataIncomplete).toEqual({ nests: true, progress: true, heartbeats: false });
  });

  it('keeps heartbeats-only behaviour byte-identical', async () => {
    mockModulesFetch(200, 'heartbeats');

    const { dataIncomplete } = await api.getAllModulesWithMeta();

    expect(dataIncomplete).toEqual({ nests: false, progress: false, heartbeats: true });
  });

  it('ignores unknown header tokens instead of rendering them', async () => {
    mockModulesFetch(200, 'heartbeats,quux');

    const { dataIncomplete } = await api.getAllModulesWithMeta();

    expect(dataIncomplete).toEqual({ nests: false, progress: false, heartbeats: true });
  });

  it('throws ModulesUnavailableError on 503', async () => {
    mockModulesFetch(503, null, { error: 'upstream module store unavailable' });

    await expect(api.getAllModulesWithMeta()).rejects.toBeInstanceOf(ModulesUnavailableError);
  });

  it('throws a generic Error on other non-2xx', async () => {
    mockModulesFetch(500, null);

    await expect(api.getAllModulesWithMeta()).rejects.toThrow('Failed to fetch modules');
  });
});

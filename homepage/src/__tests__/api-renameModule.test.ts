import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, RenameConflictError } from '../services/api';
import { parseModuleId } from '@highfive/contracts';

// Pin the side-effects of `api.renameModule` at the api-layer boundary.
// Auth is the HttpOnly session cookie (#142 / ADR-019): the request carries
// no secret header and uses `credentials: 'include'`; a 401/403 surfaces as a
// thrown 'unauthorized' so the modal can prompt for login. The
// `RenameModuleModal` test exercises the modal's reaction to that throw; this
// file pins its source. Together they form the two halves of the contract.

const VALID_ID = parseModuleId('e89fa9f23a08');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.renameModule', () => {
  it("throws 'unauthorized' on 401", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });

    await expect(api.renameModule(VALID_ID, 'Garden Bee')).rejects.toThrow(/unauthorized/);
  });

  it("throws 'unauthorized' on 403", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    });

    await expect(api.renameModule(VALID_ID, 'Garden Bee')).rejects.toThrow(/unauthorized/);
  });

  it('throws RenameConflictError with the conflicting MAC on 409', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'display_name already in use',
        display_name: 'Garden Bee',
        conflicting_module_id: '001122334455',
      }),
    });

    // The 409 body is the canonical wire shape pinned by
    // `duckdb-service/tests/test_modules.py::test_patch_display_name_collision_returns_409`
    // — see the chain comment in `backend/tests/admin-rename.test.ts`.
    try {
      await api.renameModule(VALID_ID, 'Garden Bee');
      throw new Error('expected RenameConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(RenameConflictError);
      const conflict = err as RenameConflictError;
      expect(conflict.displayName).toBe('Garden Bee');
      expect(conflict.conflictingModuleId).toBe('001122334455');
    }
  });

  it('serialises display_name: <string> on the happy path', async () => {
    // The most-trafficked combination (200 + non-null name). The null
    // branch lives in its own test below; the modal coalesces these
    // two through `value === '' ? null : value` so pinning both ends
    // here catches a future api-layer regression that, e.g., started
    // sending the trimmed value or wrapping in a top-level key.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: '...', display_name: 'Garden Bee' }),
    });

    await api.renameModule(VALID_ID, 'Garden Bee');

    const [calledUrl, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toContain('/modules/');
    expect(calledUrl).toContain('/name');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ display_name: 'Garden Bee' });
  });

  it('sends credentials:include and no secret header (cookie auth, #142)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await api.renameModule(VALID_ID, 'Garden Bee');

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(opts.credentials).toBe('include');
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['X-Admin-Key']).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('serialises display_name: null when called with null', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await api.renameModule(VALID_ID, null);

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(opts.body as string)).toEqual({ display_name: null });
  });
});

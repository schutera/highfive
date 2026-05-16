import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, RenameConflictError } from '../services/api';
import { parseModuleId } from '@highfive/contracts';

// Pin the side-effects of `api.renameModule` at the api-layer boundary —
// specifically the "401/403 clears hf_admin_key and throws 'unauthorized'"
// invariant. The `RenameModuleModal` test exercises the modal's reaction
// to a thrown 'unauthorized'; this file pins the source of that throw.
// Together they form the two halves of the contract.

const VALID_ID = parseModuleId('e89fa9f23a08');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('api.renameModule', () => {
  it('clears hf_admin_key from sessionStorage and throws on 401', async () => {
    sessionStorage.setItem('hf_admin_key', 'stale-key');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });

    await expect(api.renameModule(VALID_ID, 'Garden Bee')).rejects.toThrow(/unauthorized/);
    expect(sessionStorage.getItem('hf_admin_key')).toBeNull();
  });

  it('clears hf_admin_key from sessionStorage and throws on 403', async () => {
    sessionStorage.setItem('hf_admin_key', 'wrong-key');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    });

    await expect(api.renameModule(VALID_ID, 'Garden Bee')).rejects.toThrow(/unauthorized/);
    expect(sessionStorage.getItem('hf_admin_key')).toBeNull();
  });

  it('throws RenameConflictError with the conflicting MAC on 409', async () => {
    sessionStorage.setItem('hf_admin_key', 'hf_dev_key_2026');
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
    // 409 must NOT clear the key — the user is authenticated, the
    // *name* is the problem.
    expect(sessionStorage.getItem('hf_admin_key')).toBe('hf_dev_key_2026');
  });

  it('sends the X-Admin-Key header from sessionStorage', async () => {
    sessionStorage.setItem('hf_admin_key', 'hf_dev_key_2026');
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
    const headers = opts.headers as Record<string, string>;
    expect(headers['X-Admin-Key']).toBe('hf_dev_key_2026');
  });

  it('serialises display_name: null when called with null', async () => {
    sessionStorage.setItem('hf_admin_key', 'hf_dev_key_2026');
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Re-import auth.ts fresh under each scenario by clearing the module cache
// and toggling process.env. The guards in auth.ts fire at module load time
// — they have to, because the goal is "refuse to start the backend at all"
// — so we cannot test them by calling a function after import.

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.HIGHFIVE_API_KEY;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('auth.ts startup guard', () => {
  it('refuses to load when HIGHFIVE_API_KEY is the literal dev fallback', async () => {
    process.env.HIGHFIVE_API_KEY = 'hf_dev_key_2026';

    await expect(import('../src/auth')).rejects.toThrow(/dev fallback/i);
  });

  it('refuses to load when NODE_ENV=production and HIGHFIVE_API_KEY is unset', async () => {
    process.env.NODE_ENV = 'production';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('refuses to load when NODE_ENV=production and HIGHFIVE_API_KEY is whitespace-only', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HIGHFIVE_API_KEY = '   ';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('loads cleanly with no env (dev fallback active)', async () => {
    await expect(import('../src/auth')).resolves.toBeDefined();
  });

  it('loads cleanly with NODE_ENV=test (matches vitest default)', async () => {
    process.env.NODE_ENV = 'test';

    await expect(import('../src/auth')).resolves.toBeDefined();
  });

  it('loads cleanly with NODE_ENV=production and a strong key', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HIGHFIVE_API_KEY = 'a-strong-32-byte-random-value-here';

    await expect(import('../src/auth')).resolves.toBeDefined();
  });
});

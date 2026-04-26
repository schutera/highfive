import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Mock the database module BEFORE importing app to avoid the ModuleCache
// constructor firing real fetches against duckdb-service.
vi.mock('../src/database', () => ({
  db: {
    refresh: vi.fn().mockResolvedValue(undefined),
    getAllModules: vi.fn().mockReturnValue([]),
    getModuleById: vi.fn().mockReturnValue(null),
  },
}));

import { app } from '../src/app';

describe('GET /api/health', () => {
  it('returns 200 with status:"ok" and a timestamp', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    // Should be ISO-8601 parseable
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });

  it('does NOT require an API key', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });
});

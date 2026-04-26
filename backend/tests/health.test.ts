import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Mock the database module BEFORE importing app. The ModuleReadModel
// constructor is already inert — this stub keeps things tidy and avoids
// any accidental upstream call from a future change.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue([]),
    getModuleDetail: vi.fn().mockResolvedValue(null),
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

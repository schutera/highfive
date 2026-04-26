import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Hoisted stubs so we can drive db behaviour per-test. vi.mock factory below
// references these via the spec-mandated `vi.hoisted` pattern.
const mocks = vi.hoisted(() => ({
  refresh: vi.fn().mockResolvedValue(undefined),
  getAllModules: vi.fn(),
  getModuleById: vi.fn(),
}));

vi.mock('../src/database', () => ({
  db: {
    refresh: mocks.refresh,
    getAllModules: mocks.getAllModules,
    getModuleById: mocks.getModuleById,
  },
}));

import { app } from '../src/app';

const KEY = 'hf_dev_key_2026';

beforeEach(() => {
  mocks.refresh.mockClear();
  mocks.getAllModules.mockReset();
  mocks.getModuleById.mockReset();
});

describe('GET /api/modules', () => {
  it('returns 401 without an API key', async () => {
    const res = await request(app).get('/api/modules');
    expect(res.status).toBe(401);
  });

  it('returns 200 with the array from db.getAllModules()', async () => {
    const fakeModules = [
      {
        id: 'm1',
        name: 'Hive 1',
        location: { lat: 1, lng: 2 },
        status: 'online',
        lastApiCall: new Date().toISOString(),
        batteryLevel: 80,
        firstOnline: new Date().toISOString(),
        totalHatches: 3,
        imageCount: 12,
      },
    ];
    mocks.getAllModules.mockReturnValue(fakeModules);

    const res = await request(app).get('/api/modules').set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeModules);
    expect(mocks.getAllModules).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/modules/:id', () => {
  it('returns 200 for a valid id', async () => {
    const fakeModule = {
      id: 'm1',
      name: 'Hive 1',
      location: { lat: 1, lng: 2 },
      status: 'online',
      lastApiCall: 'x',
      batteryLevel: 50,
      firstOnline: 'y',
      totalHatches: 0,
      imageCount: 0,
      nests: [],
    };
    mocks.getModuleById.mockReturnValue(fakeModule);

    const res = await request(app).get('/api/modules/m1').set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeModule);
    expect(mocks.getModuleById).toHaveBeenCalledWith('m1');
  });

  it('returns 404 for an unknown id', async () => {
    mocks.getModuleById.mockReturnValue(null);

    const res = await request(app).get('/api/modules/does-not-exist').set('X-API-Key', KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Module not found');
  });
});

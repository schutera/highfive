import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Hoisted stubs so we can drive the read model behaviour per-test.
// vi.mock factory below references these via the spec-mandated `vi.hoisted`
// pattern.
const mocks = vi.hoisted(() => ({
  listModules: vi.fn(),
  getModuleDetail: vi.fn(),
}));

vi.mock('../src/database', () => ({
  db: {
    listModules: mocks.listModules,
    getModuleDetail: mocks.getModuleDetail,
  },
}));

import { app } from '../src/app';

const KEY = 'hf_dev_key_2026';
const VALID_ID = 'aabbccddeeff';

beforeEach(() => {
  mocks.listModules.mockReset();
  mocks.getModuleDetail.mockReset();
});

describe('GET /api/modules', () => {
  it('returns 401 without an API key', async () => {
    const res = await request(app).get('/api/modules');
    expect(res.status).toBe(401);
  });

  it('returns 200 with the array from db.listModules()', async () => {
    const fakeModules = [
      {
        id: VALID_ID,
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
    mocks.listModules.mockResolvedValue({ modules: fakeModules, heartbeatsFailed: false });

    const res = await request(app).get('/api/modules').set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeModules);
    expect(res.headers['x-highfive-data-incomplete']).toBeUndefined();
    expect(mocks.listModules).toHaveBeenCalledTimes(1);
  });

  it('sets X-Highfive-Data-Incomplete=heartbeats when the read model flags partial data', async () => {
    mocks.listModules.mockResolvedValue({ modules: [], heartbeatsFailed: true });

    const res = await request(app).get('/api/modules').set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.headers['x-highfive-data-incomplete']).toBe('heartbeats');
  });
});

describe('GET /api/modules/:id', () => {
  it('returns 200 for a valid id', async () => {
    const fakeModule = {
      id: VALID_ID,
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
    mocks.getModuleDetail.mockResolvedValue({ detail: fakeModule, heartbeatsFailed: false });

    const res = await request(app).get(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(fakeModule);
    expect(res.headers['x-highfive-data-incomplete']).toBeUndefined();
    expect(mocks.getModuleDetail).toHaveBeenCalledWith(VALID_ID);
  });

  it('returns 404 for an unknown id', async () => {
    mocks.getModuleDetail.mockResolvedValue({ detail: null, heartbeatsFailed: false });

    const res = await request(app).get('/api/modules/000000000001').set('X-API-Key', KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Module not found');
  });

  it('returns 400 for a malformed module id', async () => {
    const res = await request(app).get('/api/modules/not-an-id').set('X-API-Key', KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid module id format');
    expect(mocks.getModuleDetail).not.toHaveBeenCalled();
  });
});

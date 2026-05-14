import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mock the database module so app boot is inert — this route doesn't touch
// it, but importing app pulls the module graph in.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue([]),
    getModuleDetail: vi.fn().mockResolvedValue(null),
  },
}));

// Mock the userLocation module so this suite tests the route's status-code
// mapping in isolation — the lookup logic itself is covered by
// userLocation.test.ts.
vi.mock('../src/userLocation', () => ({
  lookupUserLocation: vi.fn(),
}));

import { app } from '../src/app';
import { lookupUserLocation } from '../src/userLocation';

const KEY = 'hf_dev_key_2026';

beforeEach(() => {
  vi.mocked(lookupUserLocation).mockReset();
});

describe('GET /api/user-location', () => {
  it('requires an API key', async () => {
    const res = await request(app).get('/api/user-location');
    expect(res.status).toBe(401);
    expect(vi.mocked(lookupUserLocation)).not.toHaveBeenCalled();
  });

  it('returns 200 with the lookup payload on success', async () => {
    vi.mocked(lookupUserLocation).mockResolvedValue({
      source: 'miss',
      data: { lat: 52.52, lng: 13.405 },
    });
    const res = await request(app)
      .get('/api/user-location')
      .set('X-API-Key', KEY)
      .set('X-Forwarded-For', '8.8.8.8'); // trust-proxy honours this from loopback

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lat: 52.52, lng: 13.405 });
  });

  it('returns 200 on a cache hit too (source:"hit" is still success)', async () => {
    vi.mocked(lookupUserLocation).mockResolvedValue({
      source: 'hit',
      data: { lat: 1, lng: 2 },
    });
    const res = await request(app).get('/api/user-location').set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lat: 1, lng: 2 });
  });

  it('returns 204 for private/loopback IPs', async () => {
    vi.mocked(lookupUserLocation).mockResolvedValue({ source: 'private', data: null });
    const res = await request(app).get('/api/user-location').set('X-API-Key', KEY);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('returns 503 when the upstream lookup is unavailable', async () => {
    vi.mocked(lookupUserLocation).mockResolvedValue({ source: 'unavailable', data: null });
    const res = await request(app).get('/api/user-location').set('X-API-Key', KEY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('user-location unavailable');
  });

  it('forwards the visitor IP from X-Forwarded-For (trust-proxy honours loopback)', async () => {
    vi.mocked(lookupUserLocation).mockResolvedValue({
      source: 'miss',
      data: { lat: 0, lng: 0 },
    });
    await request(app)
      .get('/api/user-location')
      .set('X-API-Key', KEY)
      .set('X-Forwarded-For', '8.8.8.8');

    expect(vi.mocked(lookupUserLocation)).toHaveBeenCalledTimes(1);
    const callIp = vi.mocked(lookupUserLocation).mock.calls[0][0];
    expect(callIp).toBe('8.8.8.8');
  });
});

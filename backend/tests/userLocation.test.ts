import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isPrivateOrLoopbackIp,
  lookupUserLocation,
  _resetUserLocationCache,
} from '../src/userLocation';

beforeEach(() => {
  _resetUserLocationCache();
});

describe('isPrivateOrLoopbackIp', () => {
  it.each([
    ['::1'],
    ['127.0.0.1'],
    ['::ffff:127.0.0.1'],
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['192.168.1.42'],
    ['172.16.0.1'],
    ['172.20.5.5'],
    ['172.31.255.255'],
    ['169.254.1.1'],
    ['fe80::1'],
    ['fc00::1'],
    ['fd12:3456::1'],
  ])('classifies %s as private/loopback', (ip) => {
    expect(isPrivateOrLoopbackIp(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['172.32.0.1'], // just outside RFC-1918 range
    ['172.15.0.1'],
    ['172.100.0.1'],
    ['2001:4860:4860::8888'],
  ])('classifies %s as public', (ip) => {
    expect(isPrivateOrLoopbackIp(ip)).toBe(false);
  });
});

describe('lookupUserLocation', () => {
  function mockFetchOnce(
    body: unknown,
    init: { ok?: boolean; status?: number } = {},
  ): typeof fetch {
    const ok = init.ok ?? true;
    const status = init.status ?? 200;
    return vi.fn().mockResolvedValueOnce({
      ok,
      status,
      json: async () => body,
    }) as unknown as typeof fetch;
  }

  it('short-circuits private/loopback IPs without calling upstream', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await lookupUserLocation('::1', fetchFn);
    expect(result).toEqual({ source: 'private', data: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('maps a successful ipapi.co response to UserLocation', async () => {
    const fetchFn = mockFetchOnce({
      latitude: 52.52,
      longitude: 13.405,
      city: 'Berlin',
      country_code: 'DE',
    });
    const result = await lookupUserLocation('8.8.8.8', fetchFn);
    expect(result.source).toBe('miss');
    expect(result.data).toEqual({ lat: 52.52, lng: 13.405 });
  });

  it('hits the cache on a repeat lookup within TTL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ latitude: 1, longitude: 2 }),
    }) as unknown as typeof fetch;
    const now = vi.fn().mockReturnValue(1_000_000);

    const first = await lookupUserLocation('8.8.8.8', fetchFn, now);
    const second = await lookupUserLocation('8.8.8.8', fetchFn, now);

    expect(first.source).toBe('miss');
    expect(second.source).toBe('hit');
    expect(second.data).toEqual(first.data);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('expires the cache after TTL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ latitude: 1, longitude: 2 }),
    }) as unknown as typeof fetch;
    const now = vi.fn().mockReturnValueOnce(1_000_000); // first call

    const first = await lookupUserLocation('8.8.8.8', fetchFn, now);
    expect(first.source).toBe('miss');

    // 1 h 1 s later → cache expired
    now.mockReturnValueOnce(1_000_000 + 60 * 60 * 1000 + 1000);
    now.mockReturnValueOnce(1_000_000 + 60 * 60 * 1000 + 1000); // for the post-fetch set()
    const third = await lookupUserLocation('8.8.8.8', fetchFn, now);
    expect(third.source).toBe('miss');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns unavailable on non-2xx upstream', async () => {
    const fetchFn = mockFetchOnce(
      { error: true, reason: 'RateLimited' },
      { ok: false, status: 429 },
    );
    const result = await lookupUserLocation('8.8.8.8', fetchFn);
    expect(result).toEqual({ source: 'unavailable', data: null });
  });

  it('returns unavailable when upstream fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const result = await lookupUserLocation('8.8.8.8', fetchFn);
    expect(result).toEqual({ source: 'unavailable', data: null });
  });

  it('returns unavailable when upstream 200s with error:true (free-tier rate limit)', async () => {
    // ipapi.co rate-limits with HTTP 200 + { error: true, reason: '...' }
    // in some edge cases — we must not surface those as a real location.
    const fetchFn = mockFetchOnce({ error: true, reason: 'RateLimited' });
    const result = await lookupUserLocation('8.8.8.8', fetchFn);
    expect(result).toEqual({ source: 'unavailable', data: null });
  });

  it('returns unavailable when upstream omits latitude/longitude', async () => {
    const fetchFn = mockFetchOnce({ city: 'Berlin' });
    const result = await lookupUserLocation('8.8.8.8', fetchFn);
    expect(result).toEqual({ source: 'unavailable', data: null });
  });

  it('normalises IPv6-mapped IPv4 in the cache key and upstream URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ latitude: 1, longitude: 2 }),
    }) as unknown as typeof fetch;

    await lookupUserLocation('::ffff:8.8.8.8', fetchFn);
    // Second lookup with the unmapped form should hit the same cache entry.
    const second = await lookupUserLocation('8.8.8.8', fetchFn);
    expect(second.source).toBe('hit');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(
      String((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]),
    ).toContain('8.8.8.8');
  });
});

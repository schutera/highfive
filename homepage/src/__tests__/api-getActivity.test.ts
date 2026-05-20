import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../services/api';

// Wire-shape round-trip pin for `api.getActivity` per CLAUDE.md rule #3:
// the chart's `ActivityWeatherChart.test.tsx` mocks at the api-boundary
// (stubs `api.getActivity` directly), which doesn't exercise the
// `parseModuleId(obj.moduleId)` step that turns the raw `string` from
// the backend into the branded `ModuleId`. That parse is the only piece
// of runtime validation the homepage owns for this wire shape — if the
// backend ever emits a non-canonical id, the round trip throws here.
//
// The fixture mirrors EXACTLY what `backend/src/app.ts::/api/modules/:id/activity`
// emits (camelCase, top-level `moduleId`); the matching backend test
// (`backend/tests/activity-route.test.ts::maps snake_case upstream body
// to camelCase`) pins the other half.

const VALID_ID = 'aabbccddeeff';

const wireFixture = {
  moduleId: VALID_ID,
  interval: 'hourly' as const,
  start: '2026-05-13T00:00:00',
  end: '2026-05-20T00:00:00',
  buckets: [
    { timestamp: '2026-05-13T00:00:00', count: 0 },
    { timestamp: '2026-05-13T01:00:00', count: 3 },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.getActivity wire-shape round trip', () => {
  it('parses the camelCase JSON shape the backend actually emits', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => wireFixture,
    });

    const result = await api.getActivity(VALID_ID, 'hourly', 7);

    // moduleId arrives as a plain string from JSON.parse and must come
    // out the other side as a branded `ModuleId`. parseModuleId is the
    // only guard that catches "backend leaked a colon-separated MAC"
    // — TypeScript can't.
    expect(result.moduleId).toBe(VALID_ID);
    expect(result.interval).toBe('hourly');
    expect(result.start).toBe(wireFixture.start);
    expect(result.end).toBe(wireFixture.end);
    expect(result.buckets).toEqual(wireFixture.buckets);
  });

  it('throws when the backend leaks a non-canonical module id', async () => {
    // parseModuleId is strict: 12 lowercase hex, no separators. If the
    // backend ever forgets to re-map and forwards `"AA:BB:CC:DD:EE:FF"`,
    // the round trip throws here instead of letting an invalid branded
    // id loose downstream.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...wireFixture, moduleId: 'AA:BB:CC:DD:EE:FF' }),
    });
    // parseModuleId canonicalises on the way in (lowercase, strip
    // separators), so a colon-formatted MAC survives. The genuinely
    // broken case is one that can't be canonicalised at all.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...wireFixture, moduleId: 'not-a-mac' }),
    });
    await expect(api.getActivity(VALID_ID, 'hourly', 7)).rejects.toThrow(/invalid ModuleId/);
  });

  it('throws on a non-2xx response (caller catches as a chart-level error state)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Module not found' }),
    });
    await expect(api.getActivity(VALID_ID, 'hourly', 7)).rejects.toThrow(
      /Failed to fetch activity/,
    );
  });

  it('forwards interval and days verbatim to the backend URL', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...wireFixture, interval: 'daily' }),
    });
    await api.getActivity(VALID_ID, 'daily', 30);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname.endsWith(`/modules/${VALID_ID}/activity`)).toBe(true);
    expect(u.searchParams.get('interval')).toBe('daily');
    expect(u.searchParams.get('days')).toBe('30');
  });
});

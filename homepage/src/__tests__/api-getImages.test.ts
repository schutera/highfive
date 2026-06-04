import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../services/api';

// Wire-shape round-trip pin for `api.getImages` per CLAUDE.md rule #3.
// The admin gallery (`AdminPage.tsx`) renders this shape and decides
// whether to show "Load more" from `total`, so the fixture mirrors
// EXACTLY what `GET /api/images` emits: the `{ images, total }`
// envelope that backend proxies from image-service → duckdb-service's
// `list_image_uploads` (pinned on the other half by
// `duckdb-service/tests/test_module_endpoints.py`).

const VALID_ID = 'aabbccddeeff';

const wirePage = {
  images: [
    { module_id: VALID_ID, filename: 'b.jpg', uploaded_at: '2024-06-02 12:00:00' },
    { module_id: VALID_ID, filename: 'a.jpg', uploaded_at: '2024-06-01 12:00:00' },
  ],
  total: 7,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.getImages wire-shape round trip', () => {
  it('parses the { images, total } envelope the backend actually emits', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => wirePage,
    });

    const page = await api.getImages(VALID_ID, { limit: 2, offset: 0 });

    // `total` (not images.length) is what drives the "Load more" button,
    // so it must survive the round trip intact.
    expect(page.total).toBe(7);
    expect(page.images.map((i) => i.filename)).toEqual(['b.jpg', 'a.jpg']);
  });

  it('forwards module_id/limit/offset verbatim to the backend URL', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ images: [], total: 0 }),
    });

    await api.getImages(VALID_ID, { limit: 5, offset: 10 });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname.endsWith('/images')).toBe(true);
    expect(u.searchParams.get('module_id')).toBe(VALID_ID);
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('offset')).toBe('10');
  });

  it('omits all params when called bare (no filter, no paging)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ images: [], total: 0 }),
    });

    await api.getImages();

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const u = new URL(String(url));
    expect(u.search).toBe('');
  });

  it('falls back to images.length when an old response omits total', async () => {
    // Back-compat: a pre-pagination image-service (or a cached old
    // response) returns just { images }. The client must still produce a
    // usable `total` so the gallery does not render a phantom "Load more".
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ images: wirePage.images }),
    });

    const page = await api.getImages(VALID_ID, { limit: 2, offset: 0 });
    expect(page.total).toBe(2);
  });

  it('throws on a non-2xx response (AdminPage catches as an error state)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'Failed to fetch images from image service' }),
    });
    await expect(api.getImages(VALID_ID)).rejects.toThrow(/Failed to fetch images/);
  });
});

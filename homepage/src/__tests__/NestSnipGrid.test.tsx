import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { NestSnip } from '@highfive/contracts';

import { LanguageProvider } from '../i18n/LanguageContext';

// NestSnipGrid renders a module's latest per-nest hole snips (#165) as a grid:
// one row per bee type, each cell a cropped close-up with an empty/sealed
// badge. The fixture mirrors the exact NestSnip wire shape (CLAUDE.md "mount
// with a realistic fixture" rule — the shape is the contract under test).

let nextSnips: NestSnip[] | null = [];

vi.mock('../services/api', () => ({
  api: {
    getSnips: vi.fn(() =>
      nextSnips ? Promise.resolve(nextSnips) : Promise.reject(new Error('snips unavailable')),
    ),
    getSnipUrl: vi.fn((f: string) => `http://localhost:3002/api/snips/${encodeURIComponent(f)}`),
  },
}));

import NestSnipGrid from '../components/NestSnipGrid';

const snip = (
  beeType: NestSnip['beeType'],
  nestIndex: number,
  state: NestSnip['state'],
): NestSnip => ({
  beeType,
  nestIndex,
  state,
  confidence: 0.9,
  snipFilename: `cap-${beeType}-${nestIndex}.jpg`,
  bbox: [0.1, 0.2, 0.3, 0.3],
  sourceFilename: 'cap.jpg',
  detectedAt: '2026-06-11 10:30:00',
});

function renderGrid() {
  return render(
    <LanguageProvider>
      <NestSnipGrid moduleId="e89fa9f23a08" />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  nextSnips = [];
});

describe('NestSnipGrid', () => {
  it('renders a snip image and a sealed/empty badge per hole', async () => {
    nextSnips = [snip('leafcutter', 1, 'sealed'), snip('leafcutter', 2, 'empty')];
    renderGrid();

    // Each snip's <img> resolves through getSnipUrl.
    await waitFor(() => {
      const imgs = screen.getAllByRole('img');
      expect(imgs).toHaveLength(2);
    });
    const imgs = screen.getAllByRole('img') as HTMLImageElement[];
    expect(imgs[0].src).toContain('/api/snips/cap-leafcutter-1.jpg');

    // Badges reflect the real states (one sealed, one empty).
    expect(screen.getByText('Sealed')).toBeInTheDocument();
    expect(screen.getByText('Empty')).toBeInTheDocument();
  });

  it('groups by bee type in ascending-diameter order', async () => {
    // Provide out-of-order types; the grid must order rows by BEE_TYPES
    // (blackmasked < resin < leafcutter < orchard) regardless of input order.
    nextSnips = [snip('orchard', 1, 'sealed'), snip('blackmasked', 1, 'empty')];
    renderGrid();

    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    // The size labels (2 mm = blackmasked, 9 mm = orchard) appear; the
    // smallest-diameter row renders before the largest in DOM order.
    const sizes = screen.getAllByText(/mm$/).map((el) => el.textContent);
    expect(sizes).toEqual(['2 mm', '9 mm']);
  });

  it('renders nothing when the module has no detections', async () => {
    nextSnips = [];
    const { container } = renderGrid();
    await waitFor(() => {
      // Skeleton clears, then the empty-state early-return leaves no card.
      expect(container.querySelector('.hf-skeleton')).toBeNull();
    });
    expect(screen.queryByText('Nest holes')).not.toBeInTheDocument();
  });

  it('degrades silently on fetch failure (never throws to the parent)', async () => {
    nextSnips = null; // makes getSnips reject
    const { container } = renderGrid();
    await waitFor(() => {
      expect(container.querySelector('.hf-skeleton')).toBeNull();
    });
    expect(screen.queryByText('Nest holes')).not.toBeInTheDocument();
  });
});

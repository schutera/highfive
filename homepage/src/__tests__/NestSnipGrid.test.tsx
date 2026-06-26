import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { NestSnip } from '@highfive/contracts';

import { LanguageProvider } from '../i18n/LanguageContext';

// NestSnipGrid renders a module's per-nest hole snips (#165) as a grid — one row
// per bee type, each cell a cropped close-up with a badge — plus a single global
// time-lapse scrubber (#166 phase 3) that, when dragged, swaps ALL holes to the
// chosen capture's crops at once. The fixture mirrors the exact NestSnip wire
// shape across multiple captures (CLAUDE.md "mount with a realistic fixture"
// rule — the shape is the contract under test). The backend returns the flat
// history oldest-first; the grid groups it by `sourceFilename` into frames.

let nextHistory: NestSnip[] | null = [];

vi.mock('../services/api', () => ({
  api: {
    getSnipHistory: vi.fn(() =>
      nextHistory ? Promise.resolve(nextHistory) : Promise.reject(new Error('history unavailable')),
    ),
    getSnipUrl: vi.fn((f: string) => `http://localhost:3002/api/snips/${encodeURIComponent(f)}`),
  },
}));

import NestSnipGrid from '../components/NestSnipGrid';

const snip = (
  capture: string,
  detectedAt: string,
  beeType: NestSnip['beeType'],
  nestIndex: number,
  state: NestSnip['state'],
): NestSnip => ({
  beeType,
  nestIndex,
  state,
  confidence: 0.9,
  snipFilename: `${capture}-${beeType}-${nestIndex}.jpg`,
  bbox: [0.1, 0.2, 0.3, 0.3],
  sourceFilename: `${capture}.jpg`,
  detectedAt,
});

function renderGrid() {
  return render(
    <LanguageProvider>
      <NestSnipGrid moduleId="e89fa9f23a08" />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  nextHistory = [];
});

describe('NestSnipGrid', () => {
  it('opens on the newest capture and renders its holes with badges', async () => {
    nextHistory = [
      snip('cap1', '2026-06-01 12:00:00', 'leafcutter', 1, 'empty'),
      snip('cap2', '2026-06-05 12:00:00', 'leafcutter', 1, 'sealed'),
    ];
    renderGrid();

    // Default frame is the newest capture (cap2, sealed) — the block's current state.
    const img = (await screen.findByTestId('snip-frame')) as HTMLImageElement;
    expect(img.src).toContain('/api/snips/cap2-leafcutter-1.jpg');
    expect(screen.getByText('Sealed')).toBeInTheDocument();
    // Frame counter + capture date reflect the newest frame (2 of 2).
    expect(screen.getByText('Capture 2 of 2')).toBeInTheDocument();
    expect(screen.getByTestId('snip-capture-date').textContent).toMatch(/2026/);
  });

  it('scrubbing the global slider swaps every hole to the chosen capture at once', async () => {
    // Two holes per capture so we can prove the slider moves ALL of them, not one.
    nextHistory = [
      snip('cap1', '2026-06-01 12:00:00', 'leafcutter', 1, 'empty'),
      snip('cap1', '2026-06-01 12:00:00', 'resin', 1, 'empty'),
      snip('cap2', '2026-06-05 12:00:00', 'leafcutter', 1, 'sealed'),
      snip('cap2', '2026-06-05 12:00:00', 'resin', 1, 'sealed'),
    ];
    renderGrid();

    await waitFor(() => expect(screen.getAllByTestId('snip-frame')).toHaveLength(2));
    // Newest frame: both holes are cap2.
    let imgs = screen.getAllByTestId('snip-frame') as HTMLImageElement[];
    expect(imgs.every((i) => i.src.includes('/api/snips/cap2-'))).toBe(true);

    // Two captures → slider range 0..1. Scrub to the oldest.
    const scrubber = screen.getByTestId('snip-scrubber') as HTMLInputElement;
    expect(scrubber.max).toBe('1');
    fireEvent.change(scrubber, { target: { value: '0' } });

    await waitFor(() => {
      imgs = screen.getAllByTestId('snip-frame') as HTMLImageElement[];
      expect(imgs.every((i) => i.src.includes('/api/snips/cap1-'))).toBe(true);
    });
    // Both badges followed to the oldest (empty) frame.
    expect(screen.getAllByText('Empty')).toHaveLength(2);
    expect(screen.getByText('Capture 1 of 2')).toBeInTheDocument();
  });

  it('hides the scrubber and shows a single-frame note when only one capture exists', async () => {
    nextHistory = [snip('only', '2026-06-05 12:00:00', 'leafcutter', 1, 'sealed')];
    renderGrid();

    await screen.findByTestId('snip-frame');
    expect(screen.queryByTestId('snip-scrubber')).not.toBeInTheDocument();
    expect(screen.getByText(/only one capture so far/i)).toBeInTheDocument();
  });

  it('renders a neutral "Detected" badge for the localize-only undetermined state', async () => {
    // The learned detector (ADR-027) emits `undetermined` — located but
    // empty/sealed deferred. The badge must read neutral, never guess sealed.
    nextHistory = [snip('cap', '2026-06-05 12:00:00', 'leafcutter', 1, 'undetermined')];
    renderGrid();

    await screen.findByTestId('snip-frame');
    expect(screen.getByText('Detected')).toBeInTheDocument();
    expect(screen.queryByText('Sealed')).not.toBeInTheDocument();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
  });

  it('groups by bee type in ascending-diameter order', async () => {
    // Provide out-of-order types in one capture; the grid must order rows by
    // BEE_TYPES (blackmasked < resin < leafcutter < orchard) regardless of input.
    nextHistory = [
      snip('cap', '2026-06-05 12:00:00', 'orchard', 1, 'sealed'),
      snip('cap', '2026-06-05 12:00:00', 'blackmasked', 1, 'empty'),
    ];
    renderGrid();

    await waitFor(() => expect(screen.getAllByTestId('snip-frame')).toHaveLength(2));
    // The size labels (2 mm = blackmasked, 9 mm = orchard) appear; the
    // smallest-diameter row renders before the largest in DOM order.
    const sizes = screen.getAllByText(/mm$/).map((el) => el.textContent);
    expect(sizes).toEqual(['2 mm', '9 mm']);
  });

  it('renders nothing when the module has no detections', async () => {
    nextHistory = [];
    const { container } = renderGrid();
    await waitFor(() => {
      // Skeleton clears, then the empty-state early-return leaves no card.
      expect(container.querySelector('.hf-skeleton')).toBeNull();
    });
    expect(screen.queryByText('Nest holes')).not.toBeInTheDocument();
  });

  it('degrades silently on fetch failure (never throws to the parent)', async () => {
    nextHistory = null; // makes getSnipHistory reject
    const { container } = renderGrid();
    await waitFor(() => {
      expect(container.querySelector('.hf-skeleton')).toBeNull();
    });
    expect(screen.queryByText('Nest holes')).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NestSnip } from '@highfive/contracts';

import { LanguageProvider } from '../i18n/LanguageContext';

// SnipTimelapseModal scrubs one hole's capture history across days (#166 phase
// 3). The fixture mirrors the exact NestSnip wire shape, one entry per capture
// (CLAUDE.md "mount with a realistic fixture" rule). detectedAt is the opaque
// "YYYY-MM-DD HH:MM:SS" UTC string the backend emits.

let nextTimeline: NestSnip[] | null = [];

vi.mock('../services/api', () => ({
  api: {
    getSnipTimeline: vi.fn(() =>
      nextTimeline
        ? Promise.resolve(nextTimeline)
        : Promise.reject(new Error('timeline unavailable')),
    ),
    getSnipUrl: vi.fn((f: string) => `http://localhost:3002/api/snips/${encodeURIComponent(f)}`),
  },
}));

import SnipTimelapseModal from '../components/SnipTimelapseModal';

const frame = (capture: string, state: NestSnip['state'], detectedAt: string): NestSnip => ({
  beeType: 'leafcutter',
  nestIndex: 1,
  state,
  confidence: 0.9,
  snipFilename: `${capture}-leafcutter-1.jpg`,
  bbox: [0.1, 0.2, 0.3, 0.3],
  sourceFilename: `${capture}.jpg`,
  detectedAt,
});

function renderModal(onClose = vi.fn()) {
  return render(
    <LanguageProvider>
      <SnipTimelapseModal
        moduleId="000000000002"
        beeType="leafcutter"
        nestIndex={1}
        onClose={onClose}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  nextTimeline = [];
});

describe('SnipTimelapseModal', () => {
  it('opens on the most recent capture and scrubbing swaps the rendered snip', async () => {
    nextTimeline = [
      frame('d1', 'empty', '2026-06-01 12:00:00'),
      frame('d2', 'undetermined', '2026-06-03 12:00:00'),
      frame('d3', 'sealed', '2026-06-05 12:00:00'),
    ];
    renderModal();

    // Opens on the newest frame (d3, sealed) — the hole's current state.
    const img = (await screen.findByTestId('timelapse-frame')) as HTMLImageElement;
    expect(img.src).toContain('/api/snips/d3-leafcutter-1.jpg');
    expect(screen.getByText('Sealed')).toBeInTheDocument();
    expect(screen.getByText('Capture 3 of 3')).toBeInTheDocument();

    // Scrub back to the first capture — the image and badge must follow.
    const scrubber = screen.getByTestId('timelapse-scrubber') as HTMLInputElement;
    expect(scrubber.max).toBe('2'); // 3 frames → indices 0..2
    fireEvent.change(scrubber, { target: { value: '0' } });

    await waitFor(() => {
      const updated = screen.getByTestId('timelapse-frame') as HTMLImageElement;
      expect(updated.src).toContain('/api/snips/d1-leafcutter-1.jpg');
    });
    expect(screen.getByText('Empty')).toBeInTheDocument();
    expect(screen.getByText('Capture 1 of 3')).toBeInTheDocument();
  });

  it('hides the scrubber and shows a single-frame note when only one capture exists', async () => {
    nextTimeline = [frame('only', 'sealed', '2026-06-05 12:00:00')];
    renderModal();

    await screen.findByTestId('timelapse-frame');
    expect(screen.queryByTestId('timelapse-scrubber')).not.toBeInTheDocument();
    expect(screen.getByText(/only one capture so far/i)).toBeInTheDocument();
  });

  it('shows an empty-state message when the nest has no captures', async () => {
    nextTimeline = [];
    renderModal();
    expect(await screen.findByText(/no captures yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('timelapse-frame')).not.toBeInTheDocument();
  });

  it('shows an error message when the timeline fetch fails', async () => {
    nextTimeline = null; // makes getSnipTimeline reject
    renderModal();
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it('closes on Escape, backdrop click, and the close button', async () => {
    nextTimeline = [frame('d1', 'sealed', '2026-06-05 12:00:00')];

    // Escape
    const onCloseEsc = vi.fn();
    const esc = renderModal(onCloseEsc);
    await screen.findByTestId('timelapse-frame');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseEsc).toHaveBeenCalledTimes(1);
    esc.unmount();

    // Backdrop click
    const onCloseBackdrop = vi.fn();
    const back = renderModal(onCloseBackdrop);
    const backdrop = await screen.findByTestId('snip-timelapse-modal');
    await userEvent.click(backdrop);
    expect(onCloseBackdrop).toHaveBeenCalled();
    back.unmount();

    // Close button
    const onCloseBtn = vi.fn();
    renderModal(onCloseBtn);
    await screen.findByTestId('timelapse-frame');
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onCloseBtn).toHaveBeenCalled();
  });

  it('parses the UTC detectedAt string into a readable date', async () => {
    nextTimeline = [frame('d1', 'sealed', '2026-06-05 12:00:00')];
    renderModal();
    const dateEl = await screen.findByTestId('timelapse-frame-date');
    // en-US "Jun 5, 2026" — the exact format is locale-driven; assert the year
    // and month landed (proves the string parsed, not NaN/Invalid Date).
    expect(dateEl.textContent).toMatch(/2026/);
    expect(dateEl.textContent).toMatch(/Jun/);
  });
});

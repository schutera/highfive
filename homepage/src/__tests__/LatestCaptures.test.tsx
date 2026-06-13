import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ImageUploadsPage } from '@highfive/contracts';

import { LanguageProvider } from '../i18n/LanguageContext';

// LatestCaptures renders a module's uploads as a newest-first carousel
// (two 4:3 cards visible, arrows to page older, click → lightbox). Fixtures
// mirror the exact ImageUploadsPage wire shape: `uploaded_at` is
// "YYYY-MM-DD HH:MM:SS" UTC (not ISO-8601), filenames are whatever the ESP
// sent. CLAUDE.md "mount with a realistic fixture" rule — this shape is the
// contract under test.

let nextPage: ImageUploadsPage | null = { images: [], total: 0 };

vi.mock('../services/api', () => ({
  api: {
    getImages: vi.fn(() =>
      nextPage ? Promise.resolve(nextPage) : Promise.reject(new Error('images unavailable')),
    ),
    getImageUrl: vi.fn((f: string) => `http://localhost:3002/api/images/${encodeURIComponent(f)}`),
  },
}));

import LatestCaptures from '../components/LatestCaptures';

const img = (filename: string, uploaded_at: string) => ({
  module_id: 'e89fa9f23a08',
  filename,
  uploaded_at,
});

function renderCaptures() {
  return render(
    <LanguageProvider>
      <LatestCaptures moduleId="e89fa9f23a08" moduleName="Garden Bee" locale="en-US" />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  nextPage = { images: [], total: 0 };
});

describe('LatestCaptures', () => {
  it('renders the newest images with UTC-correct timestamps', async () => {
    nextPage = {
      images: [
        img('esp_capture_1781234567890.jpg', '2026-06-11 10:30:00'),
        img('esp_capture_1781234500000.jpg', '2026-06-11 09:15:00'),
      ],
      total: 6,
    };
    renderCaptures();

    await waitFor(() => expect(screen.getByText('Latest captures')).toBeInTheDocument());

    // Both visible cards render their image (jsdom never loads pixels — the
    // naturalWidth proof lives in the Playwright spec; here, attributes only).
    const imgs = screen.getAllByAltText('Capture from Garden Bee');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute(
      'src',
      'http://localhost:3002/api/images/esp_capture_1781234567890.jpg',
    );

    // Timestamp built through the same UTC-anchored parse the component must
    // use; a local-time regression diverges from this in any non-UTC env.
    const expected = new Date('2026-06-11T10:30:00Z').toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders nothing when the module has no uploads', async () => {
    nextPage = { images: [], total: 0 };
    const { container } = renderCaptures();
    // Give the effect a tick to resolve to the empty page.
    await waitFor(() => expect(container.querySelector('.hf-skeleton')).toBeNull());
    expect(screen.queryByText('Latest captures')).not.toBeInTheDocument();
  });

  it('degrades silently (renders nothing) when the fetch fails', async () => {
    nextPage = null; // mock rejects
    const { container } = renderCaptures();
    await waitFor(() => expect(container.querySelector('.hf-skeleton')).toBeNull());
    expect(screen.queryByText('Latest captures')).not.toBeInTheDocument();
  });

  it('shows scroll arrows only when there are more than the two visible cards', async () => {
    nextPage = {
      images: [img('a.jpg', '2026-06-11 10:30:00'), img('b.jpg', '2026-06-11 09:15:00')],
      total: 6, // more pages exist → arrows shown
    };
    renderCaptures();
    await waitFor(() => expect(screen.getByText('Latest captures')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'More images' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous images' })).toBeInTheDocument();
  });

  it('hides scroll arrows when the whole gallery fits (≤ 2 images)', async () => {
    nextPage = { images: [img('only.jpg', '2026-06-11 10:30:00')], total: 1 };
    renderCaptures();
    await waitFor(() => expect(screen.getByText('Latest captures')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'More images' })).not.toBeInTheDocument();
  });

  it('opens a delete-free lightbox on click and closes it on Escape', async () => {
    nextPage = { images: [img('only.jpg', '2026-06-11 10:30:00')], total: 1 };
    renderCaptures();
    await waitFor(() => expect(screen.getByText('Latest captures')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Open full-size image' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Public surface — no destructive affordance (ADR-019 separation).
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// WaitlistPage rate-limit handling (2026-07 audit, for #206).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n/LanguageContext';
import translations from '../i18n/translations';
import WaitlistPage from '../pages/WaitlistPage';

function renderWaitlist() {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <WaitlistPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

async function submitValidForm() {
  fireEvent.change(screen.getByLabelText(translations.en.waitlist.nameLabel), {
    target: { value: 'Test Bee' },
  });
  fireEvent.change(screen.getByLabelText(translations.en.waitlist.emailLabel), {
    target: { value: 'bee@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: translations.en.waitlist.submit }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WaitlistPage', () => {
  it('shows the specific translated message on a 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: 'Too many signups from your network — try again later' }),
      }),
    );
    renderWaitlist();
    await submitValidForm();
    await waitFor(() => {
      expect(screen.getByText(translations.en.waitlist.rateLimited)).toBeInTheDocument();
    });
  });

  it('still shows the server error for non-429 failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: 'Failed to register signup' }),
      }),
    );
    renderWaitlist();
    await submitValidForm();
    await waitFor(() => {
      expect(screen.getByText('Failed to register signup')).toBeInTheDocument();
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n/LanguageContext';

// Avoid network or canvas paths — HomePage doesn't use them, but keep
// the api module mocked for safety/consistency with the other tests.
vi.mock('../services/api', () => ({
  api: {
    getAllModules: vi.fn().mockResolvedValue([]),
    getModuleById: vi.fn(),
    getModuleLogs: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue({ status: 'ok', timestamp: '' }),
  },
}));

import HomePage from '../pages/HomePage';

function renderHome() {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

describe('HomePage smoke', () => {
  it('renders the HighFive hero title', () => {
    renderHome();
    // The hero <h1> is identified by its accessible role + name. The
    // wordmark in the floating top bar is a span, not a heading, so
    // role=heading uniquely targets the hero title regardless of the
    // floating brand mark.
    expect(screen.getByRole('heading', { level: 1, name: /HighFive/i })).toBeInTheDocument();
  });

  it('renders a link pointing to /dashboard', () => {
    renderHome();
    const dashboardLinks = screen
      .getAllByRole('link')
      .filter((a) => (a as HTMLAnchorElement).getAttribute('href') === '/dashboard');
    expect(dashboardLinks.length).toBeGreaterThan(0);
  });
});

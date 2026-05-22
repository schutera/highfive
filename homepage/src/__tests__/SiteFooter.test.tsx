import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import SiteFooter from '../components/SiteFooter';
import { LanguageProvider } from '../i18n/LanguageContext';

// Pins the Open-Meteo attribution link added for ADR-017 (server-side
// weather worker for #111). The component is plain JSX with no
// conditional rendering, so this test would fail loudly if a future
// refactor accidentally drops the attribution — and the CC-BY 4.0
// licence requirement that ADR-017 carries forward from ADR-015 would
// quietly stop being met.
describe('SiteFooter', () => {
  it('renders the Impressum link and the Open-Meteo attribution', () => {
    render(
      <LanguageProvider>
        <SiteFooter />
      </LanguageProvider>,
    );

    const impressum = screen.getByRole('link', { name: /Impressum/i });
    expect(impressum).toHaveAttribute('href', 'https://partner.schutera.com/impressum');

    const weather = screen.getByRole('link', { name: /Open-Meteo/i });
    expect(weather).toHaveAttribute('href', 'https://open-meteo.com/');
    expect(weather).toHaveAttribute('rel', 'noopener noreferrer');
    expect(weather).toHaveAttribute('target', '_blank');
  });
});

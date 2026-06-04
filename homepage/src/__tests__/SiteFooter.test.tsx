import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import SiteFooter from '../components/SiteFooter';
import { LanguageProvider } from '../i18n/LanguageContext';

// Pins the Impressum link (German legal compliance). The Open-Meteo
// CC-BY 4.0 attribution link was removed alongside disabling the
// dashboard weather chart — with no weather data rendered anywhere in
// the UI, the attribution is no longer tied to a visible use. The
// absence assertion below guards against it silently creeping back in
// while the weather feature stays disabled; restore both together when
// ActivityWeatherChart is re-enabled against real data (ADR-017/ADR-015).
describe('SiteFooter', () => {
  it('renders the Impressum link', () => {
    render(
      <LanguageProvider>
        <SiteFooter />
      </LanguageProvider>,
    );

    const impressum = screen.getByRole('link', { name: /Impressum/i });
    expect(impressum).toHaveAttribute('href', 'https://partner.schutera.com/impressum');
  });

  it('does not render the Open-Meteo attribution while the weather chart is disabled', () => {
    render(
      <LanguageProvider>
        <SiteFooter />
      </LanguageProvider>,
    );

    expect(screen.queryByRole('link', { name: /Open-Meteo/i })).not.toBeInTheDocument();
  });
});

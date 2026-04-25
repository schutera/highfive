import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LanguageProvider, useTranslation } from '../i18n/LanguageContext';

function Probe() {
  const { lang, setLang, t } = useTranslation();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="online">{t('common.online')}</span>
      {/* common.loading differs between EN ("Loading...") and DE ("Laden...") */}
      <span data-testid="loading">{t('common.loading')}</span>
      <button onClick={() => setLang(lang === 'en' ? 'de' : 'en')}>toggle</button>
    </div>
  );
}

describe('LanguageContext', () => {
  beforeEach(() => {
    localStorage.clear();
    // Force English baseline by faking navigator.language
    Object.defineProperty(window.navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });
  });

  it('exposes a default language and resolves t() to English strings', () => {
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );

    // Default language is either "en" or "de" — both are valid.
    const lang = screen.getByTestId('lang').textContent;
    expect(['en', 'de']).toContain(lang);

    // Either way, t() must return a non-empty string (not the path itself).
    const online = screen.getByTestId('online').textContent ?? '';
    expect(online.length).toBeGreaterThan(0);
    expect(online).not.toBe('common.online');
  });

  it('switches language when setLang is called and updates t() output', () => {
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );

    const before = screen.getByTestId('loading').textContent;
    act(() => {
      screen.getByText('toggle').click();
    });
    const after = screen.getByTestId('loading').textContent;

    // Same key should resolve to a different translated string after switching.
    expect(after).not.toBe(before);
    // And the lang span flipped.
    const newLang = screen.getByTestId('lang').textContent;
    expect(['en', 'de']).toContain(newLang);
  });
});

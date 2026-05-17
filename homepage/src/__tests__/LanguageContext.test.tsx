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

  it('plural-aware keys: branches by count, falls back to .other for missing/zero/non-numeric count', () => {
    function PluralProbe() {
      const { lang, setLang, t } = useTranslation();
      return (
        <div>
          <span data-testid="plural-1">{t('dashboard.modulesListed', { count: 1 })}</span>
          <span data-testid="plural-3">{t('dashboard.modulesListed', { count: 3 })}</span>
          {/* count=0: per Intl.PluralRules('en'|'de'), 0 selects the
              .other branch — pinned here so a future refactor that
              treats 0 specially (e.g. "no modules listed") doesn't
              silently change the empty-state copy. */}
          <span data-testid="plural-0">{t('dashboard.modulesListed', { count: 0 })}</span>
          {/* No params at all — `t` must fall back to .other rather
              than returning the path string or throwing. The desktop
              floating list is gated on `sideListModules.length > 0`
              so this isn't reachable from DashboardPage today, but
              the contract should be defensive. */}
          <span data-testid="plural-no-params">{t('dashboard.modulesListed')}</span>
          <button onClick={() => setLang(lang === 'en' ? 'de' : 'en')}>toggle</button>
          <span data-testid="lang">{lang}</span>
        </div>
      );
    }
    render(
      <LanguageProvider>
        <PluralProbe />
      </LanguageProvider>,
    );

    // Default en: "1 module listed" (singular) vs "3 modules listed" (plural).
    expect(screen.getByTestId('plural-1').textContent).toBe('1 module listed');
    expect(screen.getByTestId('plural-3').textContent).toBe('3 modules listed');
    // count=0 → .other branch (English: "0 modules listed").
    expect(screen.getByTestId('plural-0').textContent).toBe('0 modules listed');
    // No params → .other branch with `{count}` left intact (no value to interpolate).
    expect(screen.getByTestId('plural-no-params').textContent).toBe('{count} modules listed');

    act(() => {
      screen.getByText('toggle').click();
    });

    // de: "1 aufgelistetes Modul" (singular adjective + singular noun) vs
    // "3 aufgelistete Module" (plural adjective + plural noun). The
    // pre-plural string "1 aufgelistete Module" would have been
    // ungrammatical — both adjective ending and noun number wrong.
    expect(screen.getByTestId('plural-1').textContent).toBe('1 aufgelistetes Modul');
    expect(screen.getByTestId('plural-3').textContent).toBe('3 aufgelistete Module');
    expect(screen.getByTestId('plural-0').textContent).toBe('0 aufgelistete Module');
    expect(screen.getByTestId('plural-no-params').textContent).toBe('{count} aufgelistete Module');
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

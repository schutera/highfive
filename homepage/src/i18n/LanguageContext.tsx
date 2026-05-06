import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import translations, { Language } from './translations';

interface LanguageContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function detectLanguage(): Language {
  const stored = localStorage.getItem('lang');
  if (stored === 'de' || stored === 'en') return stored;
  return navigator.language.startsWith('de') ? 'de' : 'en';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(detectLanguage);

  // Keep <html lang> in sync for accessibility (screen readers, search,
  // hyphenation). The bootstrap script in index.html sets it pre-paint;
  // this effect handles toggle changes thereafter.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', lang);
    }
  }, [lang]);

  const setLang = useCallback((newLang: Language) => {
    setLangState(newLang);
    try {
      localStorage.setItem('lang', newLang);
    } catch {
      /* private mode */
    }
  }, []);

  const t = useCallback(
    (path: string, params?: Record<string, string | number>): string => {
      let value = resolve(translations[lang], path);
      // Fallback to English
      if (value === undefined) {
        value = resolve(translations.en, path);
      }
      // Non-string leaves (e.g. array-valued setup.stepLabels) collapse to
      // the path key — t() can't return arrays. Use useTranslationRaw() for
      // those and pluck the field directly.
      if (typeof value !== 'string') return path;
      if (!params) return value;
      return value.replace(/\{(\w+)\}/g, (_, key) =>
        params[key] !== undefined ? String(params[key]) : `{${key}}`,
      );
    },
    [lang],
  );

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>{children}</LanguageContext.Provider>
  );
}

export function useTranslation() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider');
  return ctx;
}

export function useTranslationRaw() {
  const { lang } = useTranslation();
  return translations[lang];
}

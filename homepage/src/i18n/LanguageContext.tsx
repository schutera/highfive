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
      // Plural form: keys can be `{ one: string, other: string }` and the
      // branch is selected via `Intl.PluralRules` against `params.count`.
      // Required to render grammatical German singulars: "1 aufgelistetes
      // Modul" vs. "N aufgelistete Module" (the agreement-by-count rule
      // can't be sidestepped with a single string). English uses the same
      // mechanism for symmetry. Falls back to `.other` when count is
      // missing or not numeric.
      if (
        value &&
        typeof value === 'object' &&
        'other' in (value as Record<string, unknown>) &&
        typeof (value as Record<string, unknown>).other === 'string'
      ) {
        const branches = value as Record<string, string>;
        const count = typeof params?.count === 'number' ? params.count : undefined;
        const rule =
          count !== undefined
            ? new Intl.PluralRules(lang).select(count)
            : 'other';
        const fallbackEn = resolve(translations.en, path);
        const fallbackBranches =
          fallbackEn && typeof fallbackEn === 'object'
            ? (fallbackEn as Record<string, string>)
            : {};
        value = branches[rule] ?? fallbackBranches[rule] ?? branches.other;
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

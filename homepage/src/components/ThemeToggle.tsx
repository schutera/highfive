import { useEffect, useState, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'auto';

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'auto';
  try {
    const v = localStorage.getItem('hf-theme');
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* ignore */
  }
  return 'auto';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

/**
 * Three-state theme toggle: auto / light / dark. Cycles on click.
 * Auto = follow `prefers-color-scheme`. Light/dark are explicit overrides
 * that persist in localStorage and are applied pre-paint by a bootstrap
 * script in index.html so there's no flash.
 */
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === 'auto') localStorage.removeItem('hf-theme');
      else localStorage.setItem('hf-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((t) => (t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto'));
  }, []);

  const labels: Record<Theme, { aria: string; icon: string; tooltip: string }> = {
    auto: { aria: 'Theme: auto', icon: 'auto', tooltip: 'Auto (system)' },
    light: { aria: 'Theme: light', icon: 'light', tooltip: 'Light' },
    dark: { aria: 'Theme: dark', icon: 'dark', tooltip: 'Dark' },
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title={labels[theme].tooltip}
      aria-label={labels[theme].aria}
      className={`inline-flex items-center justify-center w-9 h-9 rounded-full text-hf-fg-soft hover:text-hf-fg hover:bg-hf-fg/5 transition-colors ${className}`}
    >
      {theme === 'dark' ? (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"
          />
        </svg>
      ) : theme === 'light' ? (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" strokeWidth={2} />
          <path
            strokeLinecap="round"
            strokeWidth={2}
            d="M12 2v2m0 16v2m10-10h-2M4 12H2m15.07-7.07l-1.41 1.41M6.34 17.66l-1.41 1.41m12.73 0l-1.41-1.41M6.34 6.34L4.93 4.93"
          />
        </svg>
      ) : (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 3v18M3 12a9 9 0 1018 0 9 9 0 00-18 0z"
          />
        </svg>
      )}
    </button>
  );
}

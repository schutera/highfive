import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Note: ErrorBoundary is a class component and cannot use hooks.
// It uses both EN and DE strings inline with a helper that reads localStorage.
function getLang(): 'en' | 'de' {
  try {
    const stored = localStorage.getItem('lang');
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    /* ignore */
  }
  return navigator.language.startsWith('de') ? 'de' : 'en';
}

const strings = {
  en: { title: 'Something went wrong', reload: 'Reload Page' },
  de: { title: 'Etwas ist schiefgelaufen', reload: 'Seite neu laden' },
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      const s = strings[getLang()];
      return (
        this.props.fallback || (
          <div
            role="alert"
            className="min-h-[100dvh] flex items-center justify-center bg-hf-bg text-hf-fg p-6"
          >
            <div className="hf-card p-8 max-w-md w-full text-center">
              <div className="text-4xl mb-3" aria-hidden="true">
                🐝
              </div>
              <h2
                className="font-bold mb-2"
                style={{ fontSize: 'var(--fs-lg)', color: 'var(--hf-danger)' }}
              >
                {s.title}
              </h2>
              <p className="text-hf-fg-soft text-hf-sm mb-6 break-words">
                {this.state.error?.message}
              </p>
              <button
                onClick={() => window.location.reload()}
                className="hf-btn hf-btn-primary px-6 py-3"
              >
                {s.reload}
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

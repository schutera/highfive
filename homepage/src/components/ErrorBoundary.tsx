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
  const stored = localStorage.getItem('lang');
  if (stored === 'de' || stored === 'en') return stored;
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
      return this.props.fallback || (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="p-8 text-center">
            <h2 className="text-xl font-bold text-red-600 mb-2">{s.title}</h2>
            <p className="text-gray-600">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg"
            >
              {s.reload}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

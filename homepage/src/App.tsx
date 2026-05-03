import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './style.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LanguageProvider } from './i18n/LanguageContext';
// Code-split the page bundles. Each route only loads its own JS + the
// libraries it actually uses (e.g. only /dashboard pulls leaflet).
const HomePage = lazy(() => import('./pages/HomePage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SetupWizard = lazy(() => import('./pages/SetupWizard'));
const HiveModule = lazy(() => import('./pages/HiveModule'));
const AssemblyGuide = lazy(() => import('./pages/AssemblyGuide'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

/**
 * Branded fallback shown while a lazy route is loading. Intentionally
 * minimal — a small centred wordmark with a soft pulse — so it works
 * for any route shape without committing to a layout.
 */
function RouteFallback() {
  return (
    <div
      className="min-h-[100dvh] flex items-center justify-center bg-hf-bg text-hf-fg"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-4 animate-fade-in">
        <span className="text-5xl" aria-hidden="true">
          🙌
        </span>
        <span className="hf-skeleton w-32 h-2 rounded-full" />
        <span className="sr-only">Loading…</span>
      </div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <Router>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/setup" element={<SetupWizard />} />
              <Route path="/hive-module" element={<HiveModule />} />
              <Route path="/assembly" element={<AssemblyGuide />} />
              <Route path="/admin" element={<AdminPage />} />
              {/* Redirect old routes */}
              <Route path="/web-installer" element={<Navigate to="/setup" replace />} />
              <Route path="/setup-guide" element={<Navigate to="/setup" replace />} />
              <Route path="/parts-list" element={<Navigate to="/hive-module" replace />} />
            </Routes>
          </Suspense>
        </Router>
      </LanguageProvider>
    </ErrorBoundary>
  );
}

export default App;

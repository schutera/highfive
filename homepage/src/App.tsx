import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
    <LanguageProvider>
      <Router>
        {/* Skip link — first focusable thing on every page (WCAG 2.4.1
            Bypass Blocks). Only visible when keyboard-focused. The
            target id="main" is rendered by each page's <main> element.
            Kept OUTSIDE <ErrorBoundedRoutes/> so it stays focusable
            even if the boundary is showing the error fallback. */}
        <a
          href="#main"
          className="sr-only-focusable focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-hf-fg focus:text-hf-bg focus:px-4 focus:py-2 focus:rounded-md focus:font-semibold focus:outline-none focus:ring-2 focus:ring-hf-honey-500"
        >
          Skip to main content
        </a>
        <ErrorBoundedRoutes />
      </Router>
    </LanguageProvider>
  );
}

/**
 * Wraps the route tree in an ErrorBoundary that re-mounts on every
 * navigation. Without this, a render error on /dashboard would leave
 * the boundary stuck in its "Something went wrong" state forever — even
 * after the user navigates to /. Keying the boundary by location.pathname
 * forces a fresh instance per route, which clears the error state.
 *
 * Has to live inside <Router> because useLocation() needs the router
 * context. The skip link sits above this so it remains usable when the
 * boundary is showing its fallback.
 */
function ErrorBoundedRoutes() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/hive-module" element={<HiveModule />} />
          <Route path="/assembly" element={<AssemblyGuide />} />
          {/* Redirect old routes */}
          <Route path="/web-installer" element={<Navigate to="/setup" replace />} />
          <Route path="/setup-guide" element={<Navigate to="/setup" replace />} />
          <Route path="/parts-list" element={<Navigate to="/hive-module" replace />} />
          {/* Catch-all: any unknown path redirects home, replaces history
              so the bad URL doesn't sit in the back-button stack. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;

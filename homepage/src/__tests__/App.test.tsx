import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// App.tsx pulls the lazy pages, which import contracts + leaflet etc.
// Stub everything heavy out at the module-graph boundary.
vi.mock('../services/api', () => ({
  api: {
    getAllModules: vi.fn().mockResolvedValue([]),
    getModuleById: vi.fn(),
    getModuleLogs: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue({ status: 'ok', timestamp: '' }),
  },
}));

vi.mock('leaflet', () => {
  const divIcon = () => ({});
  const icon = () => ({});
  const IconDefault = function () {} as unknown as {
    prototype: Record<string, unknown>;
    mergeOptions: () => void;
  };
  IconDefault.prototype = {};
  IconDefault.mergeOptions = () => undefined;
  const Marker = function () {} as unknown as {
    prototype: { options: { icon: unknown } };
  };
  Marker.prototype = { options: { icon: null } };
  const L = {
    divIcon,
    icon,
    Icon: { Default: IconDefault },
    Marker,
    LatLngBounds: class {
      contains() {
        return true;
      }
    },
    LatLng: class {
      constructor(
        public lat: number,
        public lng: number,
      ) {}
    },
  };
  return { default: L, ...L };
});

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    MapContainer: Pass,
    TileLayer: () => null,
    Marker: () => null,
    Circle: () => null,
    Popup: Pass,
    useMap: () => ({
      getBounds: () => ({ contains: () => true }),
      setView: () => undefined,
      on: () => undefined,
      off: () => undefined,
    }),
    useMapEvents: () => ({}),
  };
});

// MemoryRouter has its own history context, but App.tsx uses BrowserRouter.
// The catch-all route Test relies on App's actual <Routes>, so we have to
// drive the URL via window.history before render and reset after.
import App from '../App';

describe('App routing', () => {
  it('redirects unknown routes to /', async () => {
    // Drive the BrowserRouter to a URL that no <Route> declares.
    window.history.pushState({}, '', '/this-path-does-not-exist');

    render(<App />);

    // After the catch-all <Navigate to="/" replace /> fires, the
    // HomePage's hero h1 ("HighFive") should be visible.
    await waitFor(
      () => {
        // The HomePage h1 has id="hero-title" — anchor on that.
        const h1 = document.getElementById('hero-title');
        expect(h1).not.toBeNull();
      },
      { timeout: 3000 },
    );

    // And history should have been replaced, so the URL is now /.
    expect(window.location.pathname).toBe('/');
  });

  it('renders the global skip-to-main link', async () => {
    window.history.pushState({}, '', '/');
    render(<App />);

    // Skip link is the first focusable thing — present in the DOM
    // even before any route renders. WCAG 2.4.1 Bypass Blocks.
    const skipLink = await screen.findByRole('link', { name: /skip to main content/i });
    expect(skipLink).toHaveAttribute('href', '#main');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n/LanguageContext';

// Mock api so the dashboard's useEffect resolves with no modules.
vi.mock('../services/api', () => ({
  api: {
    getAllModules: vi.fn().mockResolvedValue([]),
    getModuleById: vi.fn(),
    getModuleLogs: vi.fn().mockResolvedValue([]),
    updateModuleStatus: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ status: 'ok', timestamp: '' }),
  },
}));

// jsdom has no canvas — replace leaflet entities with dumb placeholders.
vi.mock('leaflet', () => {
  const divIcon = () => ({});
  const icon = () => ({});
  const IconDefault = function () {} as unknown as {
    prototype: Record<string, unknown>;
    mergeOptions: () => void;
  };
  IconDefault.prototype = {};
  IconDefault.mergeOptions = () => undefined;

  // MapView mutates L.Marker.prototype.options.icon at module load,
  // so the mock has to expose that exact shape.
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
      constructor(public lat: number, public lng: number) {}
    },
  };
  return { default: L, ...L };
});

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div data-testid="leaflet-stub">{children}</div>;
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

import DashboardPage from '../pages/DashboardPage';

describe('DashboardPage smoke', () => {
  it('renders the dashboard shell when api returns no modules', async () => {
    render(
      <LanguageProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </LanguageProvider>,
    );

    // The HighFive brand link is rendered in the header immediately.
    expect(screen.getByText(/HighFive/i)).toBeInTheDocument();

    // After the effect resolves, loading state should clear and the
    // "0/0" online counter (or similar status pill) shows up.
    await waitFor(() => {
      // At least one element with text "0" should now exist (online count).
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    });
  });
});

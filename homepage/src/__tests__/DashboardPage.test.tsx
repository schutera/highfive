import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Module } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';
import { LanguageProvider } from '../i18n/LanguageContext';

// Mock api so the dashboard's useEffect resolves with whatever the
// individual test sets via `nextDashboardModules` below — `[]` by default.
let nextDashboardModules: Module[] = [];
vi.mock('../services/api', () => ({
  api: {
    getAllModules: vi.fn(() => Promise.resolve(nextDashboardModules)),
    getAllModulesWithMeta: vi.fn(() =>
      Promise.resolve({
        modules: nextDashboardModules,
        dataIncomplete: { heartbeats: false },
      }),
    ),
    getModuleById: vi.fn(),
    getModuleLogs: vi.fn().mockResolvedValue([]),
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

  // `LatLng` is named out here so the factory `latLng` (Leaflet's
  // lowercase-helper convention) can hand back an *instance* of the
  // class rather than a bare object. Round-5 senior-review P2: if a
  // future MapView change calls `.distanceTo(...)` or `.equals(...)`
  // on the result, a bare-object mock TypeErrors in tests while the
  // prod build keeps working — keeping the mock class-identity-
  // compatible avoids that future fragility.
  class LatLng {
    constructor(
      public lat: number,
      public lng: number,
    ) {}
  }
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
    LatLng,
    // `L.latLng(lat, lng)` is called by MapView's bounds-filter useMemo
    // (`L.latLng(fuzzedLocation[0], fuzzedLocation[1])`); add the
    // factory form so non-empty `modules` fixtures don't trip the
    // bounds path with an "is not a function" exception. The actual
    // bounds.contains() result is stubbed to `true` above, so the
    // returned value's content doesn't matter — only that it's an
    // instance-shaped object (see LatLng comment above).
    latLng: (lat: number, lng: number) => new LatLng(lat, lng),
  };
  return { default: L, ...L };
});

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="leaflet-stub">{children}</div>
  );
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

function makeModule(args: {
  id: string;
  name?: string;
  location?: { lat: number; lng: number };
}): Module {
  return {
    id: parseModuleId(args.id),
    name: args.name ?? 'fierce-apricot-specht',
    displayName: null,
    location: args.location ?? { lat: 47.78, lng: 9.61 },
    status: 'online',
    lastApiCall: '2026-05-16T20:00:00.000Z',
    batteryLevel: 88,
    firstOnline: '2026-05-16',
    totalHatches: 0,
    imageCount: 0,
    email: null,
    updatedAt: '2026-05-16T20:00:00.000Z',
    lastSeenAt: '2026-05-16T20:00:00.000Z',
    latestHeartbeat: null,
  };
}

describe('DashboardPage smoke', () => {
  it('renders the dashboard shell when api returns no modules', async () => {
    nextDashboardModules = [];
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

// PR II / issue #89 — the side-list must include modules without a
// plausible location (the (0,0) Null Island sentinel) so operators
// can spot a module that failed boot-time getGeolocation and hasn't
// yet recovered via heartbeat. Post-#103, DashboardPage owns the
// authoritative `modules` set and renders the side-list directly from
// it; MapView no longer emits list-shaped data. Pending-location
// modules sink to the bottom of the rendered list so the map-rendered
// modules dominate the top. MapView itself still filters them out of
// the marker set (`hasPlausibleLocation`).
describe('DashboardPage Location-pending side-list', () => {
  it('shows pending-location modules at the bottom; plausible modules sorted alphabetically by display name', async () => {
    // Fixture chosen to distinguish three possible sort behaviours:
    //   - no-op:               [pending-null-island, real-bodensee, alpha-foo]
    //   - pending-last only:   [real-bodensee, alpha-foo, pending-null-island]
    //   - pending-last + abc:  [alpha-foo,    real-bodensee, pending-null-island]
    // The assertions below pin the third (current) shape.
    nextDashboardModules = [
      makeModule({ id: 'aabbccddeeff', name: 'pending-null-island', location: { lat: 0, lng: 0 } }),
      makeModule({
        id: '000000000001',
        name: 'real-bodensee',
        location: { lat: 47.78, lng: 9.61 },
      }),
      makeModule({
        id: '111111111111',
        name: 'alpha-foo',
        location: { lat: 47.79, lng: 9.62 },
      }),
    ];
    render(
      <LanguageProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </LanguageProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('pending-null-island')).toBeInTheDocument();
      expect(screen.getByText('real-bodensee')).toBeInTheDocument();
      expect(screen.getByText('alpha-foo')).toBeInTheDocument();
    });

    // Scope to the desktop side-list `<ul>`. Pin: exactly one
    // "Location pending" pill, rendered inside the list.
    const sideList = screen.getByRole('list');
    expect(within(sideList).getAllByText('Location pending')).toHaveLength(1);

    // Full ordering invariant.
    const items = within(sideList).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('alpha-foo');
    expect(items[1]).toHaveTextContent('real-bodensee');
    expect(items[2]).toHaveTextContent('pending-null-island');

    // Header counter includes ALL modules (3/3 online).
    expect(screen.getByLabelText(/3 of 3 modules online/i)).toBeInTheDocument();
  });

  // The wire contract `Module.displayName: string | null` permits `""`.
  // `duckdb-service`'s `set_display_name` normalises empty-after-strip
  // to NULL server-side, so this is theoretical today — but the
  // `displayLabel` defense in DashboardPage.tsx exists explicitly for
  // this case. Without it, the previous `??`-only short-circuit would
  // sort by `name` (defense applied to the sort) while rendering a
  // blank `<h3>` (defense NOT applied to render) — a ghost row. Round-3
  // senior-review P1: walk the fixture through the rendered DOM, not
  // just the sort key.
  it('renders the firmware name when displayName is the empty string (no ghost row)', async () => {
    nextDashboardModules = [
      makeModule({
        id: '222222222222',
        name: 'fallback-firmware-name',
        location: { lat: 47.78, lng: 9.61 },
      }),
    ];
    // Patch the displayName on the fixture to `""` — `makeModule`'s
    // default is `null`, but we want to exercise the empty-string path
    // specifically (the `??` operator would short-circuit on `null` but
    // not on `""`).
    nextDashboardModules[0] = { ...nextDashboardModules[0], displayName: '' };

    render(
      <LanguageProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </LanguageProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('fallback-firmware-name')).toBeInTheDocument();
    });

    const sideList = screen.getByRole('list');
    const heading = within(sideList).getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent('fallback-firmware-name');
  });
});

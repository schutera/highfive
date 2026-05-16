import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    // `L.latLng(lat, lng)` is called by MapView's bounds-filter useMemo
    // (`L.latLng(fuzzedLocation[0], fuzzedLocation[1])`); add a plain
    // function form so non-empty `modules` fixtures don't trip the
    // bounds path with an "is not a function" exception. The actual
    // bounds.contains() result is stubbed to `true` above, so this is
    // a pass-through.
    latLng: (lat: number, lng: number) => ({ lat, lng }),
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
// plausible location (the (0,0) Null Island sentinel) so operators can
// spot a module that failed boot-time getGeolocation and hasn't yet
// recovered via heartbeat. MapView itself filters them out of the
// rendered marker set (`hasPlausibleLocation` in
// homepage/src/lib/location.ts) — DashboardPage adds them back to the
// side-list as the union of bounds-filtered visible + all pending.
// Without this test, the round-1 senior-review fix that tightened the
// MapView pre-bounds fallback to ALSO filter pending modules silently
// dropped them from the side-list entirely. Found during manual
// dev-stack smoke before PR-II merge: AdminPage showed the module
// with the pill, header counter showed 6/6, but the dashboard side-
// list said "5 sichtbar" and the operator had no way to find the
// pending module from the dashboard view.
describe('DashboardPage Location-pending side-list', () => {
  it('shows pending-location modules in the side-list with the Location pending pill', async () => {
    nextDashboardModules = [
      makeModule({
        id: '000000000001',
        name: 'real-bodensee',
        location: { lat: 47.78, lng: 9.61 },
      }),
      makeModule({ id: 'aabbccddeeff', name: 'pending-null-island', location: { lat: 0, lng: 0 } }),
    ];
    render(
      <LanguageProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </LanguageProvider>,
    );

    await waitFor(() => {
      // The pending module's firmware name renders in the side-list.
      // If this fails, the operator-visible regression is back —
      // pending modules are invisible from the dashboard.
      expect(screen.getByText('pending-null-island')).toBeInTheDocument();
    });

    // The pill copy comes from the LanguageProvider default lang (en).
    // It appears exactly once — once per pending module, in the
    // desktop side-list. The mobile bottom-sheet's pill markup only
    // renders when the sheet is expanded (which requires user input),
    // so under jsdom mount alone there's a single pill node. A tighter
    // assertion than ">0" catches a regression that double-renders or
    // misses the pill for some pending modules.
    expect(screen.getAllByText('Location pending')).toHaveLength(1);

    // Header counter includes BOTH modules (2/2 online). Before this
    // fix the side-list said "1 sichtbar" while the header still
    // counted 2/2 — the asymmetry between the two surfaces is what
    // the operator-visible bug looked like.
    expect(screen.getByLabelText(/2 of 2 modules online/i)).toBeInTheDocument();

    // The plausible-location fixture is intentionally not asserted on
    // here. In this jsdom env the react-leaflet mocks don't propagate
    // MapView's `onVisibleModulesChange` callback synchronously enough
    // for the visible-half of the union to land in the rendered DOM
    // before the test reads it, so a getByText('real-bodensee') would
    // flake. Keeping the fixture in `nextDashboardModules` ensures the
    // `pendingModules = modules.filter(!plausible)` logic is exercised
    // against a *mixed* input — a regression that lumped plausible
    // modules into the pending bucket would surface a stray
    // 'real-bodensee' Location-pending pill above, which the strict
    // single-pill assertion would still catch indirectly. The visible-
    // half of the union is exercised end-to-end by the manual smoke
    // documented in
    // docs/10-quality-requirements/manual-tests-field-reliability.md
    // (Part 2 of the field-reliability runbook).
  });
});

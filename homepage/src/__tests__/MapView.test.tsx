import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../i18n/LanguageContext';

// One shared mock map per test file — vi.mock factories cannot reference
// out-of-scope state, so we expose it via a module-level ref and reset
// in beforeEach. The shape mirrors only the pieces MapView actually uses.
const mockMap = {
  flyTo: vi.fn(),
  addControl: vi.fn(),
  removeControl: vi.fn(),
  getBounds: () => ({ contains: () => true }),
  getZoom: () => 13,
};

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="leaflet-stub">{children}</div>
  );
  return {
    MapContainer: Pass,
    TileLayer: () => null,
    Marker: () => null,
    Circle: () => null,
    useMap: () => mockMap,
    useMapEvents: () => ({}),
  };
});

// MapView talks to L.Control.extend(), L.DomEvent.{disableClickPropagation,
// disableScrollPropagation}, and mutates L.Marker.prototype.options.icon at
// import time. The mock implements just enough of each to let the real
// LocateControl onAdd() run and produce a button.
vi.mock('leaflet', () => {
  const divIcon = () => ({});
  const icon = () => ({});

  const Marker = function () {} as unknown as { prototype: { options: { icon: unknown } } };
  Marker.prototype = { options: { icon: null } };

  type ControlProto = {
    options?: Record<string, unknown>;
    onAdd?: (map: unknown) => HTMLElement;
  };
  const Control = function (this: ControlProto, opts?: Record<string, unknown>) {
    this.options = { ...(this.options ?? {}), ...(opts ?? {}) };
  } as unknown as {
    new (opts?: Record<string, unknown>): ControlProto;
    extend(proto: ControlProto): {
      new (opts?: Record<string, unknown>): ControlProto;
    };
  };
  Control.extend = (proto: ControlProto) => {
    const Sub = function (this: ControlProto, opts?: Record<string, unknown>) {
      Object.assign(this, proto);
      this.options = { ...(proto.options ?? {}), ...(opts ?? {}) };
    } as unknown as { new (opts?: Record<string, unknown>): ControlProto };
    return Sub;
  };

  const L = {
    divIcon,
    icon,
    Marker,
    Control,
    DomEvent: {
      disableClickPropagation: vi.fn(),
      disableScrollPropagation: vi.fn(),
    },
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

import MapView from '../components/MapView';

// `navigator` in jsdom exposes its properties via prototype getters, so
// `{ ...navigator, geolocation: x }` strips `language` and breaks
// LanguageProvider's detectLanguage(). Override only the geolocation slot
// via defineProperty so the rest of the navigator stays intact.
function stubGeolocation(impl: Partial<Geolocation>) {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: vi.fn(),
      watchPosition: vi.fn(),
      clearWatch: vi.fn(),
      ...impl,
    },
  });
}

// Stub the Permissions API the same way. jsdom doesn't ship it, so leaving
// it undefined makes the `'permissions' in navigator` check short-circuit
// to the legacy getCurrentPosition path (existing tests rely on this).
function stubPermissions(state: PermissionState) {
  Object.defineProperty(globalThis.navigator, 'permissions', {
    configurable: true,
    value: {
      query: vi.fn().mockResolvedValue({ state }),
    },
  });
}

beforeEach(() => {
  mockMap.flyTo.mockReset();
  mockMap.addControl.mockReset();
  mockMap.removeControl.mockReset();
  // addControl actually wires the button into the DOM so RTL queries can
  // find it — mirrors what real Leaflet does inside the control-container.
  mockMap.addControl.mockImplementation((control: { onAdd?: (map: unknown) => HTMLElement }) => {
    const el = control.onAdd?.(mockMap);
    if (el) document.body.appendChild(el);
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  // Drop the geolocation + permissions overrides so later tests see the
  // jsdom default (neither API available).
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis.navigator, 'permissions', {
    configurable: true,
    value: undefined,
  });
});

function renderMap() {
  return render(
    <LanguageProvider>
      <MapView modules={[]} selectedModule={null} onModuleSelect={() => undefined} />
    </LanguageProvider>,
  );
}

describe('MapView locate control', () => {
  it('renders the locate button with an accessible label', () => {
    renderMap();
    expect(screen.getByLabelText('Show my location')).toBeInTheDocument();
  });

  it('flies the map to the user position on a successful geolocation call', () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) => {
      ok({
        coords: {
          latitude: 52.52,
          longitude: 13.405,
          accuracy: 50,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    stubGeolocation({ getCurrentPosition });

    renderMap();
    fireEvent.click(screen.getByLabelText('Show my location'));

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(mockMap.flyTo).toHaveBeenCalledWith([52.52, 13.405], 14, { duration: 1.5 });
  });

  it('ignores a late geolocation success after the component unmounts (abort guard)', () => {
    // Capture the success callback without invoking it. We then unmount
    // MapView (the LocateControl effect's cleanup runs and flips
    // `aborted`) and finally fire the callback to simulate the browser
    // resolving after the user navigated away.
    let captured: PositionCallback | undefined;
    const getCurrentPosition = vi.fn((ok: PositionCallback) => {
      captured = ok;
    });
    stubGeolocation({ getCurrentPosition });

    const { unmount } = renderMap();
    fireEvent.click(screen.getByLabelText('Show my location'));
    expect(captured).toBeDefined();

    unmount();
    captured!({
      coords: {
        latitude: 99,
        longitude: 99,
        accuracy: 50,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    } as GeolocationPosition);

    // The abort guard short-circuits the callback — no flyTo on a
    // disposed map.
    expect(mockMap.flyTo).not.toHaveBeenCalled();
  });

  it('shows a denied tooltip when geolocation rejects, without flying the map', () => {
    const getCurrentPosition = vi.fn((_ok: PositionCallback, err?: PositionErrorCallback) => {
      err?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1 } as GeolocationPositionError);
    });
    stubGeolocation({ getCurrentPosition });

    renderMap();
    const btn = screen.getByLabelText('Show my location');
    fireEvent.click(btn);

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(mockMap.flyTo).not.toHaveBeenCalled();
    expect(btn.title).toBe('Location blocked — allow in browser site settings');
  });

  it('short-circuits via Permissions API when geolocation was previously denied', async () => {
    // Reproduces the T6 manual-test bug: after a prior deny, the browser
    // rejects getCurrentPosition synchronously with no UI feedback. The
    // Permissions API pre-check catches this and flashes the actionable
    // tooltip without spinning the busy indicator on/off invisibly.
    const getCurrentPosition = vi.fn();
    stubGeolocation({ getCurrentPosition });
    stubPermissions('denied');

    renderMap();
    const btn = screen.getByLabelText('Show my location');
    fireEvent.click(btn);

    // The handler is async — wait for the pre-check microtask to flush
    // before asserting the tooltip transitioned.
    await waitFor(() => {
      expect(btn.title).toBe('Location blocked — allow in browser site settings');
    });
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(mockMap.flyTo).not.toHaveBeenCalled();
    expect(btn.classList.contains('hf-locate-btn--busy')).toBe(false);
  });

  it('guards against a synchronous double-click during the Permissions API query', async () => {
    // The Permissions API query is async — without a busy guard claimed
    // *before* the await, a fast second click sails past the `if (busy)`
    // check and double-invokes getCurrentPosition. We control when the
    // query resolves so the race window is wide open during the second
    // click.
    const getCurrentPosition = vi.fn((ok: PositionCallback) => {
      ok({
        coords: {
          latitude: 1,
          longitude: 2,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    stubGeolocation({ getCurrentPosition });

    let resolveQuery!: (status: { state: PermissionState }) => void;
    const queryPromise = new Promise<{ state: PermissionState }>((r) => {
      resolveQuery = r;
    });
    Object.defineProperty(globalThis.navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockReturnValue(queryPromise) },
    });

    renderMap();
    const btn = screen.getByLabelText('Show my location');
    fireEvent.click(btn);
    fireEvent.click(btn); // race: second click while the first query is in flight

    resolveQuery({ state: 'prompt' });
    await waitFor(() => {
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    });
  });

  it('proceeds to getCurrentPosition when Permissions API reports prompt state', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) => {
      ok({
        coords: {
          latitude: 1,
          longitude: 2,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    stubGeolocation({ getCurrentPosition });
    stubPermissions('prompt');

    renderMap();
    fireEvent.click(screen.getByLabelText('Show my location'));

    await waitFor(() => {
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    });
    expect(mockMap.flyTo).toHaveBeenCalledWith([1, 2], 14, { duration: 1.5 });
  });
});

describe('MapView userLocationHint', () => {
  it('flies to the hint at regional zoom when it arrives', () => {
    const { rerender } = render(
      <LanguageProvider>
        <MapView
          modules={[]}
          selectedModule={null}
          onModuleSelect={() => undefined}
          userLocationHint={null}
        />
      </LanguageProvider>,
    );
    expect(mockMap.flyTo).not.toHaveBeenCalled();

    rerender(
      <LanguageProvider>
        <MapView
          modules={[]}
          selectedModule={null}
          onModuleSelect={() => undefined}
          userLocationHint={{ lat: 48.137, lng: 11.575 }}
        />
      </LanguageProvider>,
    );

    expect(mockMap.flyTo).toHaveBeenCalledWith([48.137, 11.575], 11, { duration: 1.5 });
  });
});

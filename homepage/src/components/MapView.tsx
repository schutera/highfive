import { MapContainer, TileLayer, useMap, Circle, useMapEvents, Marker } from 'react-leaflet';
import L from 'leaflet';
// Co-located stylesheet so it ships in the dashboard's lazy chunk only.
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Module, UserLocation } from '@highfive/contracts';
import { useTranslation } from '../i18n/LanguageContext';

// Create a badge icon for clusters
function createBadgeIcon(count: number, hasOnline: boolean) {
  const color = hasOnline ? '#f59e0b' : '#94a3b8';
  return L.divIcon({
    className: 'cluster-badge',
    html: `
      <div style="
        background-color: ${color};
        color: white;
        font-weight: bold;
        border-radius: 50%;
        width: 50px;
        height: 50px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        border: 3px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: pointer;
      ">
        ${count}
      </div>
    `,
    iconSize: [50, 50],
    iconAnchor: [25, 25],
  });
}

// Custom amber marker for online modules
const AmberIcon = L.divIcon({
  className: 'custom-marker',
  html: `
    <svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.5 0C5.6 0 0 5.6 0 12.5c0 8.4 12.5 28.5 12.5 28.5S25 20.9 25 12.5C25 5.6 19.4 0 12.5 0z" 
            fill="#f59e0b" stroke="#d97706" stroke-width="1"/>
      <circle cx="12.5" cy="12.5" r="6" fill="white"/>
      <circle cx="12.5" cy="12.5" r="3" fill="#f59e0b"/>
    </svg>
  `,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// (GrayIcon was previously defined here for offline modules but is no
// longer rendered — clusters use a count-badge icon for both states.
// Kept intentionally removed to satisfy noUnusedLocals.)

// Function to add random offset within ~1km radius for data protection
function fuzzLocation(location: { lat: number; lng: number }, moduleId: string): [number, number] {
  // Use module ID as seed for consistent fuzzing
  const seed = moduleId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

  // Pseudo-random based on seed
  const random1 = Math.sin(seed * 12.9898) * 43758.5453;
  const random2 = Math.sin(seed * 78.233) * 43758.5453;

  const offsetLat = (random1 - Math.floor(random1)) * 0.018 - 0.009; // ~1km
  const offsetLng = (random2 - Math.floor(random2)) * 0.018 - 0.009; // ~1km

  return [location.lat + offsetLat, location.lng + offsetLng];
}

// Interpolate between colors based on hatches
// emerald → amber → rose gradient for nature/activity visualization
function getColorFromHatches(totalHatches: number, maxHatches: number = 1000): string {
  const normalized = Math.min(totalHatches / maxHatches, 1);

  const colors = [
    { r: 0x34, g: 0xd3, b: 0x99 }, // #34d399 - emerald-400 (low activity)
    { r: 0xf5, g: 0x9e, b: 0x0b }, // #f59e0b - amber-500 (mid activity)
    { r: 0xf4, g: 0x3f, b: 0x5e }, // #f43f5e - rose-500 (high activity)
  ];

  // Determine which two colors to interpolate between
  let t: number;
  let c1: (typeof colors)[0];
  let c2: (typeof colors)[0];

  if (normalized < 0.5) {
    t = normalized * 2; // 0-1 for first half
    c1 = colors[0];
    c2 = colors[1];
  } else {
    t = (normalized - 0.5) * 2; // 0-1 for second half
    c1 = colors[1];
    c2 = colors[2];
  }

  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Calculate distance between two points in km
function getDistance(loc1: [number, number], loc2: [number, number]): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((loc2[0] - loc1[0]) * Math.PI) / 180;
  const dLon = ((loc2[1] - loc1[1]) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((loc1[0] * Math.PI) / 180) *
      Math.cos((loc2[0] * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Cluster modules that are within 12km of each other
function clusterModules(
  modules: Array<Module & { fuzzedLocation: [number, number] }>,
  clusterThreshold: number = 12,
) {
  const clusters: Array<Array<Module & { fuzzedLocation: [number, number] }>> = [];
  const processed = new Set<string>();

  modules.forEach((module) => {
    if (processed.has(module.id)) return;

    const cluster = [module];
    processed.add(module.id);

    modules.forEach((other) => {
      if (processed.has(other.id)) return;

      // Check if this module is close to any module in the current cluster
      const isClose = cluster.some(
        (clusterModule) =>
          getDistance(clusterModule.fuzzedLocation, other.fuzzedLocation) < clusterThreshold,
      );

      if (isClose) {
        cluster.push(other);
        processed.add(other.id);
      }
    });

    clusters.push(cluster);
  });

  return clusters;
}

// Calculate centroid of a cluster
function getClusterCenter(cluster: Array<{ fuzzedLocation: [number, number] }>): [number, number] {
  const lat = cluster.reduce((sum, m) => sum + m.fuzzedLocation[0], 0) / cluster.length;
  const lng = cluster.reduce((sum, m) => sum + m.fuzzedLocation[1], 0) / cluster.length;
  return [lat, lng];
}

L.Marker.prototype.options.icon = AmberIcon;

interface MapViewProps {
  modules: Module[];
  selectedModule: Module | null;
  onModuleSelect: (module: Module) => void;
  onVisibleModulesChange?: (modules: Module[]) => void;
  // Permissionless IP-based location hint (issue #14). When this changes
  // from null to a value the map flies to it at regional zoom — at most
  // once. Subsequent map moves (user pan, module-selected flyTo) are
  // unaffected. Null means "no hint" → keep the default centre.
  userLocationHint?: UserLocation | null;
}

// Component to track zoom level and handle map interactions
function MapController({
  selectedModule,
  selectedFuzzedLocation,
  userLocationHint,
  onZoomChange,
  onBoundsChange,
}: {
  selectedModule: Module | null;
  selectedFuzzedLocation: [number, number] | null;
  userLocationHint: UserLocation | null | undefined;
  onZoomChange: (zoom: number) => void;
  onBoundsChange: (bounds: L.LatLngBounds) => void;
}) {
  const map = useMap();
  // The hint should recentre the map at most once — if the user has
  // already panned/zoomed (or selected a module) by the time the hint
  // arrives, we'd be yanking their viewport. Ref instead of state so the
  // gate doesn't trigger a re-render.
  const hintApplied = useRef(false);

  useMapEvents({
    zoomend: () => {
      onZoomChange(map.getZoom());
      onBoundsChange(map.getBounds());
    },
    moveend: () => {
      onBoundsChange(map.getBounds());
    },
  });

  useEffect(() => {
    // Initial bounds
    onBoundsChange(map.getBounds());
  }, []);

  useEffect(() => {
    if (selectedModule && selectedFuzzedLocation) {
      // Zoom to level 14 to show the full 1km circle
      map.flyTo(selectedFuzzedLocation, 14, {
        duration: 1.5,
      });
      // Selecting a module is a deliberate user intent — don't override it
      // with a late-arriving IP-geo hint.
      hintApplied.current = true;
    }
  }, [selectedModule, selectedFuzzedLocation, map]);

  useEffect(() => {
    if (userLocationHint && !hintApplied.current) {
      hintApplied.current = true;
      map.flyTo([userLocationHint.lat, userLocationHint.lng], 11, {
        duration: 1.5,
      });
    }
  }, [userLocationHint, map]);

  return null;
}

// Material-Design "my_location" SVG — visually the same icon Google Maps
// uses for its locate-me button.
const LOCATE_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="currentColor">
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>
  </svg>
`;

// Imperative Leaflet control rendered into MapContainer's corner. Sits
// outside React's DOM tree (Leaflet appends to the map's control pane),
// so it can't use hooks — state is managed via plain DOM mutation. The
// click handler runs `navigator.geolocation.getCurrentPosition` and
// flies the map to the precise (permission-gated) GPS fix.
function LocateControl() {
  const map = useMap();
  const { t } = useTranslation();

  useEffect(() => {
    const idleTitle = t('dashboard.locateMe');
    const deniedTitle = t('dashboard.locateMeDenied');
    const unsupportedTitle = t('dashboard.locateMeUnsupported');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hf-locate-btn';
    button.setAttribute('aria-label', idleTitle);
    button.title = idleTitle;
    button.innerHTML = LOCATE_ICON_SVG;

    let busy = false;
    let resetTitle: number | undefined;
    // Geolocation callbacks fire asynchronously — the user can navigate
    // away or switch language (which tears down this effect) before the
    // browser resolves the request. Without an abort guard the callbacks
    // would touch a detached button and call `map.flyTo` on a disposed
    // Leaflet instance, the latter of which throws in real browsers.
    let aborted = false;

    const setTitle = (label: string) => {
      button.title = label;
      button.setAttribute('aria-label', label);
    };

    const onClick = (e: Event) => {
      e.stopPropagation();
      if (busy) return;
      if (!('geolocation' in navigator)) {
        setTitle(unsupportedTitle);
        clearTimeout(resetTitle);
        resetTitle = window.setTimeout(() => {
          if (aborted) return;
          setTitle(idleTitle);
        }, 3000);
        return;
      }
      busy = true;
      button.classList.add('hf-locate-btn--busy');
      button.setAttribute('aria-busy', 'true');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (aborted) return;
          busy = false;
          button.classList.remove('hf-locate-btn--busy');
          button.removeAttribute('aria-busy');
          map.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 1.5 });
        },
        () => {
          if (aborted) return;
          busy = false;
          button.classList.remove('hf-locate-btn--busy');
          button.removeAttribute('aria-busy');
          setTitle(deniedTitle);
          clearTimeout(resetTitle);
          resetTitle = window.setTimeout(() => {
            if (aborted) return;
            setTitle(idleTitle);
          }, 3000);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
      );
    };

    button.addEventListener('click', onClick);

    const LocateControlImpl = L.Control.extend({
      options: { position: 'topright' as L.ControlPosition },
      onAdd() {
        // Stop click/scroll from bubbling into the map's pan/zoom handlers.
        L.DomEvent.disableClickPropagation(button);
        L.DomEvent.disableScrollPropagation(button);
        return button;
      },
    });
    const control = new LocateControlImpl();
    map.addControl(control);

    return () => {
      aborted = true;
      button.removeEventListener('click', onClick);
      clearTimeout(resetTitle);
      map.removeControl(control);
    };
  }, [map, t]);

  return null;
}

// Component for rendering a cluster
function ClusterMarker({
  cluster,
  clusterCenter,
  onModuleSelect,
  clusterZoomThreshold,
  maxHatches,
}: {
  cluster: Array<Module & { fuzzedLocation: [number, number] }>;
  clusterCenter: [number, number];
  onModuleSelect: (module: Module) => void;
  clusterZoomThreshold: number;
  maxHatches: number;
}) {
  const map = useMap();
  const onlineCount = cluster.filter((m) => m.status === 'online').length;
  const hasOnline = onlineCount > 0;
  // Sum total hatches for the cluster
  const clusterTotalHatches = cluster.reduce((sum, m) => sum + (m.totalHatches || 0), 0);
  const clusterColor = hasOnline
    ? getColorFromHatches(clusterTotalHatches, maxHatches * cluster.length)
    : '#94a3b8';

  const handleClick = () => {
    map.flyTo(clusterCenter, clusterZoomThreshold + 1, {
      duration: 1.5,
    });
  };

  if (cluster.length > 1) {
    return (
      <>
        <Circle
          center={clusterCenter}
          radius={21000}
          pathOptions={{
            color: clusterColor,
            fillColor: clusterColor,
            fillOpacity: 0.2,
            weight: 3,
            opacity: 1,
          }}
          eventHandlers={{ click: handleClick }}
        />
        <Marker
          position={clusterCenter}
          icon={createBadgeIcon(onlineCount, hasOnline)}
          eventHandlers={{ click: handleClick }}
        />
      </>
    );
  }

  // Single module - show circle with badge count of 1 if online, 0 if offline
  const singleOnlineCount = cluster[0].status === 'online' ? 1 : 0;
  const singleHasOnline = cluster[0].status === 'online';
  const singleColor = singleHasOnline
    ? getColorFromHatches(cluster[0].totalHatches || 0, maxHatches)
    : '#94a3b8';

  return (
    <>
      <Circle
        center={cluster[0].fuzzedLocation}
        radius={3000}
        pathOptions={{
          color: singleColor,
          fillColor: singleColor,
          fillOpacity: 0.2,
          weight: 2,
          opacity: 1,
        }}
        eventHandlers={{
          click: () => onModuleSelect(cluster[0]),
        }}
      />
      <Marker
        position={cluster[0].fuzzedLocation}
        icon={createBadgeIcon(singleOnlineCount, singleHasOnline)}
        eventHandlers={{
          click: () => onModuleSelect(cluster[0]),
        }}
      />
    </>
  );
}

export default function MapView({
  modules,
  selectedModule,
  onModuleSelect,
  onVisibleModulesChange,
  userLocationHint,
}: MapViewProps) {
  const [zoom, setZoom] = useState(13);
  const [bounds, setBounds] = useState<L.LatLngBounds | null>(null);
  const CLUSTER_ZOOM_THRESHOLD = 13; // Show clusters below this zoom level

  // Center map on first module or default location
  const center: [number, number] = modules[0]?.location
    ? [modules[0].location.lat, modules[0].location.lng]
    : [47.78, 9.61];

  // Memoize fuzzed locations to keep them consistent
  const fuzzedModules = useMemo(
    () =>
      modules.map((module) => ({
        ...module,
        fuzzedLocation: fuzzLocation(module.location, module.id),
      })),
    [modules],
  );

  // Filter modules visible in current map bounds
  const visibleModules = useMemo(() => {
    if (!bounds) return modules;
    return fuzzedModules.filter((module) =>
      bounds.contains(L.latLng(module.fuzzedLocation[0], module.fuzzedLocation[1])),
    );
  }, [bounds, fuzzedModules, modules]);

  // Notify parent of visible modules
  useEffect(() => {
    if (onVisibleModulesChange && bounds) {
      onVisibleModulesChange(visibleModules);
    }
  }, [visibleModules, onVisibleModulesChange, bounds]);

  // Create clusters
  const clusters = useMemo(() => clusterModules(fuzzedModules), [fuzzedModules]);

  // Calculate max hatches for normalization
  const maxHatches = useMemo(
    () => Math.max(...modules.map((m) => m.totalHatches || 0), 1),
    [modules],
  );

  const showClusters = zoom < CLUSTER_ZOOM_THRESHOLD;

  return (
    <MapContainer
      center={center}
      zoom={13}
      className="h-full w-full"
      style={{ height: '100%', width: '100%' }}
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <MapController
        selectedModule={selectedModule}
        selectedFuzzedLocation={
          selectedModule
            ? fuzzedModules.find((m) => m.id === selectedModule.id)?.fuzzedLocation || null
            : null
        }
        userLocationHint={userLocationHint ?? null}
        onZoomChange={setZoom}
        onBoundsChange={setBounds}
      />

      <LocateControl />

      {showClusters
        ? // Show clustered circles with badges
          clusters.map((cluster, idx) => (
            <ClusterMarker
              key={`cluster-${idx}`}
              cluster={cluster}
              clusterCenter={getClusterCenter(cluster)}
              onModuleSelect={onModuleSelect}
              clusterZoomThreshold={CLUSTER_ZOOM_THRESHOLD}
              maxHatches={maxHatches}
            />
          ))
        : // Show individual circles when zoomed in
          fuzzedModules.map((module) => {
            const circleColor =
              module.status === 'online'
                ? getColorFromHatches(module.totalHatches || 0, maxHatches)
                : '#94a3b8';
            return (
              <Circle
                key={module.id}
                center={module.fuzzedLocation}
                radius={1000}
                pathOptions={{
                  color: circleColor,
                  fillColor: circleColor,
                  fillOpacity: 0.2,
                  weight: 2,
                  opacity: 1,
                }}
                eventHandlers={{
                  click: () => onModuleSelect(module),
                }}
              />
            );
          })}
    </MapContainer>
  );
}

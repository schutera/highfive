import { MapContainer, TileLayer, useMap, Circle, useMapEvents, Marker } from 'react-leaflet';
import L from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { Module } from '../services/api';

// Create a badge icon for clusters
function createBadgeIcon(count: number, hasOnline: boolean) {
  const color = hasOnline ? '#f59e0b' : '#9ca3af';
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

// Gray marker for offline modules
const GrayIcon = L.divIcon({
  className: 'custom-marker',
  html: `
    <svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.5 0C5.6 0 0 5.6 0 12.5c0 8.4 12.5 28.5 12.5 28.5S25 20.9 25 12.5C25 5.6 19.4 0 12.5 0z" 
            fill="#9ca3af" stroke="#6b7280" stroke-width="1"/>
      <circle cx="12.5" cy="12.5" r="6" fill="white"/>
      <circle cx="12.5" cy="12.5" r="3" fill="#6b7280"/>
    </svg>
  `,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

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

// Calculate distance between two points in km
function getDistance(loc1: [number, number], loc2: [number, number]): number {
  const R = 6371; // Earth's radius in km
  const dLat = (loc2[0] - loc1[0]) * Math.PI / 180;
  const dLon = (loc2[1] - loc1[1]) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(loc1[0] * Math.PI / 180) * Math.cos(loc2[0] * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Cluster modules that are within 12km of each other
function clusterModules(modules: Array<Module & { fuzzedLocation: [number, number] }>, clusterThreshold: number = 12) {
  const clusters: Array<Array<Module & { fuzzedLocation: [number, number] }>> = [];
  const processed = new Set<string>();
  
  modules.forEach(module => {
    if (processed.has(module.id)) return;
    
    const cluster = [module];
    processed.add(module.id);
    
    modules.forEach(other => {
      if (processed.has(other.id)) return;
      
      // Check if this module is close to any module in the current cluster
      const isClose = cluster.some(clusterModule => 
        getDistance(clusterModule.fuzzedLocation, other.fuzzedLocation) < clusterThreshold
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
}

// Component to track zoom level and handle map interactions
function MapController({ 
  selectedModule,
  selectedFuzzedLocation,
  onZoomChange,
  onBoundsChange
}: { 
  selectedModule: Module | null;
  selectedFuzzedLocation: [number, number] | null;
  onZoomChange: (zoom: number) => void;
  onBoundsChange: (bounds: L.LatLngBounds) => void;
}) {
  const map = useMap();
  
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
        duration: 1.5
      });
    }
  }, [selectedModule, selectedFuzzedLocation, map]);
  
  return null;
}

// Component for rendering a cluster
function ClusterMarker({ 
  cluster, 
  clusterCenter, 
  onModuleSelect,
  clusterZoomThreshold 
}: { 
  cluster: Array<Module & { fuzzedLocation: [number, number] }>;
  clusterCenter: [number, number];
  onModuleSelect: (module: Module) => void;
  clusterZoomThreshold: number;
}) {
  const map = useMap();
  const onlineCount = cluster.filter(m => m.status === 'online').length;
  const hasOnline = onlineCount > 0;

  const handleClick = () => {
    map.flyTo(clusterCenter, clusterZoomThreshold + 1, {
      duration: 1.5
    });
  };

  if (cluster.length > 1) {
    return (
      <>
        <Circle
          center={clusterCenter}
          radius={7000}
          pathOptions={{
            color: hasOnline ? '#f59e0b' : '#9ca3af',
            fillColor: hasOnline ? '#f59e0b' : '#9ca3af',
            fillOpacity: 0.25,
            weight: 3,
            opacity: 0.8,
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
  
  return (
    <>
      <Circle
        center={cluster[0].fuzzedLocation}
        radius={1000}
        pathOptions={{
          color: cluster[0].status === 'online' ? '#f59e0b' : '#9ca3af',
          fillColor: cluster[0].status === 'online' ? '#f59e0b' : '#9ca3af',
          fillOpacity: 0.25,
          weight: 2,
          opacity: 0.7,
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

export default function MapView({ modules, selectedModule, onModuleSelect, onVisibleModulesChange }: MapViewProps) {
  const [zoom, setZoom] = useState(13);
  const [bounds, setBounds] = useState<L.LatLngBounds | null>(null);
  const CLUSTER_ZOOM_THRESHOLD = 13; // Show clusters below this zoom level
  
  // Center map on first module or default location
  const center: [number, number] = modules[0]?.location ? [modules[0].location.lat, modules[0].location.lng] : [51.505, -0.09];

  // Memoize fuzzed locations to keep them consistent
  const fuzzedModules = useMemo(() => 
    modules.map(module => ({
      ...module,
      fuzzedLocation: fuzzLocation(module.location, module.id)
    })),
    [modules]
  );

  // Filter modules visible in current map bounds
  const visibleModules = useMemo(() => {
    if (!bounds) return modules;
    return fuzzedModules.filter(module => 
      bounds.contains(L.latLng(module.fuzzedLocation[0], module.fuzzedLocation[1]))
    );
  }, [bounds, fuzzedModules, modules]);

  // Notify parent of visible modules
  useEffect(() => {
    if (onVisibleModulesChange && bounds) {
      onVisibleModulesChange(visibleModules);
    }
  }, [visibleModules, onVisibleModulesChange, bounds]);

  // Create clusters
  const clusters = useMemo(() => 
    clusterModules(fuzzedModules),
    [fuzzedModules]
  );

  const showClusters = zoom < CLUSTER_ZOOM_THRESHOLD;

  return (
    <MapContainer
      center={center}
      zoom={13}
      className="h-full w-full"
      style={{ height: '100%', width: '100%' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      
      <MapController 
        selectedModule={selectedModule}
        selectedFuzzedLocation={selectedModule ? fuzzedModules.find(m => m.id === selectedModule.id)?.fuzzedLocation || null : null}
        onZoomChange={setZoom}
        onBoundsChange={setBounds}
      />
      
      {showClusters ? (
        // Show clustered circles with badges
        clusters.map((cluster, idx) => (
          <ClusterMarker
            key={`cluster-${idx}`}
            cluster={cluster}
            clusterCenter={getClusterCenter(cluster)}
            onModuleSelect={onModuleSelect}
            clusterZoomThreshold={CLUSTER_ZOOM_THRESHOLD}
          />
        ))
      ) : (
        // Show individual circles when zoomed in
        fuzzedModules.map((module) => (
          <Circle
            key={module.id}
            center={module.fuzzedLocation}
            radius={1000}
            pathOptions={{
              color: module.status === 'online' ? '#f59e0b' : '#9ca3af',
              fillColor: module.status === 'online' ? '#f59e0b' : '#9ca3af',
              fillOpacity: 0.25,
              weight: 2,
              opacity: 0.7,
            }}
            eventHandlers={{
              click: () => onModuleSelect(module),
            }}
          />
        ))
      )}
    </MapContainer>
  );
}

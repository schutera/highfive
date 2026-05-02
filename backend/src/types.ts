export interface HeartbeatSnapshot {
  receivedAt: string; // ISO timestamp
  battery: number | null;
  rssi: number | null;
  uptimeMs: number | null;
  freeHeap: number | null;
  fwVersion: string | null;
}

export interface Module {
  id: string;
  name: string;
  location: {
    lat: number;
    lng: number;
  };
  status: 'online' | 'offline';
  lastApiCall: string; // ISO date string
  batteryLevel: number;
  firstOnline: string; // ISO date string
  totalHatches: number; // Sum of all hatches across all nests
  imageCount: number; // Total images uploaded by this module
  email: string | null;
  updatedAt?: string; // ISO timestamp — set on every registration/UPSERT
  // Liveness — derived from max(updatedAt, lastApiCall, latestHeartbeat.receivedAt).
  // If null, the module has never phoned home.
  lastSeenAt?: string | null;
  latestHeartbeat?: HeartbeatSnapshot | null;
}

export interface NestData {
  nest_id: string;
  module_id: string;
  beeType: 'blackmasked' | 'resin' | 'leafcutter' | 'orchard';
  dailyProgress: DailyProgress[];
}

export interface DailyProgress {
  progress_id: string;
  nest_id: string;
  date: string; // ISO date string
  empty: number;
  sealed: number;
  hatched: number;
}

export interface ModuleDetail extends Module {
  nests: NestData[];
}

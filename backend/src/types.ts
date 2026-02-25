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

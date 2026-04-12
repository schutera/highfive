const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002/api';

export interface Module {
  id: string;
  name: string;
  location: {
    lat: number;
    lng: number;
  };
  status: 'online' | 'offline';
  lastApiCall: string;
  batteryLevel: number;
  totalHatches: number;
  imageCount: number;
}

export interface NestData {
  nestId: number;
  beeType: 'blackmasked' | 'resin' | 'leafcutter' | 'orchard';
  dailyProgress: DailyProgress[];
}

export interface DailyProgress {
  date: string;
  empty: number;
  sealed: number;
  hatched: number;
}

export interface ModuleDetail extends Module {
  nests: NestData[];
}

export interface TelemetryEntry {
  fw?: string;
  uptime_s?: number;
  last_reset_reason?: string;
  free_heap?: number;
  min_free_heap?: number;
  rssi?: number;
  wifi_reconnects?: number;
  last_http_codes?: number[];
  log?: string;
  _received_at?: string;
  _image?: string;
}

// API key for authentication - in production, this should come from environment variables
const API_KEY = import.meta.env.VITE_API_KEY || 'hf_dev_key_2026';

class ApiService {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string = API_BASE_URL, apiKey: string = API_KEY) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
    };
  }

  async getAllModules(): Promise<Module[]> {
    const response = await fetch(`${this.baseUrl}/modules`, {
    //const response = await fetch(`localhost:8002/modules`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error('Failed to fetch modules');
    }
    return response.json();
  }

  async getModuleById(id: string): Promise<ModuleDetail> {
    const response = await fetch(`${this.baseUrl}/modules/${id}`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch module ${id}`);
    }
    return response.json();
  }

  async getModuleLogs(id: string, limit: number = 10): Promise<TelemetryEntry[]> {
    const adminKey = typeof window !== 'undefined' ? sessionStorage.getItem('hf_admin_key') : null;
    const headers: Record<string, string> = { ...(this.getHeaders() as Record<string, string>) };
    if (adminKey) headers['X-Admin-Key'] = adminKey;
    const response = await fetch(`${this.baseUrl}/modules/${id}/logs?limit=${limit}`, {
      headers,
    });
    if (response.status === 401 || response.status === 403) {
      if (typeof window !== 'undefined') sessionStorage.removeItem('hf_admin_key');
      throw new Error('unauthorized');
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch logs for module ${id}`);
    }
    return response.json();
  }

  async updateModuleStatus(id: string, status: 'online' | 'offline'): Promise<void> {
    const response = await fetch(`${this.baseUrl}/modules/${id}/status`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      throw new Error(`Failed to update module ${id} status`);
    }
  }

  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    // Health check doesn't require auth
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error('Health check failed');
    }
    return response.json();
  }
}

export const api = new ApiService();

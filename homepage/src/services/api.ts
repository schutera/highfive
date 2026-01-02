const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

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

class ApiService {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  async getAllModules(): Promise<Module[]> {
    const response = await fetch(`${this.baseUrl}/modules`);
    if (!response.ok) {
      throw new Error('Failed to fetch modules');
    }
    return response.json();
  }

  async getModuleById(id: string): Promise<ModuleDetail> {
    const response = await fetch(`${this.baseUrl}/modules/${id}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch module ${id}`);
    }
    return response.json();
  }

  async updateModuleStatus(id: string, status: 'online' | 'offline'): Promise<void> {
    const response = await fetch(`${this.baseUrl}/modules/${id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      throw new Error(`Failed to update module ${id} status`);
    }
  }

  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error('Health check failed');
    }
    return response.json();
  }
}

export const api = new ApiService();

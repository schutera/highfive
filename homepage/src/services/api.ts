const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

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
  firstOnline: string;
  totalHatches: number;
  imageCount: number;
  email: string | null;
  updatedAt?: string;
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

export interface ImageUpload {
  module_id: string;
  filename: string;
  uploaded_at: string;
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

  async deleteModule(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/modules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to delete module ${id}`);
    }
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

  async getImages(moduleId?: string): Promise<ImageUpload[]> {
    const url = moduleId
      ? `${this.baseUrl}/images?module_id=${encodeURIComponent(moduleId)}`
      : `${this.baseUrl}/images`;
    const response = await fetch(url, {
      headers: this.getHeaders(),
    });
    if (!response.ok) throw new Error('Failed to fetch images');
    const data = await response.json();
    return data.images;
  }

  async deleteImage(filename: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/images/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!response.ok) throw new Error('Failed to delete image');
  }

  getImageUrl(filename: string): string {
    return `${this.baseUrl}/images/${encodeURIComponent(filename)}`;
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

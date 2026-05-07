import type { Module, ModuleDetail } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';

// Fail loudly on production builds with empty/missing build-args - the
// dev fallbacks below would otherwise silently bake the dev key + dev
// API URL into a prod bundle (e.g. a standalone `docker build` without
// --build-arg). docker-compose.prod.yml already rejects empty values
// upstream via ${VAR:?msg}, but this guards direct-build paths too.
if (import.meta.env.PROD && (!import.meta.env.VITE_API_URL || !import.meta.env.VITE_API_KEY)) {
  throw new Error('VITE_API_URL and VITE_API_KEY must be set at build time for production builds');
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002/api';

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
    const data: unknown = await response.json();
    return (data as Array<Record<string, unknown>>).map((raw) => ({
      ...raw,
      id: parseModuleId(raw.id as string),
    })) as Module[];
  }

  async getModuleById(id: string): Promise<ModuleDetail> {
    const response = await fetch(`${this.baseUrl}/modules/${id}`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch module ${id}`);
    }
    const raw: unknown = await response.json();
    const obj = raw as Record<string, unknown>;
    return {
      ...obj,
      id: parseModuleId(obj.id as string),
    } as ModuleDetail;
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

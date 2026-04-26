import type { Module, ModuleDetail, NestData, DailyProgress } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';

export type { Module, ModuleDetail, NestData, DailyProgress };

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

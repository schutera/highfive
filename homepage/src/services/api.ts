import type { Module, ModuleDetail, TelemetryEntry } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';
// The build-time validator + DEV_FALLBACK_KEY live in their own module
// so main.tsx can side-effect-import them and the throw fires on first
// page load. See ./api-key-validator.ts for the rationale; importing
// here would land them in the lazy api-* chunk and the home-page route
// would not trigger them. Re-exported for unit tests.
import { DEV_FALLBACK_KEY, validateBuildTimeApiKey } from './api-key-validator';

export { DEV_FALLBACK_KEY, validateBuildTimeApiKey };
export type { TelemetryEntry } from '@highfive/contracts';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002/api';

export interface ImageUpload {
  module_id: string;
  filename: string;
  uploaded_at: string;
}

/**
 * Thrown by `api.renameModule()` when the server returns 409 because
 * another module already holds the requested display name. Carries the
 * conflicting MAC so the admin UI can render a useful inline message.
 */
export class RenameConflictError extends Error {
  constructor(
    public readonly displayName: string,
    public readonly conflictingModuleId: string,
  ) {
    super(`display_name "${displayName}" already in use by module ${conflictingModuleId}`);
    this.name = 'RenameConflictError';
  }
}

// API key for authentication - in production, this should come from environment variables
const API_KEY = import.meta.env.VITE_API_KEY || DEV_FALLBACK_KEY;

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
    const { modules } = await this.getAllModulesWithMeta();
    return modules;
  }

  /**
   * Companion to getAllModules() that surfaces the X-Highfive-Data-Incomplete
   * response header. Used by the dashboard to render a banner when the
   * backend couldn't reach the heartbeats endpoint (#31).
   */
  async getAllModulesWithMeta(): Promise<{
    modules: Module[];
    dataIncomplete: { heartbeats: boolean };
  }> {
    const response = await fetch(`${this.baseUrl}/modules`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error('Failed to fetch modules');
    }
    const incompleteHeader = response.headers.get('X-Highfive-Data-Incomplete') ?? '';
    const incompleteParts = incompleteHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const data: unknown = await response.json();
    const modules = (data as Array<Record<string, unknown>>).map((raw) => ({
      ...raw,
      id: parseModuleId(raw.id as string),
    })) as Module[];
    return {
      modules,
      dataIncomplete: { heartbeats: incompleteParts.includes('heartbeats') },
    };
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

  /**
   * Set or clear the admin-settable display-name override for a module.
   * Pass `null` (or empty string) to clear. Reuses the `hf_admin_key`
   * sessionStorage plumbing established by `getModuleLogs` — on 401/403
   * we clear the stored key and throw `'unauthorized'` so the caller
   * can re-prompt. On 409 we throw a `RenameConflictError` carrying the
   * conflicting MAC so the UI can render an inline message.
   * See backend route `PATCH /api/modules/:id/name` and ADR-011.
   */
  async renameModule(id: string, displayName: string | null): Promise<void> {
    const adminKey = typeof window !== 'undefined' ? sessionStorage.getItem('hf_admin_key') : null;
    const headers: Record<string, string> = { ...(this.getHeaders() as Record<string, string>) };
    if (adminKey) headers['X-Admin-Key'] = adminKey;
    const response = await fetch(`${this.baseUrl}/modules/${encodeURIComponent(id)}/name`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ display_name: displayName }),
    });
    if (response.status === 401 || response.status === 403) {
      if (typeof window !== 'undefined') sessionStorage.removeItem('hf_admin_key');
      throw new Error('unauthorized');
    }
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        display_name?: string;
        conflicting_module_id?: string;
      };
      throw new RenameConflictError(
        body.display_name ?? displayName ?? '',
        body.conflicting_module_id ?? '',
      );
    }
    if (!response.ok) {
      throw new Error(`Failed to rename module ${id}`);
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

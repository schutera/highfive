import type { Module, ModuleDetail, TelemetryEntry } from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';

// The dev fallback. Named once so the validator and the fallback expression
// below cannot drift. Public string by design (documented in CLAUDE.md and
// .env.example); safe only in dev builds where the validator below allows it.
const DEV_FALLBACK_KEY = 'hf_dev_key_2026';

/**
 * Validator for `VITE_API_KEY`. Throws on prod builds when the
 * key is absent OR (case-insensitively) the public dev fallback.
 *
 * Runs at module-load time in the bundle (i.e. first time the browser
 * imports this file), not at `vite build` time. Vite inlines
 * `import.meta.env.VITE_API_KEY` into the bundle as a string literal
 * during transformation; the throw fires when the bundle is loaded.
 * The bundle artifact therefore still contains the literal string for
 * a bad key — acceptable because the dev fallback is public by design
 * (documented in CLAUDE.md). What this guard buys: a misconfigured
 * production deployment fast-fails with a self-describing error at
 * first browser load, instead of a stream of opaque 403s from the
 * symmetric `verifyApiKey` boundary in `backend/src/auth.ts` rejecting
 * every request.
 *
 * Exported as a pure function so tests can exercise the decision logic
 * directly without Vitest env-stubbing (which can't simulate Vite's
 * build-time env inlining).
 */
export function validateBuildTimeApiKey(key: string | undefined, isProd: boolean): void {
  if (!isProd) return;
  // Whitespace-only also counts as unset: the backend's
  // `process.env.HIGHFIVE_API_KEY?.trim() || undefined` coerces a
  // whitespace-only env value to `undefined` and the production guard
  // fires. Matching that reduction here keeps the two halves of the
  // project symmetric — without the `.trim().length === 0` check, a
  // production build with `VITE_API_KEY='   '` would slip through both
  // branches below (whitespace is truthy in JavaScript) and ship a
  // bundle whose API_KEY local resolves to `'   '`, which the backend
  // then rejects with 403 on every request.
  if (!key || key.trim().length === 0) {
    throw new Error(
      'VITE_API_KEY must be set to a non-empty value for production builds. ' +
        '(Throws at module load in the browser, not during `vite build` — ' +
        'see the JSDoc above for the build-time-vs-load-time mechanism.)',
    );
  }
  if (key.trim().toLowerCase() === DEV_FALLBACK_KEY) {
    throw new Error(
      `VITE_API_KEY is set (case-insensitively) to the public dev ` +
        `fallback '${DEV_FALLBACK_KEY}'. Production builds must use a ` +
        `strong secret. See CLAUDE.md "Critical rules" and the symmetric ` +
        `backend guard in backend/src/auth.ts. (Throws at module load in ` +
        `the browser, not during \`vite build\`.)`,
    );
  }
}

// VITE_API_URL guard stays inline — separate concern, separate throw.
// docker-compose.prod.yml already rejects empty values upstream via
// ${VAR:?msg}, but this guards direct-build paths too (e.g. a standalone
// `docker build` without --build-arg).
if (import.meta.env.PROD && !import.meta.env.VITE_API_URL) {
  throw new Error('VITE_API_URL must be set at build time for production builds.');
}
validateBuildTimeApiKey(import.meta.env.VITE_API_KEY, import.meta.env.PROD);

export type { TelemetryEntry } from '@highfive/contracts';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002/api';

export interface ImageUpload {
  module_id: string;
  filename: string;
  uploaded_at: string;
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

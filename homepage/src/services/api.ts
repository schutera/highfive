import type {
  ActivityTimeSeries,
  ImageUploadsPage,
  MeasurementTimeSeries,
  Module,
  ModuleDetail,
  ServerLogService,
  ServerLogsResponse,
  TelemetryEntry,
  UserLocation,
} from '@highfive/contracts';
import { parseModuleId } from '@highfive/contracts';

export type { TelemetryEntry } from '@highfive/contracts';
export type { LogEntry, LogLevel, ServerLogService, ServerLogsResponse } from '@highfive/contracts';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002/api';

// Wire shape lives in the shared contracts package (ADR-004); re-exported
// here so existing `import { ImageUpload } from '../services/api'` sites
// keep working.
export type { ImageUpload, ImageUploadsPage } from '@highfive/contracts';

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

// Auth model (issue #142 / ADR-019): the bundle holds NO secret. Read
// endpoints are public; admin/write actions are gated by an HttpOnly session
// cookie minted by `login()`. Every request therefore uses
// `credentials: 'include'` so that cookie rides along (same-site:
// highfive.schutera.com → api.highfive.schutera.com share schutera.com).
class ApiService {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
    };
  }

  /**
   * Admin login. POSTs the operator key to the backend, which validates it
   * server-side and (on success) sets the HttpOnly session cookie. Returns
   * true on success, false on a wrong key. The key is never stored
   * client-side — only the resulting cookie, which JS cannot read.
   */
  async login(password: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/admin/login`, {
      method: 'POST',
      headers: this.getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ password }),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { authenticated?: boolean };
      return body.authenticated === true;
    }
    return false;
  }

  /** Clear the admin session cookie server-side. */
  async logout(): Promise<void> {
    await fetch(`${this.baseUrl}/admin/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => undefined);
  }

  /** Whether the current browser holds a valid admin session cookie. */
  async checkSession(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/admin/session`, {
        credentials: 'include',
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { authenticated?: boolean };
      return body.authenticated === true;
    } catch {
      return false;
    }
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
      credentials: 'include',
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
      credentials: 'include',
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
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`Failed to delete module ${id}`);
    }
  }

  /**
   * Set or clear the admin-settable display-name override for a module.
   * Pass `null` (or empty string) to clear. Auth rides the admin session
   * cookie (`credentials: 'include'`); on 401/403 we throw `'unauthorized'`
   * so the caller can prompt for login. On 409 we throw a
   * `RenameConflictError` carrying the conflicting MAC so the UI can render
   * an inline message. See backend route `PATCH /api/modules/:id/name`,
   * ADR-011, and ADR-019.
   */
  async renameModule(id: string, displayName: string | null): Promise<void> {
    const response = await fetch(`${this.baseUrl}/modules/${encodeURIComponent(id)}/name`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ display_name: displayName }),
    });
    if (response.status === 401 || response.status === 403) {
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
    const response = await fetch(`${this.baseUrl}/modules/${id}/logs?limit=${limit}`, {
      headers: this.getHeaders(),
      credentials: 'include',
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('unauthorized');
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch logs for module ${id}`);
    }
    return response.json();
  }

  /**
   * Admin-only: tail of a server process's own recent stdout/stderr (#171).
   * Maps to `GET /api/admin/logs?service=…&lines=N`, gated by the admin
   * session cookie (`credentials: 'include'`). Throws `'unauthorized'` on
   * 401/403 so the caller can prompt for login. `lines` is clamped
   * server-side (cap 1000). See ADR-021.
   */
  async getServerLogs(service: ServerLogService, lines: number = 200): Promise<ServerLogsResponse> {
    const url = `${this.baseUrl}/admin/logs?service=${encodeURIComponent(service)}&lines=${lines}`;
    const response = await fetch(url, { headers: this.getHeaders(), credentials: 'include' });
    if (response.status === 401 || response.status === 403) {
      throw new Error('unauthorized');
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch ${service} logs`);
    }
    return response.json();
  }

  /**
   * Bucketed image-upload activity for the dashboard weather chart.
   * Maps to `GET /api/modules/:id/activity` on the backend, which in
   * turn proxies the duckdb-service aggregate. `interval` is `'hourly'`
   * or `'daily'`; `days` is the look-back window (1..90).
   */
  async getActivity(
    id: string,
    interval: 'hourly' | 'daily' = 'hourly',
    days: number = 7,
  ): Promise<ActivityTimeSeries> {
    const url = `${this.baseUrl}/modules/${encodeURIComponent(id)}/activity?interval=${interval}&days=${days}`;
    const response = await fetch(url, { headers: this.getHeaders(), credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Failed to fetch activity for module ${id}`);
    }
    const raw: unknown = await response.json();
    const obj = raw as Record<string, unknown>;
    return {
      ...obj,
      moduleId: parseModuleId(obj.moduleId as string),
    } as ActivityTimeSeries;
  }

  /**
   * Bucketed per-module measurements (issue #110). Maps to
   * `GET /api/modules/:id/measurements` on the backend, which proxies
   * the duckdb-service aggregate. `metric` picks one stream out of the
   * module's many concurrent time series (`battery_pct`, eventually
   * `temperature_c`, `activity_score`, …). `interval` is `'hourly'` or
   * `'daily'`; `days` is the look-back window (1..90).
   *
   * Bucket `value` is `number | null` — `null` is a gap, not a zero
   * (see `MeasurementBucket` docstring in `@highfive/contracts`).
   */
  async getMeasurements(
    id: string,
    metric: string,
    interval: 'hourly' | 'daily' = 'hourly',
    days: number = 7,
  ): Promise<MeasurementTimeSeries> {
    const url = `${this.baseUrl}/modules/${encodeURIComponent(id)}/measurements?metric=${encodeURIComponent(metric)}&interval=${interval}&days=${days}`;
    const response = await fetch(url, { headers: this.getHeaders(), credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Failed to fetch measurements for module ${id}`);
    }
    const raw: unknown = await response.json();
    const obj = raw as Record<string, unknown>;
    return {
      ...obj,
      moduleId: parseModuleId(obj.moduleId as string),
    } as MeasurementTimeSeries;
  }

  /**
   * Fetch a page of image uploads, newest first. Pass `limit`/`offset`
   * for "load more" pagination; omit both to fetch every row (slow on a
   * large table — prefer paging). Returns the `{ images, total }`
   * envelope; `total` is the full count ignoring the page window, so the
   * caller can tell whether more rows remain. The `total` fallback keeps
   * old wire responses (pre-pagination, no `total` field) working.
   */
  async getImages(
    moduleId?: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<ImageUploadsPage> {
    const params = new URLSearchParams();
    if (moduleId) params.set('module_id', moduleId);
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const url = `${this.baseUrl}/images${qs ? `?${qs}` : ''}`;
    const response = await fetch(url, {
      headers: this.getHeaders(),
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to fetch images');
    const data = await response.json();
    return { images: data.images, total: data.total ?? data.images.length };
  }

  async deleteImage(filename: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/images/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
      credentials: 'include',
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

  /**
   * Coarse IP-based user-location hint for the dashboard map (issue #14).
   * Returns null when the backend cannot resolve a useful location — 204
   * for private/loopback IPs (dev), 503 when the upstream IP-geo provider
   * is rate-limited or down, or a network failure reaching the backend
   * itself (e.g. dev stack not running, CORS error). Callers MUST treat
   * null as "no hint" and fall back to the default map centre; this is
   * deliberately not an error path because the dashboard still works
   * without it, and the "backend unreachable" case is the most common
   * failure in dev — letting it bubble as an unhandled rejection would
   * spam the console for no benefit.
   */
  async getUserLocation(): Promise<UserLocation | null> {
    try {
      const response = await fetch(`${this.baseUrl}/user-location`, {
        headers: this.getHeaders(),
        credentials: 'include',
      });
      if (response.status === 204 || !response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }
}

export const api = new ApiService();

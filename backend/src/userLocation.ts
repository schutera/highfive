// IP → coarse geo-location, used by the dashboard map for a permissionless
// "first paint near you" hint (issue #14). The browser's
// `navigator.geolocation` API still does the heavy lifting for precise
// location — this only gets the user roughly in the right region so the
// dashboard doesn't open on Lake Constance for a visitor in Berlin.
//
// Provider: ipapi.co (free tier, no key, ~30 k requests/month/IP). The
// service is reached server-side so we don't ship an API key in the
// homepage bundle. If they rate-limit us or go down, the route returns
// 503 and the frontend silently falls back to the default centre.
//
// `GEO_API_KEY` (Google Geolocation API, used by ESP firmware to
// translate Wi-Fi BSSIDs → coords) cannot be used here: Google's
// `considerIp:true` mode only locates the *caller's* IP, which would be
// this backend's datacenter address, not the visitor's. See
// docs/09-architecture-decisions/adr-009-dashboard-ip-geo-hint.md.

import type { UserLocation } from '@highfive/contracts';

// 1 h. IP → city assignments are stable for hours; refreshing more often
// just burns the free-tier quota without changing the map centre.
const CACHE_TTL_MS = 60 * 60 * 1000;

// Per-replica in-memory cache. Multi-replica deployments will hit the
// upstream once per replica per IP per hour — acceptable; see ADR-009.
// Caveat: entries are only evicted on TTL expiry at read time. Long-
// running single processes with high visitor-IP diversity will see this
// map grow unboundedly. Current traffic doesn't make this practical,
// but consider swapping to an LRU if the backend ever serves a public
// audience at scale.
const cache = new Map<string, { data: UserLocation; expiresAt: number }>();

/**
 * Strip the IPv6-mapped IPv4 prefix (`::ffff:`) Express adds on dual-stack
 * sockets so the cache key and upstream URL use the canonical form.
 */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

/**
 * Returns true for addresses where IP-geolocation cannot produce a useful
 * answer: loopback, link-local, IPv4 RFC-1918 private ranges, and the
 * IPv6 unique-local / link-local equivalents. We short-circuit these to a
 * 204 No Content rather than wasting an upstream call (and exposing
 * "::1" to ipapi.co's logs).
 */
export function isPrivateOrLoopbackIp(rawIp: string): boolean {
  const ip = normalizeIp(rawIp);
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true; // IPv4 link-local
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true; // IPv6 link-local / ULA
  // 172.16.0.0 – 172.31.255.255
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] ?? '', 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export interface UserLocationLookup {
  /** 'hit' (cache), 'miss' (fetched upstream), 'private' (short-circuit), 'unavailable' (upstream failed). */
  source: 'hit' | 'miss' | 'private' | 'unavailable';
  data: UserLocation | null;
}

/**
 * Resolve `ip` to a coarse `UserLocation`. Pure of Express; takes an
 * injected `fetchFn` so the test suite can stub upstream behaviour
 * without monkey-patching globals.
 *
 * Returns `{ source: 'private', data: null }` for loopback/private IPs
 * (dev environments hit this constantly) so the route layer can map it
 * to 204 No Content distinct from the 503 "upstream broken" failure.
 */
export async function lookupUserLocation(
  rawIp: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<UserLocationLookup> {
  const ip = normalizeIp(rawIp);

  if (isPrivateOrLoopbackIp(ip)) {
    return { source: 'private', data: null };
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > now()) {
    return { source: 'hit', data: cached.data };
  }

  // ipapi.co per-IP endpoint. JSON shape: { latitude, longitude, city,
  // country_code, ... , error?, reason? }. Rate-limit responses come as
  // 429 with { error: true, reason: 'RateLimited' }. We treat any non-2xx
  // and any 200-with-error-field as a hard failure.
  let upstream: Response;
  try {
    upstream = await fetchFn(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { 'User-Agent': 'highfive-backend/0 (+https://github.com/schutera/highfive)' },
    });
  } catch {
    return { source: 'unavailable', data: null };
  }

  if (!upstream.ok) {
    return { source: 'unavailable', data: null };
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return { source: 'unavailable', data: null };
  }

  const obj = body as Record<string, unknown>;
  if (obj.error || typeof obj.latitude !== 'number' || typeof obj.longitude !== 'number') {
    return { source: 'unavailable', data: null };
  }

  const data: UserLocation = {
    lat: obj.latitude,
    lng: obj.longitude,
  };

  cache.set(ip, { data, expiresAt: now() + CACHE_TTL_MS });
  return { source: 'miss', data };
}

/** Drop everything in the per-replica cache. Test-only. */
export function _resetUserLocationCache(): void {
  cache.clear();
}

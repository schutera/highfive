// Port-resolution helper, split out from server.ts so tests can import
// it without triggering server.ts's bootstrap() (which binds a socket).
// Same shape as env.ts's split from auth.ts: a pure helper lives where
// it can be exercised in isolation.

// Default 3002 matches the dev compose host:container mapping
// (docker-compose.yml's backend service binds 3002:3002) and the
// homepage's API client (homepage/src/services/api.ts's VITE_API_URL
// default). The legacy 3001 default caused a silent breakage when
// PORT= was dropped from docker-compose.yml — container bound 3001,
// host mapping pointed at 3002, dashboard quietly stopped loading.
// Fixed in commit ea7dc73; this default makes the failure mode
// unreachable: even with PORT unset the binding matches the host map.
export const DEFAULT_PORT = 3002;

/**
 * Resolve the listen port from the env-string and signal whether the
 * caller should warn about an unset PORT.
 *
 * Pure function — caller owns the side effect (console.warn) so the
 * resolution logic stays unit-testable without binding sockets.
 *
 * Treats empty-string and non-numeric values as "unset" — both route
 * to the default plus warning. parseInt prefix-parsing (e.g. '3002junk'
 * yields 3002) is preserved so a botched env value with a stray
 * character still produces a deterministic port rather than NaN.
 */
export function resolvePort(envValue: string | undefined): {
  port: number;
  warned: boolean;
} {
  if (envValue === undefined) {
    return { port: DEFAULT_PORT, warned: true };
  }
  const parsed = parseInt(envValue, 10);
  if (Number.isNaN(parsed)) {
    return { port: DEFAULT_PORT, warned: true };
  }
  return { port: parsed, warned: false };
}

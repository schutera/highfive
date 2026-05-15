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
 * caller should warn about an unset / malformed PORT.
 *
 * Pure function — caller owns the side effect (console.warn) so the
 * resolution logic stays unit-testable without binding sockets.
 *
 * Treats anything that isn't a clean run of digits (after .trim()) as
 * a misconfiguration: default + warn. parseInt prefix-parsing
 * ('3002junk' → 3002) is intentionally NOT accepted as silent success
 * — round-2 review caught the contradiction with the docstring's
 * "warn on misconfig" promise. A stray trailing character almost
 * always indicates a botched env file, and "fail loud, bind the
 * default" is the operator-friendlier shape than "bind the prefix and
 * stay quiet."
 */
export function resolvePort(envValue: string | undefined): {
  port: number;
  warned: boolean;
} {
  if (envValue === undefined) {
    return { port: DEFAULT_PORT, warned: true };
  }
  const trimmed = envValue.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) {
    return { port: DEFAULT_PORT, warned: true };
  }
  return { port: parseInt(trimmed, 10), warned: false };
}

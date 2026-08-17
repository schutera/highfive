import { describe, it, expect } from 'vitest';
import { DEFAULT_DUCKDB_URL, resolveDuckdbUrl } from '../src/duckdbClient';

// Pure-function tests for the DUCKDB_SERVICE_URL-resolution helper, mirroring
// tests/port-default.test.ts. The previous inline
// `process.env.DUCKDB_SERVICE_URL ?? 'http://127.0.0.1:8002'` was untestable
// without module-cache resets and env juggling, so the one genuine bug it
// carried — a blank `DUCKDB_SERVICE_URL=` becoming the literal fetch base —
// went unpinned. The extracted helper makes the decision logic directly
// assertable.
//
// The 8002 default is the documented docker host-port mapping
// (docker-compose.yml maps duckdb-service 8002:8000), correct for a backend
// running on the host against a composed duckdb. A bare-metal/pm2 box sets the
// var explicitly (ecosystem.config.js); `fromDefault` is what lets server.ts
// warn loudly when nobody did.

describe('resolveDuckdbUrl', () => {
  // ----- explicit URL: env value wins, no warning -----

  it('returns the env value when DUCKDB_SERVICE_URL is set', () => {
    expect(resolveDuckdbUrl('http://duckdb-service:8000')).toEqual({
      url: 'http://duckdb-service:8000',
      fromDefault: false,
    });
  });

  it('returns the env value even when it equals the default', () => {
    // Explicitly setting the default is still an operator decision, so it
    // must NOT trip the unset-warning.
    expect(resolveDuckdbUrl(DEFAULT_DUCKDB_URL)).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: false,
    });
  });

  it('trims whitespace around an explicit URL, no warn', () => {
    // A trailing newline from a compose env_file or a leading space from a
    // shell edit is honest operator intent, not garbage. Untrimmed, the
    // newline lands inside the fetch URL and every hop fails.
    expect(resolveDuckdbUrl('  http://duckdb-service:8000\n')).toEqual({
      url: 'http://duckdb-service:8000',
      fromDefault: false,
    });
  });

  // ----- unset / blank: default 8002, with warning -----

  it('returns the default when DUCKDB_SERVICE_URL is undefined, fromDefault=true', () => {
    expect(resolveDuckdbUrl(undefined)).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: true,
    });
  });

  it('returns the default when DUCKDB_SERVICE_URL is an empty string', () => {
    // The bug this PR fixes: `DUCKDB_SERVICE_URL=` in an env_file used to
    // survive `??` and become the literal fetch base ('/health').
    expect(resolveDuckdbUrl('')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: true,
    });
  });

  it('returns the default when DUCKDB_SERVICE_URL is whitespace-only', () => {
    expect(resolveDuckdbUrl('   ')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: true,
    });
    expect(resolveDuckdbUrl('\t\n')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: true,
    });
  });

  // ----- the default itself -----

  it('defaults to the documented docker host-port mapping', () => {
    // Pins 8002 against an accidental "fix" to 8000: the compose mapping is
    // 8002:8000, so 8000 would be the in-container port and wrong for a
    // host-run backend. See duckdbClient.ts's header comment.
    expect(DEFAULT_DUCKDB_URL).toBe('http://127.0.0.1:8002');
  });
});

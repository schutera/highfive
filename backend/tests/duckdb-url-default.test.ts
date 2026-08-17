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

  // ----- malformed URLs: default 8002, with warning -----
  //
  // `resolvePort` rejects '3002junk' because a docstring promising
  // warn-on-misconfig has to actually validate. Same standard here: these
  // shapes used to pass clean and then die with an opaque `Invalid URL` at
  // every hop instead of once, loudly, at boot.

  it('returns the default when the scheme is missing', () => {
    // The likeliest env-file typo, and the one a bare `new URL()` check misses:
    // 'duckdb-service:8000' PARSES, with protocol 'duckdb-service:'. Only the
    // http(s) check catches it.
    expect(resolveDuckdbUrl('duckdb-service:8000')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: true,
    });
  });

  it('returns the default when the value is not a URL at all', () => {
    expect(resolveDuckdbUrl('not a url')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: true,
    });
  });

  it('returns the default for a non-http(s) scheme', () => {
    // file:// parses fine and would make every fetch fail obscurely.
    expect(resolveDuckdbUrl('file:///data/hive.duckdb')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      fromDefault: true,
    });
  });

  it('accepts https, not just http', () => {
    // A TLS-terminating sidecar is a legitimate deployment; the validation
    // must not narrow what operators are allowed to configure.
    expect(resolveDuckdbUrl('https://duckdb.internal:8443')).toEqual({
      url: 'https://duckdb.internal:8443',
      fromDefault: false,
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

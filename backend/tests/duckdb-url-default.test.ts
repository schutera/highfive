import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DUCKDB_URL,
  describeDuckdbUrlMisconfig,
  describeError,
  redactCredentials,
  resolveDuckdbUrl,
} from '../src/duckdbClient';

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
// var explicitly (ecosystem.config.js).
//
// `reason` is a three-way discriminator, not a boolean, specifically so
// server.ts's startup warning can name the actual mistake. Telling an operator
// their variable is "unset" when they can see it set is the same class of
// misleading boot warning this change exists to remove — so 'unset' and
// 'malformed' are asserted separately throughout.

describe('resolveDuckdbUrl', () => {
  // ----- explicit URL: env value wins, no warning -----

  it('returns the env value when DUCKDB_SERVICE_URL is set', () => {
    expect(resolveDuckdbUrl('http://duckdb-service:8000')).toEqual({
      url: 'http://duckdb-service:8000',
      reason: 'ok',
    });
  });

  it('returns the env value even when it equals the default', () => {
    // Explicitly setting the default is still an operator decision, so it
    // must NOT trip the warning.
    expect(resolveDuckdbUrl(DEFAULT_DUCKDB_URL)).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'ok',
    });
  });

  it('trims whitespace around an explicit URL, no warn', () => {
    // A trailing newline from a compose env_file or a leading space from a
    // shell edit is honest operator intent, not garbage. Untrimmed, the
    // newline lands inside the fetch URL and every hop fails.
    expect(resolveDuckdbUrl('  http://duckdb-service:8000\n')).toEqual({
      url: 'http://duckdb-service:8000',
      reason: 'ok',
    });
  });

  it('strips trailing slashes so hops do not build double-slash paths', () => {
    // Every call site does `${DUCKDB_URL}/path`, so a trailing slash yields
    // `//health`, `//modules`, … It survives only because Werkzeug and nginx
    // merge duplicate slashes — at the cost of a redirect per request and
    // every logged upstream URL looking broken.
    expect(resolveDuckdbUrl('http://duckdb-service:8000/')).toEqual({
      url: 'http://duckdb-service:8000',
      reason: 'ok',
    });
    expect(resolveDuckdbUrl('http://duckdb-service:8000///')).toEqual({
      url: 'http://duckdb-service:8000',
      reason: 'ok',
    });
  });

  // ----- unset / blank -----

  it("reports 'unset' when DUCKDB_SERVICE_URL is undefined", () => {
    expect(resolveDuckdbUrl(undefined)).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'unset',
    });
  });

  it("reports 'unset' when DUCKDB_SERVICE_URL is an empty string", () => {
    // The bug this PR fixes: `DUCKDB_SERVICE_URL=` in an env_file used to
    // survive `??` and become the literal fetch base ('/health').
    expect(resolveDuckdbUrl('')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'unset',
    });
  });

  it("reports 'unset' when DUCKDB_SERVICE_URL is whitespace-only", () => {
    expect(resolveDuckdbUrl('   ')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'unset',
    });
    expect(resolveDuckdbUrl('\t\n')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'unset',
    });
  });

  // ----- malformed: set, but unusable -----
  //
  // `resolvePort` rejects '3002junk' because a docstring promising
  // warn-on-misconfig has to actually validate. Same standard here: these
  // shapes used to pass clean and then die with an opaque `Invalid URL` at
  // every hop instead of once, loudly, at boot. They must report 'malformed',
  // NOT 'unset' — the operator set them, and being told otherwise sends them
  // looking in the wrong place.

  it("reports 'malformed' when the scheme is missing", () => {
    // The likeliest env-file typo, and the one a bare `new URL()` check
    // misses: 'duckdb-service:8000' PARSES, with protocol 'duckdb-service:'.
    // Only the http(s) check catches it.
    expect(resolveDuckdbUrl('duckdb-service:8000')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'malformed',
    });
  });

  it("reports 'malformed' when the value is not a URL at all", () => {
    expect(resolveDuckdbUrl('not a url')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'malformed',
    });
  });

  it("reports 'malformed' for a non-http(s) scheme", () => {
    // file:// parses fine and would make every fetch fail obscurely.
    expect(resolveDuckdbUrl('file:///data/hive.duckdb')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'malformed',
    });
  });

  it('accepts https, not just http', () => {
    // A TLS-terminating sidecar is a legitimate deployment; the validation
    // must not narrow what operators are allowed to configure.
    expect(resolveDuckdbUrl('https://duckdb.internal:8443')).toEqual({
      url: 'https://duckdb.internal:8443',
      reason: 'ok',
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

describe('redactCredentials', () => {
  // A rejected DUCKDB_SERVICE_URL is echoed into the startup warning, which
  // lands in the log ring — persisted to disk (ADR-023) and rendered in the
  // admin panel. log.ts's SECURITY note is explicit that the ring must not
  // hold secrets even in dev, so this helper is the thing standing between a
  // typo'd credential URL and a durable plaintext copy of the password.

  it('redacts userinfo in a normal URL', () => {
    expect(redactCredentials('http://user:pass@duckdb-service:8000')).toBe(
      'http://***@duckdb-service:8000',
    );
  });

  it('redacts userinfo when the scheme is omitted', () => {
    // The likeliest env-file typo of all, and the case a `//…@`-anchored
    // regex silently misses — there is no `//` to anchor on. A miss here
    // writes the password to disk verbatim.
    expect(redactCredentials('user:pass@duckdb-service:8000')).toBe('***@duckdb-service:8000');
  });

  it('redacts the whole userinfo when the password itself contains @', () => {
    // Splitting on the FIRST @ leaves the password tail in the log.
    expect(redactCredentials('ftp://user:p@sswOrd@host:8000')).toBe('ftp://***@host:8000');
  });

  it('leaves a credential-free URL untouched', () => {
    expect(redactCredentials('http://duckdb-service:8000')).toBe('http://duckdb-service:8000');
    expect(redactCredentials('not a url')).toBe('not a url');
  });

  it('does not mistake an @ in the path for a credential', () => {
    // False positives mangle the very value the operator needs to read to
    // spot their typo.
    expect(redactCredentials('http://host:8000/path@weird')).toBe('http://host:8000/path@weird');
  });

  it('passes through undefined and empty without throwing', () => {
    expect(redactCredentials(undefined)).toBeUndefined();
    expect(redactCredentials('')).toBe('');
  });
});

describe('redactCredentials — the shapes that leaked before', () => {
  // Each of these reached a log line with the password intact at some point
  // during PR #193's review. The ring is persisted to disk (ADR-023) and
  // rendered in the admin panel, so a miss here is a durable plaintext copy.

  it('redacts a WELL-FORMED url carrying basic-auth credentials', () => {
    // The one that mattered most: a valid URL is `reason: 'ok'`, so it never
    // touched the malformed branch's redactor and went verbatim into the
    // "not reachable" warning. Basic-auth is an ordinary thing to configure.
    expect(redactCredentials('http://admin:hunter2@127.0.0.1:8000')).toBe(
      'http://***@127.0.0.1:8000',
    );
  });

  it('redacts credentials embedded in an error message', () => {
    // undici puts the full URL in its own text, so redacting only the URL
    // field still leaked the password one field over in the same line.
    const err =
      'TypeError: Request cannot be constructed from a URL that includes ' +
      'credentials: http://admin:hunter2@127.0.0.1:9/health';
    const out = redactCredentials(err)!;
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***@127.0.0.1:9/health');
  });

  it('redacts despite leading whitespace (the caller passes an untrimmed env var)', () => {
    // resolveDuckdbUrl trims before validating; server.ts handed the redactor
    // the RAW value. A ^-anchored scheme match was defeated by one space.
    expect(redactCredentials(' ftp://user:hunter2@host ')).toBe(' ftp://***@host ');
  });

  it('redacts a protocol-relative url', () => {
    expect(redactCredentials('//user:hunter2@host')).toBe('//***@host');
  });

  it('redacts a single-slash scheme typo', () => {
    // http:/… normalises to a valid URL in WHATWG, so this reaches the
    // "well-formed" path and the unredacted log site.
    expect(redactCredentials('http:/user:hunter2@host')).toBe('http:/***@host');
  });

  it('is idempotent — redacting twice does not corrupt the result', () => {
    const once = redactCredentials('http://admin:hunter2@host:8000')!;
    expect(redactCredentials(once)).toBe(once);
  });

  it('never leaves a password behind, across every shape at once', () => {
    // Belt-and-braces sweep: whatever the shape, "hunter2" must not survive.
    for (const v of [
      'http://u:hunter2@h:1',
      'u:hunter2@h:1',
      '//u:hunter2@h:1',
      'http:/u:hunter2@h:1',
      'ftp://u:hunter2@h:1',
      'http://u:p@hunter2@h:1',
      '  https://u:hunter2@h:1/path?q=1  ',
    ]) {
      expect(redactCredentials(v)).not.toContain('hunter2');
    }
  });
});

describe('resolveDuckdbUrl — embedded credentials are fatal, not fine', () => {
  it("reports 'malformed' for a URL carrying userinfo", () => {
    // Not a style preference: undici refuses such a URL BEFORE any network
    // I/O ("Request cannot be constructed from a URL that includes
    // credentials"), so this config fails 100% of duckdb hops — every
    // dashboard read, not just the boot probe. Calling it 'ok' is the silent
    // fatal misconfiguration this resolver exists to prevent.
    expect(resolveDuckdbUrl('http://admin:hunter2@duckdb-service:8000')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'malformed',
    });
  });

  it("reports 'malformed' for a username with no password", () => {
    expect(resolveDuckdbUrl('http://admin@duckdb-service:8000')).toEqual({
      url: DEFAULT_DUCKDB_URL,
      reason: 'malformed',
    });
  });

  it('guarantees DUCKDB_URL can never carry a credential', () => {
    // This is the invariant that lets every log site in app.ts and
    // database.ts interpolate DUCKDB_URL without redacting: the value simply
    // cannot contain a secret. A per-site redaction decision is what fails.
    for (const v of ['http://u:p@h:1', 'https://u:p@h:1', 'http://u@h:1', '  http://u:p@h:1  ']) {
      expect(resolveDuckdbUrl(v).url).toBe(DEFAULT_DUCKDB_URL);
      expect(resolveDuckdbUrl(v).url).not.toContain('@');
    }
  });
});

describe('describeError', () => {
  it('surfaces the cause, which is where the real reason lives', () => {
    // Verified against Node 24: fetch() to a refused port rejects with
    // String(e) === 'TypeError: fetch failed' and the actual reason on
    // e.cause. A boot warning printing only the former cannot distinguish a
    // refused port from a hostname typo or an expired certificate — and
    // telling the operator why duckdb is unreachable IS this warning's job.
    const err = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:8002'),
    });

    const out = describeError(err);

    expect(out).toContain('fetch failed');
    expect(out).toContain('ECONNREFUSED 127.0.0.1:8002');
  });

  it('walks a multi-level cause chain', () => {
    const err = new Error('a', { cause: new Error('b', { cause: new Error('c') }) });
    expect(describeError(err)).toBe('Error: a ← Error: b ← Error: c');
  });

  it('includes AggregateError members', () => {
    const err = new AggregateError(
      [new Error('addr1 refused'), new Error('addr2 refused')],
      'all failed',
    );
    const out = describeError(err);
    expect(out).toContain('addr1 refused');
    expect(out).toContain('addr2 refused');
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(() => describeError(a)).not.toThrow();
    expect(describeError(a)).toBe('Error: a ← Error: b');
  });

  it('handles a non-Error rejection without throwing', () => {
    expect(describeError('a bare string')).toBe('a bare string');
    expect(describeError(undefined)).toBe('');
  });
});

describe('describeDuckdbUrlMisconfig — the last credential-bearing log site', () => {
  // This message echoes the RAW env value back so the operator can see their
  // typo, which makes it the only remaining place a password can reach the
  // ring (persisted to disk per ADR-023, rendered in the admin panel). It was
  // extracted out of server.ts specifically so it could be pinned: server.ts
  // calls bootstrap() at module scope and cannot be imported by a test, and
  // BOTH redaction bugs on this branch were un-pinned wiring, not a bad regex.

  it('returns null when the URL is fine, so no warning is logged', () => {
    expect(describeDuckdbUrlMisconfig('ok', 'http://duckdb-service:8000')).toBeNull();
  });

  it('says "unset or blank" — not "malformed" — when nothing was configured', () => {
    const msg = describeDuckdbUrlMisconfig('unset', undefined)!;
    expect(msg).toContain('unset or blank');
    expect(msg).toContain(DEFAULT_DUCKDB_URL);
  });

  it('says the value is SET but unusable, and shows it, when it is malformed', () => {
    // Telling an operator their variable is "unset" when they can see it set
    // is the misleading-boot-warning class this whole change exists to remove.
    const msg = describeDuckdbUrlMisconfig('malformed', 'duckdb-service:8000')!;
    expect(msg).toContain('unusable value');
    expect(msg).toContain('duckdb-service:8000');
    expect(msg).not.toContain('unset');
  });

  it('NEVER echoes a password, even though it echoes the value', () => {
    const msg = describeDuckdbUrlMisconfig(
      'malformed',
      'http://admin:hunter2@duckdb-service:8000',
    )!;
    expect(msg).not.toContain('hunter2');
    expect(msg).toContain('***@');
  });

  it('explains that credentials specifically are rejected', () => {
    // A credentialed URL IS an absolute http URL, so "must be an absolute
    // http(s) URL" alone would read as nonsense to whoever configured one.
    const msg = describeDuckdbUrlMisconfig('malformed', 'http://u:p@h:8000')!;
    expect(msg).toContain('no embedded credentials');
  });
});

describe('resolveDuckdbUrl — normalises everything after the authority', () => {
  it('drops a query string that would otherwise corrupt every path', () => {
    // `${DUCKDB_URL}/health` on a query-carrying base yields `…?x=1/health`.
    expect(resolveDuckdbUrl('http://duckdb-service:8000?x=1').url).toBe(
      'http://duckdb-service:8000',
    );
  });

  it('drops a fragment', () => {
    expect(resolveDuckdbUrl('http://duckdb-service:8000#frag').url).toBe(
      'http://duckdb-service:8000',
    );
  });

  it('keeps a path prefix (a duckdb mounted under a sub-path is legitimate)', () => {
    expect(resolveDuckdbUrl('http://gateway:8000/duckdb').url).toBe('http://gateway:8000/duckdb');
  });
});

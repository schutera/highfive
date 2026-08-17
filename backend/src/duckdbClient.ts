// `DUCKDB_SERVICE_URL` is the in-compose address (http://duckdb-service:8000).
// The default below is the docker host-port mapping (8002:8000) for a backend
// running on the host against a composed duckdb-service. A bare-metal/pm2
// deploy (duckdb-service on :8000 directly) MUST set the env var explicitly —
// see the ecosystem.config.js template in
// docs/07-deployment-view/production-runbook.md.
export const DEFAULT_DUCKDB_URL = 'http://127.0.0.1:8002';

/** The wire shape of duckdb-service's `GET /health` (routes/health.py). */
export type DuckdbHealthResult = { ok: boolean; db?: string };

/**
 * Why we fell back to the default, or `ok` if we didn't.
 *
 * Kept as a discriminated reason rather than a boolean because the startup
 * warning has to be able to say *which* mistake the operator made. Telling
 * someone their variable is "unset" when they can plainly see it set — the
 * shape a single boolean forces — is precisely the misleading-boot-warning
 * problem this whole change exists to remove.
 */
export type DuckdbUrlReason = 'ok' | 'unset' | 'malformed';

/**
 * Resolve the duckdb-service base URL from the env-string and report whether
 * the caller should warn.
 *
 * Pure function — caller owns the side effect (log.warn), mirroring port.ts's
 * `resolvePort` so the resolution logic stays unit-testable without env
 * juggling or module-cache resets.
 *
 * Rejects four shapes, all of which used to sail through and then die at
 * *every* hop instead of once, loudly, at boot:
 *
 *   - unset            → the ordinary "operator didn't configure it" case
 *   - blank / spaces   → `DUCKDB_SERVICE_URL=` in a compose env_file became
 *                        the literal fetch base under the previous `??`
 *   - not an http(s) URL → `duckdb-service:8000` (scheme omitted) PARSES, as a
 *                        URL with protocol `duckdb-service:`, so a bare
 *                        `new URL()` check is not enough
 *   - carries userinfo → `http://user:pass@host` is rejected by Node's fetch
 *                        before any I/O, so it breaks 100% of hops (see below)
 *
 * This mirrors `resolvePort` rejecting `3002junk`: a docstring that promises
 * warn-on-misconfiguration has to actually validate, or "bind the prefix and
 * stay quiet" creeps back in.
 */
export function resolveDuckdbUrl(envValue: string | undefined): {
  url: string;
  reason: DuckdbUrlReason;
} {
  const trimmed = envValue?.trim();
  if (!trimmed) return { url: DEFAULT_DUCKDB_URL, reason: 'unset' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: DEFAULT_DUCKDB_URL, reason: 'malformed' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: DEFAULT_DUCKDB_URL, reason: 'malformed' };
  }
  // Reject embedded credentials. This is not a style preference: undici
  // refuses such a URL *before any network I/O* —
  //   TypeError: Request cannot be constructed from a URL that includes
  //   credentials
  // — so a credentialed DUCKDB_SERVICE_URL fails 100% of duckdb hops, every
  // dashboard read included, not merely the boot probe. Reporting it as `ok`
  // is exactly the silent-fatal-misconfig this function exists to prevent.
  //
  // Rejecting here is also what keeps credentials out of the logs *globally*:
  // `DUCKDB_URL` is interpolated into error strings all over app.ts and
  // database.ts, and those land in the disk-persisted, admin-readable ring.
  // Redacting each of those call sites would be a per-site decision that one
  // day gets forgotten; guaranteeing the value never carries a secret is not.
  if (parsed.username || parsed.password) {
    return { url: DEFAULT_DUCKDB_URL, reason: 'malformed' };
  }
  // Return the NORMALISED origin+path, not the raw string. Every call site
  // builds `${DUCKDB_URL}/path`, so anything after the authority has to be
  // dealt with here or it corrupts every request:
  //   - a trailing slash yields `//health`, `//modules`, … (survives only
  //     because Werkzeug and nginx merge duplicate slashes, at the cost of a
  //     redirect per request and every logged URL looking broken)
  //   - a query or fragment (`http://host:8000?x=1`) yields `…?x=1/health`,
  //     which is the "sails through and dies at every hop instead of once,
  //     loudly, at boot" shape this function exists to prevent.
  return { url: (parsed.origin + parsed.pathname).replace(/\/+$/, ''), reason: 'ok' };
}

/**
 * Compose the operator-facing `[startup]` warning for a rejected
 * `DUCKDB_SERVICE_URL`.
 *
 * Lives here, not inline in server.ts, for one reason: server.ts calls
 * `bootstrap()` at module scope and so cannot be imported by a test, and this
 * string is **the last place a credential can still reach the log ring** (it
 * echoes the raw env value back so the operator can see their typo). Both
 * redaction bugs on this branch were wiring bugs, not regex bugs — an
 * un-pinned call site is exactly how they happened.
 */
export function describeDuckdbUrlMisconfig(
  reason: DuckdbUrlReason,
  rawEnvValue: string | undefined,
): string | null {
  if (reason === 'ok') return null;
  const detail =
    reason === 'unset'
      ? 'unset or blank'
      : `set to an unusable value (${JSON.stringify(redactCredentials(rawEnvValue))}) — ` +
        `it must be an absolute http(s) URL with no embedded credentials ` +
        `(Node's fetch rejects those outright), e.g. http://duckdb-service:8000`;
  return (
    `[startup] DUCKDB_SERVICE_URL ${detail} — falling back to ${DEFAULT_DUCKDB_URL}. ` +
    `Set it explicitly in production (pm2: ecosystem.config.js; ` +
    `compose: DUCKDB_SERVICE_URL=http://duckdb-service:8000).`
  );
}

/**
 * Replace URL userinfo (`user:pass@`) with `***@`, anywhere in a string.
 *
 * The log ring is persisted to disk (ADR-023) and rendered in the admin panel,
 * and log.ts's SECURITY note is explicit that it must not hold secrets even in
 * dev.
 *
 * Scope note: `resolveDuckdbUrl` now *rejects* a credentialed URL, so
 * `DUCKDB_URL` itself can never carry one and ordinary log sites need no
 * redaction. What still can is the **raw env value** echoed back in the
 * startup warning — an operator who configures basic-auth gets told their
 * value was refused, and that message must not repeat the password. Errors
 * are also passed through here defensively, since undici embeds the offending
 * URL in its own text (`Request cannot be constructed from a URL that includes
 * credentials: http://user:pass@host/…`).
 *
 * Two passes, because no single anchor covers the shapes that actually occur:
 *
 *   1. `scheme://userinfo@` and protocol-relative `//userinfo@`. The `[^\s/?#]*`
 *      is greedy, so a password containing `@` (`user:p@ss@host`) is consumed
 *      whole rather than leaving the tail behind.
 *   2. Bare `user:pass@host` with no `//` to anchor on — the scheme-omitted
 *      typo `resolveDuckdbUrl` calls the likeliest of all, and the
 *      single-slash `http:/user:pass@host` variant. Requiring a `:` inside the
 *      userinfo keeps ordinary `@` in prose and in URL paths untouched.
 *
 * Deliberately fail-safe: it would rather redact something that wasn't a
 * credential than let one through.
 */
export function redactCredentials(text: string | undefined): string | undefined {
  if (!text) return text;
  return (
    text
      .replace(/((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)[^\s/?#]*@/g, '$1***@')
      // `\` is excluded so a Windows path in a stack trace
      // (`…\node_modules\@scope\pkg`) isn't mistaken for userinfo.
      .replace(/[^\s/\\@]*:[^\s/\\@]*@/g, '***@')
  );
}

/**
 * Stringify an error together with its `cause` chain.
 *
 * `String(err)` on a Node fetch failure yields the useless
 * `TypeError: fetch failed` — the part an operator needs
 * (`connect ECONNREFUSED 127.0.0.1:8002`, `getaddrinfo ENOTFOUND`,
 * `certificate has expired`) lives on `err.cause`. For a boot warning whose
 * entire job is telling someone *why* duckdb is unreachable, dropping the
 * cause makes a refused port indistinguishable from a hostname typo.
 *
 * Walks `cause` and `AggregateError.errors`, with a seen-set so a cyclic chain
 * cannot loop forever.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    parts.push(String(current));
    const aggregate = (current as { errors?: unknown[] }).errors;
    if (Array.isArray(aggregate) && aggregate.length > 0) {
      parts.push(...aggregate.filter((e) => !seen.has(e)).map((e) => String(e)));
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' ← ');
}

const resolved = resolveDuckdbUrl(process.env.DUCKDB_SERVICE_URL);

/**
 * Guaranteed credential-free: `resolveDuckdbUrl` rejects any URL carrying
 * userinfo, so this is safe to interpolate into a log line. That guarantee is
 * why there is no separate "safe" variant — one would have to be threaded
 * through every call site in app.ts and database.ts, and a per-site "did I
 * remember to redact this one" decision is precisely what fails.
 */
export const DUCKDB_URL = resolved.url;

/** Why DUCKDB_SERVICE_URL was rejected, or `ok`. Drives the startup warning. */
export const duckdbUrlReason = resolved.reason;

/**
 * `timeoutMs` is required, not defaulted: callers have genuinely different
 * budgets (the boot probe wants ~2 s so it can retry, a request path wants
 * more), and a default here would just be a number nobody chose.
 *
 * NOTE for anyone extending this file: most `DUCKDB_URL` hops in app.ts and
 * *all four* in database.ts's `fetchJsonOk` are still unbounded `fetch()`
 * calls — only 3 of the 17 `fetch` calls in app.ts carry an
 * `AbortSignal.timeout`. Node's fetch has NO default timeout, so those hops
 * hang forever against an accepting-but-silent upstream. Tracked in
 * https://github.com/schutera/highfive/issues/223 — do not read this
 * function's signal as evidence the proxy chain is covered.
 */
export async function duckdbHealth(timeoutMs: number): Promise<DuckdbHealthResult> {
  // Without the abort signal, a duckdb host that accepts the TCP connection
  // but never answers (hung, not refused) blocks this await forever — and with
  // it every caller, including the boot probe's retry loop, which is how the
  // backend ends up never binding its port at all.
  const res = await fetch(`${DUCKDB_URL}/health`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DuckDB health failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as DuckdbHealthResult;
  // A 200 carrying `{"ok": false}` is duckdb-service saying "I'm listening but
  // not serving" (e.g. the DB file failed to open). Reporting that as
  // "reachable" is exactly the false-green this probe exists to remove.
  // duckdb-service's routes/health.py hardcodes ok=True today, so this is a
  // guard against a future regression, not a live case.
  if (!body?.ok) throw new Error(`DuckDB health reported not-ok: ${JSON.stringify(body)}`);
  return body;
}

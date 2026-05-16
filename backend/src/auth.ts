import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { isProduction } from './env';

// Public dev fallback. Lives here, in tests, and in CLAUDE.md — anyone reading
// the repo can grep for it. Safe only when the deployment overrides it.
const DEV_FALLBACK_KEY = 'hf_dev_key_2026';

// Resolved from env, then validated. Two failure modes the validator catches:
// (1) `HIGHFIVE_API_KEY` is set (case-insensitively) to the literal dev
//     fallback. The fallback is a public string by design — documented in
//     CLAUDE.md, used by the entire backend test suite — so an env value
//     of `hf_dev_key_2026`, `HF_DEV_KEY_2026`, or any case-mixed variant
//     was almost certainly a copy-paste from `.env.example` rather than
//     a deliberate strong secret. Comparison is case-insensitive on the
//     env-value side; the canonical fallback stays lowercase.
// (2) `isProduction()` is true but `HIGHFIVE_API_KEY` is empty/unset,
//     which would silently activate the dev fallback as the production
//     admin gate. CLAUDE.md flags this as a "do NOT violate" rule; this
//     code makes the rule self-enforcing instead of relying on operator
//     vigilance. `isProduction()` (see `env.ts`) normalises `NODE_ENV`
//     across casing and trailing-whitespace typos so `"Production"`,
//     `"PRODUCTION"`, and `"production "` all activate the guard.
//
// Tests run under `NODE_ENV=test` (vitest's default) and don't set the env
// var, so they take the fallback branch cleanly.
//
// `||` (not `??`) is load-bearing here: `''.trim() === ''`, and we want a
// whitespace-only env value to coerce to `undefined` so the second guard
// sees "key unset" rather than "key set to empty string". `??` would
// preserve the empty string and the case-insensitive dev-key compare on
// the next line would silently pass (empty !== `hf_dev_key_2026`), then
// the production guard would not fire because `ENV_KEY !== undefined`.
// The asymmetry with the `??` on the API_KEY assignment below is
// intentional and not a style nit — there `??` is correct because the
// inputs are already known-non-empty (or undefined).
const ENV_KEY = process.env.HIGHFIVE_API_KEY?.trim() || undefined;

// Both guards `throw` independently. A deployment that hits both
// failure modes (e.g. `NODE_ENV=production` AND `HIGHFIVE_API_KEY` set
// to the dev fallback) will trip this first guard and never see the
// second. That's "fail fast on first problem" — the right behaviour
// for a startup gate, but worth flagging because a future "log all
// problems" refactor would need to convert the throws into accumulated
// errors first.
if (ENV_KEY !== undefined && ENV_KEY.toLowerCase() === DEV_FALLBACK_KEY) {
  throw new Error(
    `HIGHFIVE_API_KEY is set (case-insensitively) to the public dev ` +
      `fallback '${DEV_FALLBACK_KEY}'. Either leave HIGHFIVE_API_KEY unset ` +
      `(the dev fallback applies for local development only) or set it to ` +
      `a strong production value. See CLAUDE.md "Critical rules" and the ` +
      `repo root .env.production.example.`,
  );
}

if (isProduction() && ENV_KEY === undefined) {
  throw new Error(
    'HIGHFIVE_API_KEY must be set when NODE_ENV=production. Refusing to ' +
      'start backend with the public dev fallback as the admin gate. See ' +
      'CLAUDE.md "Critical rules" and the repo root .env.production.example.',
  );
}

const API_KEY = ENV_KEY ?? DEV_FALLBACK_KEY;

// Constant-time compare for symmetric secrets. Strict-inequality short-circuits
// on the first differing byte, leaking how many leading bytes of the submitted
// value matched the configured key — exploitable over thousands of probes from
// a network position with low jitter. timingSafeEqual is the standard fix.
//
// Length mismatch returns false before calling timingSafeEqual: Node's
// timingSafeEqual throws on length mismatch, and we don't want to surface
// that as a 500 from the auth middleware. The length-mismatch branch leaks
// the configured secret's length to a probing attacker — for the single
// fixed-length deployment key the project uses, that's a recoverable
// constant rather than ongoing leakage. The byte content (the part that
// actually carries the entropy) is what the constant-time compare protects.
// Acceptable tradeoff for the threat model in ADR-003.
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify a submitted key against the configured API_KEY in constant time.
 *
 * Single exported boundary for the secret-compare — both the API-key middleware
 * in this file and the admin-gate inline in `app.ts` route through here, so
 * changes to the compare semantics propagate to both gates by construction.
 */
export function verifyApiKey(provided: string): boolean {
  return constantTimeEqual(provided, API_KEY);
}

export interface AuthenticatedRequest extends Request {
  apiKeyValid?: boolean;
}

/**
 * Middleware to validate API key
 * Accepts key via:
 * - Header: X-API-Key: <key>
 * - Header: Authorization: Bearer <key>
 * - Query param: ?api_key=<key> (not recommended for production)
 */
export function apiKeyAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const apiKey =
    req.header('X-API-Key') ||
    req.header('Authorization')?.replace('Bearer ', '') ||
    (req.query.api_key as string);

  if (!apiKey) {
    res.status(401).json({
      error: 'Unauthorized',
      message:
        'API key is required. Provide it via X-API-Key header or Authorization: Bearer <key>',
    });
    return;
  }

  if (!verifyApiKey(apiKey)) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key',
    });
    return;
  }

  req.apiKeyValid = true;
  next();
}

/**
 * Get the current API key (for development/testing display)
 */
export function getApiKey(): string {
  return API_KEY;
}

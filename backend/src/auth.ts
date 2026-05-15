import { Request, Response, NextFunction } from 'express';
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
const ENV_KEY = process.env.HIGHFIVE_API_KEY?.trim() || undefined;

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

  if (apiKey !== API_KEY) {
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

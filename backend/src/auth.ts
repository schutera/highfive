import { Request, Response, NextFunction } from 'express';

// Public dev fallback. Lives here, in tests, and in CLAUDE.md — anyone reading
// the repo can grep for it. Safe only when the deployment overrides it.
const DEV_FALLBACK_KEY = 'hf_dev_key_2026';

// Resolved from env, then validated. Two failure modes the validator catches:
// (1) `HIGHFIVE_API_KEY` is set to the literal dev fallback. The fallback is
//     a public string by design (it's documented in CLAUDE.md and used by the
//     test suite); setting it explicitly via env var defeats the override
//     mechanism and is almost always a copy-paste from `.env.example`.
// (2) `NODE_ENV=production` is set but `HIGHFIVE_API_KEY` is empty/unset,
//     which would silently activate the dev fallback as the production
//     admin gate. CLAUDE.md flags this as a "do NOT violate" rule; this
//     code makes the rule self-enforcing instead of relying on operator
//     vigilance.
//
// Tests run under `NODE_ENV=test` (vitest's default) and don't set the env
// var, so they take the fallback branch cleanly.
const ENV_KEY = process.env.HIGHFIVE_API_KEY?.trim() || undefined;

if (ENV_KEY === DEV_FALLBACK_KEY) {
  throw new Error(
    `HIGHFIVE_API_KEY is set to the public dev fallback '${DEV_FALLBACK_KEY}'. ` +
      'Either leave HIGHFIVE_API_KEY unset (the dev fallback applies for ' +
      'local development only) or set it to a strong production value. ' +
      'See CLAUDE.md "Critical rules" and .env.production.example.',
  );
}

if (process.env.NODE_ENV === 'production' && ENV_KEY === undefined) {
  throw new Error(
    'HIGHFIVE_API_KEY must be set when NODE_ENV=production. Refusing to ' +
      'start backend with the public dev fallback as the admin gate. See ' +
      'CLAUDE.md "Critical rules" and .env.production.example.',
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

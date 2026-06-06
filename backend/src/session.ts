import { Request, Response, NextFunction, CookieOptions } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { getApiKey, verifyApiKey } from './auth';
import { isProduction } from './env';

// Server-side admin session (issue #142, ADR-019).
//
// The homepage bundle no longer carries any API secret. Admin actions are
// gated by ONE of:
//   1. a signed, HttpOnly session cookie minted by POST /api/admin/login
//      after a constant-time password check, or
//   2. an `X-Admin-Key` header matching HIGHFIVE_API_KEY — the server-side
//      machine credential for operator scripts / CI, never shipped to a
//      browser (see `requireAdmin`).
//
// The cookie value is a stateless HMAC-signed token, so there is no session
// store to keep or scale. The signing key is the same `HIGHFIVE_API_KEY`
// secret the rest of the stack already requires (`getApiKey()`), so rotating
// that key also invalidates every outstanding session — a useful property,
// and the reason there is no separate SESSION_SECRET env var to forget.

export const SESSION_COOKIE = 'hf_admin_session';

// 12 h: long enough that an operator isn't re-typing the key all afternoon,
// short enough that a leaked cookie self-expires by the next day.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Bump if the token payload shape changes; an old-version token then fails
// `verifySessionToken` and the holder is transparently asked to log in again.
const TOKEN_VERSION = 1;

interface SessionPayload {
  v: number;
  exp: number; // unix ms
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// HMAC-SHA256 over the (already-encoded) payload segment, keyed on the
// resolved admin secret. Recomputed on every verify so a key rotation
// invalidates outstanding tokens by construction.
function sign(payloadSegment: string): string {
  return base64url(createHmac('sha256', getApiKey()).update(payloadSegment).digest());
}

/**
 * Mint a `payload.signature` session token valid for SESSION_TTL_MS.
 * `now` is injectable for deterministic tests.
 */
export function issueSessionToken(now: number = Date.now()): string {
  const payload: SessionPayload = { v: TOKEN_VERSION, exp: now + SESSION_TTL_MS };
  const segment = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${segment}.${sign(segment)}`;
}

/**
 * True iff `token` is a structurally valid, correctly-signed, unexpired
 * session token. Signature is compared in constant time before the payload
 * is trusted, so a tampered payload never reaches `JSON.parse` with a forged
 * signature accepted. `now` is injectable for deterministic tests.
 */
export function verifySessionToken(
  token: string | undefined | null,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const segment = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(segment);

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64urlDecode(segment).toString('utf8')) as SessionPayload;
  } catch {
    return false;
  }
  if (payload.v !== TOKEN_VERSION) return false;
  if (typeof payload.exp !== 'number' || payload.exp < now) return false;
  return true;
}

/**
 * Cookie attributes for the session. `Secure` only in production because a
 * dev/CI stack serves over plain http on localhost, where a `Secure` cookie
 * is silently dropped by the browser. `SameSite=Lax` is sufficient even
 * though the homepage (`highfive.schutera.com`) and API
 * (`api.highfive.schutera.com`) are different origins: they share the
 * registrable domain `schutera.com`, so the request is *same-site* and a Lax
 * cookie rides along. The cookie is host-only on the API origin.
 */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

/**
 * Express middleware gating admin/write routes. Passes when EITHER a valid
 * `X-Admin-Key` machine credential is presented OR a valid session cookie is
 * present. 401 otherwise — neither credential supplied or both invalid.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const headerKey = req.header('X-Admin-Key');
  if (headerKey && verifyApiKey(headerKey)) {
    next();
    return;
  }
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (verifySessionToken(cookie)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized', message: 'admin authentication required' });
}

// --- Login rate limiting -------------------------------------------------
//
// In-memory per-IP failure counter. Sufficient for the single-instance,
// single-tenant deployment (one backend process behind host-Nginx). A
// multi-instance future would need a shared store; flagged in ADR-019.

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

/** True when `ip` has exhausted its attempt budget for the current window. */
export function isRateLimited(ip: string, now: number = Date.now()): boolean {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= MAX_ATTEMPTS;
}

/** Record a failed login, opening or extending the per-IP window. */
export function recordFailedAttempt(ip: string, now: number = Date.now()): void {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Clear an IP's failure counter (called on a successful login). */
export function resetAttempts(ip: string): void {
  attempts.delete(ip);
}

/** Test-only: wipe all rate-limiter state between cases. */
export function __resetRateLimiterForTests(): void {
  attempts.clear();
}

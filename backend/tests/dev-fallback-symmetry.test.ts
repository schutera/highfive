import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Pins the public dev fallback key literal in backend/src/auth.ts.
//
// History: this was a *cross-package* symmetry test — the homepage carried its
// own `DEV_FALLBACK_KEY` (in api-key-validator.ts) that had to match the
// backend's. As of #142 / ADR-019 the homepage bundle holds no secret at all
// (no VITE_API_KEY, validator deleted), so there is nothing on the frontend to
// keep in sync. The remaining contract is one-sided: the backend's
// DEV_FALLBACK_KEY must stay the documented public string `hf_dev_key_2026`
// (CLAUDE.md "Critical rules", .env.example, the backend test suite). A silent
// rename here would break the dev workflow without the startup guard firing.

const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND_AUTH = resolve(REPO_ROOT, 'backend', 'src', 'auth.ts');

// Extract the value assigned to a `const DEV_FALLBACK_KEY = '...'` decl.
// Returns null on no-match so the test can produce a useful failure
// message rather than a misleading "undefined === undefined" tautology.
//
// Regex design:
//   * ^\s* + m flag — anchor on a real statement line, not a commented-out
//     copy. A `//`-prefixed line cannot match.
//   * Optional `export ` — tolerates a future `export const ...` refactor.
//   * Single- or double-quoted literal — survives a prettier quote-style flip.
//   * Optional `as const` — tolerates a TS-tightening refactor.
function extractDevFallbackLiteral(source: string): string | null {
  const re =
    /^\s*(?:export\s+)?const DEV_FALLBACK_KEY\s*=\s*['"]([^'"]+)['"]\s*(?:as\s+const\s*)?;/m;
  const match = source.match(re);
  return match ? match[1] : null;
}

describe('backend DEV_FALLBACK_KEY', () => {
  it('declares the documented public dev key', () => {
    const backendLit = extractDevFallbackLiteral(readFileSync(BACKEND_AUTH, 'utf-8'));
    expect(backendLit, `no DEV_FALLBACK_KEY declaration found in ${BACKEND_AUTH}`).not.toBeNull();
    expect(backendLit).toBe('hf_dev_key_2026');
  });
});

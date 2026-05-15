import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Cross-package contract test. The dev fallback `hf_dev_key_2026` is named
// literally in three places: backend/src/auth.ts (DEV_FALLBACK_KEY +
// startup guard regex), homepage/src/services/api.ts (DEV_FALLBACK_KEY +
// fallback expression), and prose throughout the docs. Both code-side
// constants gate against the same string at module load; a rename in one
// place silently breaks the dev workflow without either guard firing.
//
// Real structural fix would be a shared workspace constant (the
// `@highfive/contracts` package already exists for backend↔homepage wire
// shapes; a security constant arguably doesn't belong there but a sibling
// `@highfive/dev-defaults` could). This test is the lighter touch — it
// catches the drift before commit without restructuring the imports.
//
// Reviewer note: senior-reviewer flagged this as architectural smell in
// the PR-86/87 audit cycle. The reviewer specifically called for "a
// single test that loads both modules and asserts they match would catch
// 90% of the drift"; this is that test.

const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND_AUTH = resolve(REPO_ROOT, 'backend', 'src', 'auth.ts');
const HOMEPAGE_API = resolve(REPO_ROOT, 'homepage', 'src', 'services', 'api.ts');

// Extract the value assigned to a `const DEV_FALLBACK_KEY = '...'` decl.
// Returns null on no-match so the test can produce a useful failure
// message rather than a misleading "undefined === undefined" tautology.
//
// Regex design (round-2 review tightened this from the lazy original):
//   * ^\s* + m flag — anchor the match on a real statement line, not a
//     commented-out copy somewhere else in the file. A line that starts
//     with `//` cannot match because `//` would have to come between
//     `^\s*` and `const`, which the regex forbids.
//   * Optional `export ` — tolerates a future `export const ...` refactor.
//   * Single- or double-quoted literal — survives a prettier config flip
//     between quote styles (today's `.prettierrc` is singleQuote: true).
//   * Optional `as const` — tolerates a TS-tightening refactor.
function extractDevFallbackLiteral(source: string): string | null {
  const re =
    /^\s*(?:export\s+)?const DEV_FALLBACK_KEY\s*=\s*['"]([^'"]+)['"]\s*(?:as\s+const\s*)?;/m;
  const match = source.match(re);
  return match ? match[1] : null;
}

describe('DEV_FALLBACK_KEY symmetry across backend and homepage', () => {
  it('both files declare the same literal', () => {
    const backendLit = extractDevFallbackLiteral(readFileSync(BACKEND_AUTH, 'utf-8'));
    const homepageLit = extractDevFallbackLiteral(readFileSync(HOMEPAGE_API, 'utf-8'));
    expect(backendLit, `no DEV_FALLBACK_KEY declaration found in ${BACKEND_AUTH}`).not.toBeNull();
    expect(homepageLit, `no DEV_FALLBACK_KEY declaration found in ${HOMEPAGE_API}`).not.toBeNull();
    expect(homepageLit).toBe(backendLit);
  });

  it('both literals match the documented public dev key', () => {
    // The string 'hf_dev_key_2026' is the documented public dev key
    // (CLAUDE.md "Critical rules", .env.example, the backend's own test
    // suite). If both files agree but on a different value, the symmetry
    // test above passes while the docs are still wrong. This test pins
    // the docs as the third source.
    const backendLit = extractDevFallbackLiteral(readFileSync(BACKEND_AUTH, 'utf-8'));
    expect(backendLit).toBe('hf_dev_key_2026');
  });
});

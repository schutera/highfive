import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import translations from '../i18n/translations';

/**
 * Guards the failure in #238: a `t('...')` call site whose key does not exist
 * in translations.ts. LanguageContext.t() returns the key path when the leaf
 * is not renderable, so the UI shows the literal `common.unknown` instead of
 * text, and nothing failed. This scans the source for `t('...')` literals and
 * resolves each against every locale.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // The tests themselves may reference deliberately-absent keys.
      return entry === '__tests__' ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * Only single-quoted string literals. A template literal or a variable is not
 * statically resolvable, and is out of scope for this check.
 */
function keysIn(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]);
}

function resolveKey(locale: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      locale
    );
}

/**
 * Mirrors what LanguageContext.t() can actually render: a string, or a plural
 * form — an object carrying a string `other` branch, which t() selects with
 * Intl.PluralRules. Anything else (an array such as setup.stepLabels, or a
 * nested group) collapses to the key path on screen, which is the bug being
 * guarded. Those are read with useTranslationRaw(), not t().
 */
function isRenderable(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).other === 'string'
  );
}

const locales = Object.keys(translations) as (keyof typeof translations)[];

const callSites = sourceFiles(SRC).flatMap((file) =>
  keysIn(readFileSync(file, 'utf8')).map((key) => ({ file, key }))
);

describe('i18n key completeness', () => {
  it('finds t() call sites to check', () => {
    // Guards the scan itself: a regex or a directory walk that silently stops
    // matching would otherwise make every assertion below vacuously true.
    expect(callSites.length).toBeGreaterThan(20);
    expect(locales.length).toBeGreaterThan(1);
  });

  it('accepts strings and plural forms, and rejects what t() cannot render', () => {
    expect(isRenderable('Unknown')).toBe(true);
    expect(isRenderable({ one: '1 module', other: '{count} modules' })).toBe(true);
    expect(isRenderable(undefined)).toBe(false);
    expect(isRenderable(['a', 'b'])).toBe(false);
    expect(isRenderable({ nested: { deeper: 'x' } })).toBe(false);
  });

  it.each(locales)('every t() key resolves to renderable text in %s', (locale) => {
    const missing = callSites
      .filter(({ key }) => !isRenderable(resolveKey(translations[locale], key)))
      .map(({ file, key }) => `${key}  (${file.slice(SRC.length + 1)})`);

    expect([...new Set(missing)]).toEqual([]);
  });

  it('keeps every locale structurally in step', () => {
    const flatten = (node: unknown, prefix = ''): string[] =>
      node !== null && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
            flatten(v, prefix ? `${prefix}.${k}` : k)
          )
        : [prefix];

    const [first, ...rest] = locales.map((locale) => flatten(translations[locale]).sort());
    for (const other of rest) {
      expect(other).toEqual(first);
    }
  });
});

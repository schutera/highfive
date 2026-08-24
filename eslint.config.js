// Root ESLint flat config (issue #208) covering the three npm workspaces:
// backend/, homepage/, contracts/. tests/ui/ is a separate, non-workspace
// package (own package-lock, own node_modules) and is deliberately out of
// scope here.
//
// Deliberate follow-up, not done here: this config uses
// typescript-eslint's plain `recommended` preset, NOT `recommendedTypeChecked`.
// The type-checked variant (plus rules like `no-floating-promises`) needs a
// type-aware parser service (slower, and requires wiring `project`/
// `projectService` per workspace tsconfig) — worth doing, but kept out of
// this PR to keep `npm run lint` fast. Track as a follow-up.
'use strict';

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const reactRefresh = require('eslint-plugin-react-refresh').default;
const eslintConfigPrettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'homepage/public/**',
      'tests/ui/**',
      // Not an npm workspace: a Python tool with its own gitignored venv
      // that happens to vendor JS assets (matplotlib/torch/pip/werkzeug
      // debugger bundles). Never present in CI (gitignored), only shows
      // up if a dev has run pip install locally.
      'dev-tools/**',
    ],
  },

  // Base ESLint recommended for plain JS config files at the repo/workspace
  // root (this file, postcss.config.js, tailwind.config.js). The TS-aware
  // configs below are deliberately scoped to files: ['**/*.{ts,tsx}'] —
  // typescript-eslint's `recommended`/`base` presets carry no `files`
  // restriction of their own, so without this scoping they'd apply the TS
  // parser (and rules like `no-require-imports`) to this very file.
  js.configs.recommended,

  // This config file itself: CommonJS (root package.json has no "type":
  // "module", so `.js` here is CJS) — needs `require`/`module` as globals.
  {
    files: ['eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // ---- TS/TSX source in the three workspaces ----
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    rules: {
      // On deliberately: the 2026-08-18 repo audit specifically asked for
      // this, and backend/src has been `any`-free since PR #265. The two
      // pre-existing uses (both in homepage/src/__tests__/, both an
      // intentionally-untyped recharts mock passthrough) already carry a
      // justified inline eslint-disable — see the PR description for the
      // per-site judgement call.
      '@typescript-eslint/no-explicit-any': 'error',

      // Downgraded to warn: ~60 pre-existing call sites across
      // backend/src (console.error/console.warn — captured into the
      // admin log ring by the stdout/stderr tee in backend/src/logRing.ts
      // regardless of whether they go through the `log` wrapper, see
      // backend/src/log.ts) and homepage/src (error/warn logging plus
      // deliberate `[espConfig]`/`[SetupWizard]`/`[Step5]`-prefixed trace
      // logging for the notoriously fiddly ESP setup-wizard flow — not
      // debug litter). Treating an established, intentional logging
      // pattern as a hard error would fail the build on architecture, not
      // on a bug; `warn` still surfaces genuinely-new stray console.log
      // calls in `npm run lint` output without blocking CI on them.
      'no-console': 'warn',

      // Recognise the "destructure-to-omit" idiom already used in the
      // codebase (e.g. backend/src/app.ts's `const { maxAge: _maxAge,
      // ...clearOpts } = ...` to strip a property before passing the
      // rest along) as intentionally unused, rather than an error.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // ---- backend: Node runtime ----
  {
    files: ['backend/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ---- homepage: browser runtime (Vite/React SPA) ----
  {
    files: ['homepage/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Correctness: violating the Rules of Hooks is a real bug (wrong
      // hook call order/conditional hooks), so this stays an error.
      'react-hooks/rules-of-hooks': 'error',
      // Stale-closure bugs are real but exhaustive-deps also has a real
      // false-positive rate against deliberate "run once on mount" /
      // "run only when this one id changes" effects (see the three
      // pre-existing disables reviewed in the PR description). `warn`
      // surfaces new cases for review without hard-failing the build on
      // a pattern the codebase already uses correctly in several places.
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // ---- homepage test files: jsdom + vitest globals (globals: true in
  // homepage/vitest.config.ts) on top of the browser set above ----
  {
    files: ['homepage/src/__tests__/**/*.{ts,tsx}', 'homepage/src/test-setup.ts'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },

  // eslint-config-prettier LAST so its rule-disabling overrides win and
  // formatting rules never fight `prettier --write` (lint-staged).
  eslintConfigPrettier,
);

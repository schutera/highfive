# Frontend Plan — next-phase improvements

Synthesised on **2026-04-26** from four parallel audits (perf, WCAG 2.2 AA, UX flows, architecture + tests). Audit transcripts are in this session's task output files; the consolidated findings below are the actionable subset.

The 2026 redesign (commit `4e18c81`) shipped the visual layer and easy-win accessibility (focus rings, ARIA on icons, `prefers-reduced-motion`). What it missed are **structural** patterns: skip links, landmarks, focus trap on modals, contrast measurement on mute tokens, and a real first-paint regression — `esptool-js` accidentally leaks into the entry graph.

This plan stays opinionated and lean. Items are grouped by phase, with file:line citations and effort estimates so any agent (or human) can pick one up.

---

## Phase 1 — must-fix (real bugs, correctness, AA blockers)

These either represent regressions, real correctness holes, or fail concrete WCAG 2.2 AA criteria. Fix before claiming "modern, accessible homepage."

| #    | Item                                                                                                                                                                                                                                                                                                 | File / line                                                                            | Effort | Note                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1  | **`esptool-js` leaks into entry chunk** — `manualChunks` rule `id.includes('esptool-js')` captured Vite's `__vite__preloadHelper` into the esptool bundle, which the entry now synchronously imports. Every page including `/` pays ~50 KB gzip for esptool. The "89 KB first paint" claim is wrong. | `homepage/vite.config.ts:75`                                                           | 1 h    | Narrow rule to `id.includes('node_modules/esptool-js/')`. Verify entry no longer imports `esptool-*.js`.                                                           |
| 1.2  | **No skip-to-main link** anywhere                                                                                                                                                                                                                                                                    | `homepage/src/App.tsx:44` (add); `style.css:472` (`.sr-only-focusable` already exists) | 0.5 h  | SC 2.4.1 Bypass Blocks                                                                                                                                             |
| 1.3  | **`<main>` landmark missing** on HomePage and DashboardPage                                                                                                                                                                                                                                          | `pages/HomePage.tsx:13`, `pages/DashboardPage.tsx:75`                                  | 0.25 h | SC 1.3.1 / 4.1.2                                                                                                                                                   |
| 1.4  | **DashboardPage has zero `<h1>` on mobile** — `SiteHeader.tsx:49` h1 is `hidden md:block`                                                                                                                                                                                                            | `components/SiteHeader.tsx:49`                                                         | 0.25 h | SC 1.3.1 / 2.4.6. Either drop `hidden md:block` for the heading or render an `sr-only` h1.                                                                         |
| 1.5  | **Mobile sheet has no focus trap, no Escape handler, no focus return**                                                                                                                                                                                                                               | `pages/DashboardPage.tsx:170-216, 308-352`                                             | 2 h    | SC 2.4.3. After backdrop click or Escape, focus is lost to `<body>`.                                                                                               |
| 1.6  | **Map zoom is mouse-only** — `zoomControl={false}` removed +/- buttons; map container has no `tabIndex` so keyboard arrow-pan can't reach it                                                                                                                                                         | `components/MapView.tsx:351`                                                           | 0.5 h  | SC 2.1.1. Re-enable `zoomControl` or expose explicit zoom buttons.                                                                                                 |
| 1.7  | **`--hf-fg-mute` contrast ~3.4:1** against paper background; used widely as body-level small text                                                                                                                                                                                                    | `style.css` (`--hf-ink-mute` value) + audit usages                                     | 1 h    | SC 1.4.3. Bump to `oklch(50% 0.015 60)` or stop using for body text — replace with `--hf-fg-soft` (~7:1).                                                          |
| 1.8  | **No catch-all 404 route** — typo'd URLs render empty Suspense shell forever                                                                                                                                                                                                                         | `src/App.tsx:44-54`                                                                    | 0.5 h  | Add `<Route path="*" element={<NotFound/>}/>` with bee mascot + Back to Home, OR `<Navigate to="/" replace />`.                                                    |
| 1.9  | **Dashboard has no zero-modules empty state** — empty map, `0/0 Online` pill, floating list never appears                                                                                                                                                                                            | `pages/DashboardPage.tsx:124-148, 65-68`                                               | 0.75 h | When `!loading && !error && modules.length === 0`, render a card pointing at `/setup`. Also fixes the `[47.78, 9.61]` hardcoded fallback center being meaningless. |
| 1.10 | **ModulePanel error cascades to parent `setError`** — one failed `getModuleById` blanks the whole map                                                                                                                                                                                                | `pages/DashboardPage.tsx:160-163, 210-213`                                             | 0.5 h  | Show error inside the panel only; preserve the map context.                                                                                                        |
| 1.11 | **Step 5 health-check fires on mount before user is on home WiFi** — lands on "Backend Not Reachable"; the `wifiReminder` aside only shows in WAITING branch                                                                                                                                         | `components/setup/Step5Verify.tsx:41-44, 282-285`                                      | 0.5 h  | Surface the wifi reminder prominently in `backendReachable === false`.                                                                                             |
| 1.12 | **Dead `Module` type in `types/index.ts`** — wrong shape (`location: [number, number]` tuple, no `ModuleId` brand). Will silently bind on the next stray import.                                                                                                                                     | `src/types/index.ts:1-7`                                                               | 0.25 h | Delete the `Module` export; keep only `BEE_TYPES`.                                                                                                                 |
| 1.13 | **`api.ts` accepts raw `string` for module IDs** — `getModuleById(id: string)` and `getModuleLogs(id: string)` interpolate into URLs without re-validating. The `ModuleId` brand exists exactly to prevent this.                                                                                     | `services/api.ts:54, 69`                                                               | 0.5 h  | Change parameter type to `ModuleId`. Call sites already pass branded values; just stop discarding the proof.                                                       |

**Phase 1 total: ~8 h.** All low-risk, file-disjoint enough to parallelise.

---

## Phase 2 — should-fix (clear improvements, defer if pressed)

Real value, not blockers.

### Performance

- **Move `firmware.bin` out of `src/assets/`** to `public/firmware.bin` referenced by URL string; remove duplicate import in `Step2Flash.tsx:7`. Today the 4 MB blob is part of the SetupWizard's static graph. Effort 1 h. (`useSetupWizard.ts:8`, `Step2Flash.tsx:7`)
- **Preconnect for backend API origin** in `index.html`. Saves 100–300 ms on `/dashboard` cold load. Effort 0.25 h.
- **AVIF sibling for hero + responsive `srcset`** via `<picture>`. ~40–70 KB saved on mobile LCP. Build-time only, no new dep. Effort 1.5 h. (`HomePage.tsx:25-36`, `index.html:18`)

### Accessibility

- **`Step4Configure` field-level error wiring** — inputs lack `aria-invalid` / `aria-describedby` even though `configError` is `role="alert"` outside them. SC 3.3.1 / 3.3.3. (`Step4Configure.tsx:138-148, 257`)
- **Show-password button**: drop the conflict between state-changing `aria-label` and `aria-pressed`. Pick one pattern. SC 4.1.2. (`Step4Configure.tsx:184-189`)
- **Stripe `aria-disabled` link** is still tabbable + right-clickable. Render `<button disabled>` when `STRIPE_LINK === '#'`. (`HiveModule.tsx:86-102`)
- **`focus:` → `focus-visible:`** on form inputs; the current `focus:ring-hf-honey-300` is ~1.5:1 contrast and fires on mouse focus. Use `focus-visible:ring-hf-honey-500`. (`AdminKeyForm.tsx:53`, `Step4Configure.tsx:147,164,182`)
- **`scroll-padding-top`** on SetupWizard scroll container so sticky header doesn't obscure focus. SC 2.4.11. (`SetupWizard.tsx:102`)

### UX friction

- **Step 2 "Skip — already flashed"** rendered conditional on `flashStarted` or after a flash error, not always-visible below Next. (`Step2Flash.tsx:321-331`)
- **Hero subtitle copy** — replace `/haɪv/ /haɪv/` IPA with a real value prop ("Wild bees, watched."). Keep phonetics as `aria-label` or footnote. (`i18n/translations.ts:22, 381`)
- **AssemblyGuide placeholder photos** push text below fold — drop the empty 16:9 placeholder until real photos land. (`pages/AssemblyGuide.tsx:32-54`)
- **Persist setup wizard state** — `currentStep`, `flashComplete`, `moduleName` to `sessionStorage`. A page reload between Step 3 (AP join) and Step 4 (back to browser) loses everything. (`useSetupWizard.ts:54-72`)
- **Cache GitHub releases response** in `sessionStorage` for the session. Avoids unauthenticated rate-limit hits (60/h/IP) on every wizard mount. (`useSetupWizard.ts:107-137`)
- **Status pill `0/0` → `—`** when `modules.length === 0`. (`DashboardPage.tsx:65-68`)
- **`Step4Configure` password `minLength={8}`** — WPA2 requires ≥8; server rejects silently today. (`Step4Configure.tsx:173-183`)
- **`ErrorBoundary` doesn't reset on navigation** — wrap with `key={location.pathname}` so a render error doesn't strand users on the boundary forever. (`ErrorBoundary.tsx:30-75`)

### Architecture / patterns

- **`useAsync<T>(fn, deps)` hook** — replaces 4 hand-rolled `loading/error/data/reload` triads with subtly different retry semantics. ~25 lines, no deps. (DashboardPage, ModulePanel, Step5Verify, useSetupWizard)
- **`storage.ts` module** with named keys for `'hf_admin'`, `'hf_admin_key'`, `'hf-theme'`, `'lang'`. Currently three string-literal callsites. (`api.ts:70`, `ModulePanel.tsx:8`)
- **`useAdminMode()` hook** — extracts the `?admin=1` + sessionStorage logic out of `ModulePanel.tsx:18-26`. (`App.tsx` would seed it on mount.)
- **Add `lint` script + flat ESLint config** + wire into CI. Today the two `// eslint-disable-next-line` comments reference rules that aren't enforced. (`package.json:6-12`)
- **Remove `ModulePanelProps.module` redeclaration** — import `Module` from `@highfive/contracts`. (`ModulePanel.tsx:28-32`)

### Tests (top three to add)

1. **`AdminKeyForm` interaction test** — render with no key → type input → submit asserts `onSubmit` fires; empty submit asserts not called; `error` prop asserts `role="alert"` and `aria-invalid`.
2. **`ModulePanel` admin flow test** — `?admin=1`, mock `getModuleLogs` 401 → asserts inline form re-appears and storage cleared; "forget" click asserts storage cleared.
3. **`useSetupWizard` baseline + detection test** — `vi.useFakeTimers()`, mock `getAllModules` returning `[A]` then `[A,B]` → asserts `state.detectedModule === B`, polling stopped, interval cleared. Plus `MAX_POLLS` exceeded path.

**Phase 2 total: ~10 h.** Many parallelisable.

---

## Phase 3 — polish (above the line; defer freely)

Pulled from the audits' polish sections. Drop into a single sweep when the team is ready, or grab them individually as they come up. Not blocking deploy.

- **Tiny service worker** (~50 lines, no Workbox) for cache-first on `assets/*` and stale-while-revalidate on `index.html` + `/api/modules`. **Caveat**: must include a kill-switch SW that unregisters itself, and gate behind `import.meta.env.PROD`. Field-deployed dashboard genuinely benefits from offline tolerance, but SW is "easy to ship, hard to un-ship." Effort 3-4 h.
- A11y: aria-label on `SiteHeader`, MapView cluster `divIcon` accessible name, `prefers-reduced-motion` gating on Leaflet `flyTo`, larger close-buttons (`p-1.5` → `w-10 h-10`), Step5Verify `role="alert"` scoping.
- UX: Mobile sheet drag-handle is decorative — remove or wire swipe-to-dismiss. Cancel-setup affordance in SetupWizard. Skeleton states for Dashboard list/sheet (only the map shows a spinner today). Brave/Arc/Opera browser-detection regex.
- Architecture: `TelemetryEntry` move from `services/api.ts` to `@highfive/contracts`. `SiteHeader variant="glass"` is dead — adopt or drop. GitHub release JSON validation. `t()` typed `tArray()` overload to remove the `as unknown as string[]` cast in SetupWizard.

---

## Explicit non-goals

| Item                                               | Reason for rejecting                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Render-smoothness memoization (Frontend Option B)  | At ~10 modules, MapView re-renders on `loadModules()` are fine. Revisit at 200+ markers.                                             |
| React Query / SWR                                  | Two read endpoints, no cross-route cache reuse. A 25-line `useAsync` solves the duplication; cache layer is overkill.                |
| Replace `react-leaflet`                            | Leaflet only loads on `/dashboard` (lazy split correct). Days of work to save ~30 KB on a non-LCP route.                             |
| Inline critical CSS                                | CSS is 31 KB raw / 6 KB gzip, parallel-fetched. LCP is the hero, not text.                                                           |
| Self-hosting webfont                               | None used; system stack already in place.                                                                                            |
| Persistent top-nav across pages                    | `SiteHeader` exists; flow is linear (Module → Assembly → Setup → Dashboard).                                                         |
| Dashboard tabs / filters                           | Map clustering + bounds-list does it for ≤10 modules.                                                                                |
| Replace `sessionStorage` admin gate with real auth | Intentional, documented, lean. A login screen is a feature, not a polish.                                                            |
| Splitting `useSetupWizard` per step                | Cross-step refs (`baselineModuleIdsRef`, `lanIpRef`, `pollCountRef`) are genuinely shared. Splitting would force prop-drilling them. |

---

## How to use this plan

- **Phase 1** items can be split across parallel agents (file-disjoint), or one agent can grind them in a single PR. Suggested first PR: items 1.1, 1.2, 1.3, 1.4 — small surgery, all visible.
- **Phase 2** is best done after Phase 1 lands. Group by area (perf / a11y / UX / arch), one PR per area.
- **Phase 3** items grab one at a time as drive-by improvements; not blocker material.

Each item has a file:line so a fresh agent can pick it up cold. Skip items that no longer apply once earlier ones land (e.g. fixing `--hf-fg-mute` may obviate several individual contrast polish items in Phase 3).

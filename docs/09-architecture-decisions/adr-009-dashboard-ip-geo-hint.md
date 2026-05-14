# ADR-009: Dashboard map uses a server-side IP-geo hint, not the existing `GEO_API_KEY`

## Status

Accepted.

## Context

Issue [#14](https://github.com/schutera/highfive/issues/14) asked for the
dashboard to open zoomed near the visitor rather than on the default
Lake Constance centre. Two layers of geolocation are needed:

1. **Permissionless "first paint"** — a coarse, no-prompt centre so the
   map paints near the user from the very first frame. Accuracy of
   ~10–50 km (city-level) is enough; we just want Berlin instead of
   Lake Constance for a visitor in Berlin.
2. **Precise location on user request** — `navigator.geolocation.getCurrentPosition()`
   triggered by an explicit click on the in-map "show my location"
   control, gated by the browser's permission prompt. The browser
   handles the permission machinery, but the UX correctness of this
   path is **not** automatic — see "Update: Permissions API pre-check"
   below.

The interesting question is the first layer. We already ship a Google
Geolocation API key (`GEO_API_KEY`) — the ESP firmware sends nearby
Wi-Fi BSSIDs and gets coordinates back. Re-using that key for the
dashboard's IP-geo hint felt like the obvious move; it turned out not
to work, for two independent reasons:

- **Server-side, the key locates the wrong machine.** Google's
  Geolocation API supports `considerIp: true`, but only ever looks at
  the _caller's_ IP. If the backend makes that call, Google sees the
  backend's datacenter address, not the visitor's. There is no
  documented way to ask the API to geolocate a third-party IP.
- **Client-side, the key would be in the bundle.** Calling the API
  directly from `homepage` would put `GEO_API_KEY` (or a separately
  provisioned referrer-restricted twin) into the JS shipped to every
  visitor. Even with HTTP-referrer restrictions, that is a per-page-view
  billable, client-visible secret. CLAUDE.md explicitly forbids the
  dev-fallback-as-prod-key pattern; this would inherit the same
  smell on a different axis.

A separate problem class is IP→geo databases (MaxMind GeoLite2, etc.).
These are accurate, free, and self-hostable, but require an additional
binary asset (~30 MB) refreshed monthly. We didn't want to take on the
deployment overhead before knowing whether the feature would prove
its keep.

## Decision

Add a small backend endpoint `GET /api/user-location` that proxies a
free, key-less IP-geolocation service (ipapi.co — 30 k requests/month
on the free tier, no signup). It:

1. Resolves the visitor's IP via `req.ip`, honouring `X-Forwarded-For`
   only when the immediate hop comes from `loopback | linklocal | uniquelocal`
   (Express's stock `trust proxy` preset for "trusted reverse proxies
   only"). This is set once on the `app` instance in
   `backend/src/app.ts`.
2. Short-circuits to **204 No Content** for loopback/RFC-1918/IPv6
   ULA addresses so dev environments don't pointlessly hit ipapi.co
   with `::1`. Tested via `isPrivateOrLoopbackIp` in
   `backend/src/userLocation.ts`.
3. Caches lookups in memory for 1 hour, keyed by normalised IP. The
   cache is per-replica; multi-replica deployments amortise to one
   upstream call per replica per visitor per hour. Acceptable.
4. On upstream failure (network, non-2xx, or ipapi.co's `{error: true}`
   200-with-error-flag rate-limit response) returns **503** with
   `{error: 'user-location unavailable'}`. The frontend treats null
   responses as "no hint" and silently keeps the default centre.

The homepage's `MapView` accepts a `userLocationHint` prop. When it
transitions from null to a value, `MapController` does a single
`map.flyTo(...)` at zoom 11 (regional). The `hintApplied` ref inside
`MapController` is a one-shot latch — both the hint effect and the
`selectedModule` effect set it after firing. If a module-selection
flyTo (or a late-arriving hint) already happened, the late one is
suppressed. The precise-GPS click in `LocateControl` is a separate
imperative `map.flyTo` that does **not** consult the latch — it's a
deliberate user action and always wins.

## Alternatives considered

- **Reuse `GEO_API_KEY` server-side.** Rejected — Google's
  `considerIp:true` locates the caller, not an arbitrary IP.
- **Reuse `GEO_API_KEY` client-side with HTTP-referrer restriction.**
  Rejected — per-page-view billable, client-visible, and inconsistent
  with CLAUDE.md's "no client-visible dev fallback" stance.
- **Self-host MaxMind GeoLite2.** Deferred. Adds a binary asset + a
  monthly refresh job. Revisit if ipapi.co rate-limits us in practice.
- **Browser-only flow (no IP-geo)** — just the locate button. Rejected
  in chat with the maintainer: the explicit ask was "feel like Google
  Maps", which means _no_ upfront permission prompt for the rough
  centre. A button-only flow leaves first-time visitors looking at
  Lake Constance regardless of where they are.
- **Persist precise GPS across reloads via localStorage.** Deferred —
  the browser already remembers the permission grant, so re-fetching
  is one click. Premature complexity.

## Consequences

**Positive**:

- Zero permission prompt for the first-paint centre. Matches the
  Google Maps UX the maintainer specifically called out.
- `GEO_API_KEY` stays server-side, never shipped to the homepage.
- Failure mode is the most boring possible: 503 → null → default
  centre. The dashboard works unchanged if ipapi.co is down.

**Negative**:

- A third party (ipapi.co) now sees the visitor's IP. The user IP is
  not joined to any HiveHive identifier and is not logged on our
  side, but it does briefly leave our infrastructure. Whether this
  needs a footer disclosure is a UX call the maintainer can make
  later — the data flow itself is small, advisory-only, and not
  used for anything but a map centre.
- Free-tier rate limits (30 k/month/IP for ipapi.co). At one cached
  lookup per visitor IP per hour per replica, this is comfortable for
  current traffic. If we ever hit the limit, the route degrades to
  503 → null → default centre rather than failing the page.
- The in-memory cache is not shared across replicas. Not a bug, just
  less efficient than it could be. Don't add Redis for this.

**Forbidden**:

- Don't put any third-party API key into the `homepage` bundle for
  this feature. The point of going through a backend proxy is that
  the key (or, in ipapi.co's case, the lack of a key + the rate-limit
  surface) stays server-side.
- Don't change the 503-on-failure contract to a 200-with-null-body.
  That would be the silent-failure pattern the project's
  `senior-reviewer` agent rejects on sight; the route distinguishes
  "we cannot help" (503) from "we explicitly decline to help"
  (204 for private IPs).

## Update: Permissions API pre-check (added during senior-review round 3 on issue #14)

The original framing of point 2 above — "the browser handles it" —
turned out to be load-bearing wrong. During in-browser testing the
maintainer found that after the first permission deny, subsequent
clicks on the locate button produced **no visible feedback** —
`navigator.geolocation.getCurrentPosition()` resolves to the error
callback synchronously after a prior deny, fast enough that the
busy-spinner CSS animation never visibly starts and the `title`
attribute update is invisible to a user who isn't hovering. Full
post-mortem is logged in [chapter 11](../11-risks-and-technical-debt/README.md)
under "Locate-button felt dead after the first permission deny".

The fix in `homepage/src/components/MapView.tsx`'s
`LocateControl::onClick` is a `navigator.permissions.query({name:
'geolocation'})` pre-check: if the API reports `'denied'`, the
button short-circuits to an explicit "Location blocked — allow in
browser site settings" tooltip and skips the silent
`getCurrentPosition` call entirely. The Permissions API call is
gated by a `'permissions' in navigator` feature-test plus a
try/catch (Safari's geolocation-permission query is historically
flaky), so unsupported browsers fall through to the original code
path.

The pre-check is therefore **load-bearing UX** for the precise-location
layer; do not remove it without replacing it with an equivalent
mechanism that guarantees a visible, hover-independent state change
on the second-click-after-deny path. If this guarantee weakens,
`homepage/src/__tests__/MapView.test.tsx`'s
`short-circuits via Permissions API when geolocation was previously
denied` test will fail.

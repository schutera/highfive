# ADR-014: Weather correlation overlay uses Open-Meteo direct from the browser

## Status

Accepted.

## Context

Wildbee nesting activity correlates strongly with weather: temperature
gates flight onset, precipitation pauses foraging, wind dampens
returns. Operators reading the dashboard previously had to cross-check
activity spikes against a separate weather app — a manual, error-prone
loop. The ask was to overlay activity (image uploads per hour/day) on
the same chart as temperature and precipitation at the module's
location.

Three orthogonal questions had to be settled before implementation:

1. **Where does the weather data come from?** A keyless service we can
   call from a browser, or a paid/keyed service we have to proxy.
2. **Does the call go browser-direct or via a backend proxy?**
   Browser-direct skips one hop and saves a cache layer; a proxy lets
   us hold the key (if any) and cache aggressively.
3. **Which chart library?** None exist in the repo today. Anything we
   add bloats the dashboard chunk.

We also had to settle how to project the time series we already have.
`image_uploads` exposes per-upload rows; the chart needs bucketed
counts. We picked dense per-bucket projection (empty hours → `count:
0`) on the duckdb-service side — see "Dense buckets" below.

## Decision

### Weather data: Open-Meteo

We use [Open-Meteo](https://open-meteo.com) for hourly weather:

- No API key, no signup.
- CORS open — callable from the browser.
- 10 000 requests/day/IP gratis; the dashboard's expected call volume
  is well under this even per power user.
- Past + forecast in one endpoint with `past_days=N&forecast_days=1`.
- ISO-8601 timestamps in UTC when `timezone=UTC` is set, matching the
  duckdb-service activity buckets.

The Open-Meteo client lives at
`homepage/src/services/weather.ts`'s `fetchHourlyWeather` and is
intentionally tiny: a single `fetch`, a single `try { ... } catch
{ return [] }` so a network blip degrades the overlay to "weather
unavailable" rather than red-bannering the dashboard.

### Transport: browser-direct, no backend proxy

The browser calls Open-Meteo directly. The HiveHive backend is **not**
in the request path. Reasons:

- No key to keep secret — the whole point of a proxy with a public API
  is the secret it holds, and Open-Meteo has none.
- No cache to manage — Open-Meteo's free tier covers the call rate at
  current dashboard usage. A backend cache layer would be premature.
- One fewer hop on every chart load (latency, error surface, and
  Docker-Compose moving parts).
- A future proxy is straight-line additive if call volume rises: the
  contract is just the same JSON shape, and the homepage's
  `fetchHourlyWeather` becomes a fetch against our own backend with
  the same response. Nothing about today's wire shape forecloses that
  refactor.

The activity series goes through our backend, since it joins to a
HiveHive identifier (the module-id) and lives in our DuckDB. The
weather series does not — it's geographic, public, and stateless.
The split is intentional.

### Chart library: Recharts

The homepage had no chart library before this feature. We picked
[Recharts](https://recharts.org):

- React-native (composable JSX primitives — `<ComposedChart>`,
  `<Bar>`, `<Line>`), no separate render engine to learn.
- Dual Y-axis is first-class via `yAxisId` — we need uploads-count on
  the left and °C on the right.
- Smaller install footprint than Plotly; less wiring than Visx.
- Permissive license (MIT).

The bundle cost is non-trivial — recharts lands in the dashboard
chunk. Specifically, Recharts 3.x transitively pulls in
`@reduxjs/toolkit`, `react-redux`, `immer`, and `victory-vendor`
(see `package-lock.json` under `node_modules/recharts`'s
`dependencies`), so picking Recharts effectively puts a small
Redux runtime into the dashboard chunk for chart-state purposes.
That cost was not visible from the package's surface API at
selection time, but it is real. Code-splitting the chart out via
`React.lazy` is a follow-up if the chunk size becomes painful;
for now the chart loads eagerly with the rest of the module
panel.

### Dense bucket projection on the server

The duckdb-service endpoint
`/modules/<id>/activity_timeseries` does NOT return only the buckets
that contain uploads. It returns every bucket in the window, filling
empty ones with `count: 0`. The chart consumer relies on this — see
[`api-contracts.md` → `ActivityTimeSeries`](../08-crosscutting-concepts/api-contracts.md#activitytimeseries--bucketed-upload-counts)
for the wire contract. Without this, the chart would silently stitch
across silent hours: a quiet 02:00–05:00 stretch in a 24-h hourly
window would visually become a flat slope from 01:00 to 06:00 — a
misrepresentation of "the hive was silent" as "the hive was somewhat
active".

We do it server-side rather than client-side because (a) the bucket
math is identical to the SQL aggregation and lives one step away
from `date_trunc` in
`duckdb-service/routes/modules.py`'s `activity_timeseries`, and
(b) the chart consumer is a thin formatter that should not have to
know how to fabricate buckets matching DuckDB's truncation semantics.

## Alternatives considered

- **OpenWeatherMap.** Requires a key; key would have to be proxied
  server-side (per CLAUDE.md "no client-visible dev fallback"). A
  proxy is fine but the extra surface is hard to justify when
  Open-Meteo is keyless and free at our call volume.
- **DWD ICON / Bright Sky.** Germany-only; we can't assume operator
  modules will always be in DE coverage.
- **Backend proxy + Redis cache.** Skipped on YAGNI grounds. If
  Open-Meteo throttles us at some future scale, retrofit one. Today
  the chart is one fetch per panel open, gated by an existing
  loading state.
- **Pearson / Spearman correlation coefficient displayed numerically.**
  Considered for v1. Rejected — the visual overlay is enough to spot
  the patterns operators care about, and a single number would
  collapse meaningful structure (e.g. "warm and dry → flight" is not
  monotonic with temperature; there is an upper cut-off). Revisit if
  power users ask.
- **Visx.** More flexible than Recharts but lower-level; we'd have
  to wire the dual axis and the composed bar+line by hand. Not worth
  the build-out for one chart.
- **Plotly.** Heavier than both; pulls in a separate render engine.

## Consequences

**Positive:**

- Zero secrets added to the homepage or the backend.
- Zero new infrastructure (no cache, no proxy, no key rotation).
- The chart degrades gracefully: a flat Open-Meteo failure leaves
  the activity bars + a "weather unavailable" hint; a missing
  module location (Sentinel `(0,0)` per ADR-006 + chapter 11
  "First-boot geolocation race") suppresses both fetches and
  renders a "location unknown" notice.
- The wire shape (`ActivityTimeSeries`) is pinned in
  `@highfive/contracts`, so backend ↔ homepage drift becomes a
  TypeScript compile error (ADR-004).

**Negative:**

- Recharts in the dashboard chunk increases bundle size. Acceptable
  trade-off given the feature's value; code-split if it becomes
  painful.
- Operators on a corporate network that blocks `api.open-meteo.com`
  see "weather unavailable" indefinitely. The fallback path
  exists; surface to the operator via the inline notice.
- Open-Meteo see the visitor's lat/lng (per-call). The coordinates
  are a public, fuzzed-by-design value (`Module.location` is the
  Google-Geolocation result, intentionally coarse — see
  ADR-006 / chapter 11), but the request itself does leave our
  infrastructure. Briefly. The browser is the originator; nothing
  HiveHive logs is augmented by this traffic.

**Forbidden:**

- Don't move the Open-Meteo call to the backend "for security"
  without a real reason. The data is public; the call is keyless.
  Adding a proxy here is the kind of YAGNI gold-plating that
  reviewer rounds in PRs #42 and #104 already caught on other
  features.
- Don't drop the dense-bucket contract. If you're tempted to make
  `activity_timeseries` return only non-zero buckets "for
  performance", read `homepage/src/components/ActivityWeatherChart.tsx`'s
  merge logic first — it relies on aligned timestamps between
  activity and weather, and the gap-fill is what makes that work.

## References

- Endpoint reference: [`api-reference.md §1.6, §3.10`](../api-reference.md).
- Wire shape: [`api-contracts.md → ActivityTimeSeries`](../08-crosscutting-concepts/api-contracts.md#activitytimeseries--bucketed-upload-counts).
- ADR-004 (shared contracts package) — applies here unchanged.
- ADR-012 (IP-geo hint) — adjacent precedent for "browser-direct vs.
  backend proxy"; this ADR reaches the opposite conclusion because
  Open-Meteo has no key to keep secret.

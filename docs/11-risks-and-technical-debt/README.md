# 11. Risks and Technical Debt

Known issues that aren't bugs to be fixed in the current PR but that
future contributors must know about. Two sub-registers below:
**open issues** (active items in GitHub) and **lessons learned**
(things we paid for and don't want to relearn).

## Open issues

Tracked on GitHub at [schutera/highfive/issues](https://github.com/schutera/highfive/issues).
Highlights worth knowing about even if you're not assigned:

| # | Title (short) | Why it matters |
|---|---------------|----------------|
| [#18](https://github.com/schutera/highfive/issues/18) | Hardcoded Google Maps API key in `ESP32-CAM/esp_init.cpp:362` | Secret in source. Should be revoked in Google Cloud Console and re-issued via env var or build-time injection. |
| [#19](https://github.com/schutera/highfive/issues/19) | `StaticJsonDocument` size in ESP firmware | Risk of silent truncation on telemetry growth. |
| [#20](https://github.com/schutera/highfive/issues/20) | Capture interval is hardcoded | Should be configurable via the AP form. |
| [#21](https://github.com/schutera/highfive/issues/21) | Wi-Fi join feedback in AP form | Currently no UI signal that join failed; users only see a blank reload. |
| [#26](https://github.com/schutera/highfive/issues/26) | OTA firmware update support | Today every firmware update requires physical USB. Tracked as a feature request with a recommended ArduinoOTA-first phasing. |

## Field-name drift

The `modul_id` typo (missing "e") is **live on the wire** between
`image-service` and `duckdb-service` as of 2026-04-25. Don't fix it
without changing both ends in lockstep. Full discussion:
[../08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).

The `progess_id` / `hateched` typos in `backend/database.ts` were
fixed in commit `778c9b1`. Don't reintroduce them.

## Hardcoded secrets

- **Google Maps API key** in `ESP32-CAM/esp_init.cpp:362` — see
  [issue #18](https://github.com/schutera/highfive/issues/18). The
  key has been committed to git history; rotation is the right fix,
  not just removal.
- **Dev API key fallback** `hf_dev_key_2026` in `backend/src/auth.ts:4`
  — intentional for local dev. **Must** be overridden via
  `HIGHFIVE_API_KEY` for any non-local deploy. See
  [02-constraints](../02-constraints/README.md).

## Operational trade-offs (intentional, not debt)

- **Backend re-fetches on every request.** Stateless projection. No
  caching layer. Acceptable at the expected read volume; revisit if
  multi-tenant.
- **Stub classifier.** `stub_classify()` ships in production today.
  The data-flow contract is what MaskRCNN will fill — replacing the
  classifier doesn't change the persistence layer.

## Lessons learned

This section grows over time. Each entry is a problem we paid for —
write the lesson here so the next contributor doesn't repeat it.
Format: short title + **What happened** + **Why it happened** +
**How to avoid it next time**.

### ESP watchdog crashed every ~44 s in AP mode (fixed dfd454b)

**What happened.** First-time ESP32-CAM setup was impossible — the
board would crash and reboot every ~44 seconds while showing the
config form. `boot_count` climbed rapidly. The config form would
appear to save, then the saved values disappeared. `config.json not
found, using defaults` appeared on every boot.

**Why it happened.** The task watchdog (30 s) was initialised in
`setup()`, which then blocked inside `setupAccessPoint()` waiting
for user input. The `loop()` function — where the watchdog reset
was called — never ran during AP mode, so the watchdog starved
and triggered a panic.

**How to avoid it next time.** Any ESP code that blocks in `setup()`
must call `esp_task_wdt_reset()` inside its own loop. The fix is in
`ESP32-CAM/host.cpp::runAccessPoint()`. When adding a new long-running
setup-time task (HTTP server, captive portal, OTA flow), think about
the watchdog before deploying.

### Frontend / backend type drift before `@highfive/contracts`

**What happened.** Both the homepage and the backend declared their
own `Module`, `ModuleDetail`, `NestData`, `DailyProgress` interfaces.
The homepage's copy drifted (e.g. `nestId: number` vs the wire's
`nest_id: string`); some backend-only fields were missing on the
homepage. Bugs surfaced as missing dashboard data with no error
trace.

**Why it happened.** No shared package, no compile-time check, copy-paste
type definitions, no contract test.

**How to avoid it next time.** Add new wire types to
`contracts/src/index.ts` first; let TS compile errors guide the
implementations. Don't reintroduce per-service DTO copies — see
[../08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).

### Backend `database.ts` reading typo'd field names

**What happened.** `backend/src/database.ts` was reading `p.progess_id`
and `p.hateched` from `duckdb-service /progress` rows. Both are
typos — the actual fields are `progress_id` and `hatched`. Code "worked"
at runtime because every `DailyProgress` had `progress_id=undefined`
and `hatched=undefined` for the lifetime of the bug. Dashboard rendered
fine because nothing strictly required these fields. Fixed in `778c9b1`.

**Why it happened.** The typos had comments next to them ("Backend
name!") asserting they were canonical. No contract test exercised
the read.

**How to avoid it next time.** Treat any field whose spelling differs
by one letter from a real English word as a smell. Add a contract
test that reads a known row and checks the field values, not just
that the call succeeds.

### Three "PR-17 review" criticals (fixed `ea7dc73`, `0d1b48f`)

Caught only because reviewers cross-referenced `docker-compose.yml`,
`server.ts`, and the firmware loop while reading PR 17. None of the
three would have been caught by the existing test suites alone.

**1. Backend port mismatch.** `backend/src/server.ts` defaulted
`PORT=3001` (a legacy production value); the dev compose stack maps
`3002:3002` and the homepage API client targets `:3002`. The
container was listening on `3001`, host port `3002` was unbound, and
the dashboard couldn't reach the backend. Fix: set `PORT=3002`
explicitly in the backend service environment in
`docker-compose.yml`.

**2. `sendHeartbeat()` swallowed non-2xx responses.**
`readStringUntil('\n')` returned 0 (success) even on HTTP 500. The
firmware then carried on as if the heartbeat had landed; the silence
watcher couldn't tell the difference between a truly healthy module
and one that was repeatedly failing to register. Fix: parse the
status code from the first response line and return non-zero on
non-2xx; route the failure through `logbufNoteHttpCode` so admin
telemetry shows it.

**3. Task watchdog cadence on a knife-edge.**
`TASK_WDT_TIMEOUT_S = 30` with a 30 s `delay()` at the end of
`loop()` left zero slack for `captureAndUpload` (3 retries × 2 s +
JPEG encode + HTTP) plus heartbeat (5 s connect timeout). Worst-case
loop iteration could exceed 30 s and silently reboot mid-upload.
Fix: bump to **60 s** and `esp_task_wdt_reset()` immediately before
the long sleep so the timer starts fresh. See
[ADR-007](../09-architecture-decisions/adr-007-esp-reliability-breaker-and-daily-reboot.md).

**How to avoid it next time.** When a PR touches transport contracts
across more than one process boundary (compose ↔ container ↔ wire),
add the boundary to the e2e test in
`tests/e2e/test_upload_pipeline.py`. CI alone can't see the dev
stack misconfiguration; only an end-to-end test that reaches the
host-mapped port can.

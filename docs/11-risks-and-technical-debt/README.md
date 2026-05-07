# 11. Risks and Technical Debt

Known issues that aren't bugs to be fixed in the current PR but that
future contributors must know about. Two sub-registers below:
**open issues** (active items in GitHub) and **lessons learned**
(things we paid for and don't want to relearn).

## Open issues

Tracked on GitHub at [schutera/highfive/issues](https://github.com/schutera/highfive/issues).
Highlights worth knowing about even if you're not assigned:

| #                                                     | Title (short)                                                 | Why it matters                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [#18](https://github.com/schutera/highfive/issues/18) | Hardcoded Google Maps API key in `ESP32-CAM/esp_init.cpp`'s `getGeolocation` | Secret in source. Should be revoked in Google Cloud Console and re-issued via env var or build-time injection.               |
| [#19](https://github.com/schutera/highfive/issues/19) | `StaticJsonDocument` size in ESP firmware                     | Risk of silent truncation on telemetry growth.                                                                               |
| [#20](https://github.com/schutera/highfive/issues/20) | Capture interval is hardcoded                                 | Should be configurable via the AP form.                                                                                      |
| [#26](https://github.com/schutera/highfive/issues/26) | OTA firmware update support                                   | Today every firmware update requires physical USB. Tracked as a feature request with a recommended ArduinoOTA-first phasing. |

## Field-name drift

The `modul_id` typo (missing "e") is **live on the wire** between
`image-service` and `duckdb-service` as of 2026-04-25. Don't fix it
without changing both ends in lockstep. Full discussion:
[../08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).

The `progess_id` / `hateched` typos in `backend/database.ts` were
fixed in commit `778c9b1`. Don't reintroduce them.

## Hardcoded secrets

- **Google Maps API key** in `ESP32-CAM/esp_init.cpp`'s `getGeolocation` — see
  [issue #18](https://github.com/schutera/highfive/issues/18). The
  key has been committed to git history; rotation is the right fix,
  not just removal.
- **Dev API key fallback** `hf_dev_key_2026` in `backend/src/auth.ts:4`
  — intentional for local dev. **Must** be overridden via
  `HIGHFIVE_API_KEY` for any non-local deploy. See
  [02-constraints](../02-constraints/README.md).
- **WiFi password printed plaintext to Serial** — was unconditionally
  logged at the top of `setupWifiConnection` in `ESP32-CAM/esp_init.cpp`.
  Now gated behind `-DDEBUG_WIFI` and redacted by default (issue #41,
  fixed in `feat/onboarding-feedback`). Don't reintroduce the
  unconditional print — anyone with USB access used to walk away with
  the password in 5 s.

## Operational trade-offs (intentional, not debt)

- **Backend re-fetches on every request.** Stateless projection. No
  caching layer. Acceptable at the expected read volume; revisit if
  multi-tenant.
- **Stub classifier.** `stub_classify()` ships in production today.
  The data-flow contract is what MaskRCNN will fill — replacing the
  classifier doesn't change the persistence layer.

## Active tech debt

### Firmware version: three uncoordinated sources of truth

As of `upstream/main` HEAD `a3675de`, three different files each carry
a different "firmware version" string and each is read by a different
consumer:

| File / location                                                   | Current value | Read by                                                                          | Consumer                                                                                                |
| ----------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ESP32-CAM/VERSION`                                               | `carpenter`   | `ESP32-CAM/build.sh`                                                             | OTA manifest `homepage/public/firmware.json` `version` field                                            |
| `ESP32-CAM/esp_init.h` (`FIRMWARE_VERSION`)                       | `1.0.0`       | `logBootMarker` in `ESP32-CAM/logbuf.cpp`; boot log in `ESP32-CAM/ESP32-CAM.ino` | Telemetry sidecar `fw` field on every upload + boot log                                                 |
| `ESP32-CAM/client.cpp` (`FW_VERSION`, just above `sendHeartbeat`) | `honeybee`    | `sendHeartbeat`'s body string in `ESP32-CAM/client.cpp`                          | Heartbeat body `fw_version` field → `module_heartbeats.fw_version` → `Module.latestHeartbeat.fwVersion` |

So a single `carpenter` device today reports three different versions
on three different surfaces. ADR-006 documents the desired bee-name
convention but is currently flagged "Accepted (partial)" because the
implementation hasn't caught up.

**Proposed fix (next firmware PR):** make `ESP32-CAM/VERSION` the sole
source. Inject it via `platformio.ini`:

```ini
[env:esp32cam]
build_flags =
    ${env.build_flags}
    -DFIRMWARE_VERSION=\"$(shell cat ESP32-CAM/VERSION)\"
```

Delete the `#ifndef`/`#define` guards for `FIRMWARE_VERSION` in
`esp_init.h` and for `FW_VERSION` in `client.cpp` (just above
`sendHeartbeat`). Replace `String(FW_VERSION)` in `sendHeartbeat`'s
body string with `String(FIRMWARE_VERSION)`. `build.sh` continues
reading `VERSION` directly. One writer, three readers, no drift.

**Why it's not fixed in this PR.** PR 27 is documentation-only — the
plan is to land the doc-honest description first and let the firmware
unification be a small, focused next PR (ideally before the next field
deployment, or you will spend a debugging session figuring out which
"version" is real).

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

**1. Backend port mismatch (commit `ea7dc73`).**
`backend/src/server.ts` defaulted `PORT=3001` (a legacy production
value); the dev compose stack maps `3002:3002` and the homepage API
client targets `:3002`. The container was listening on `3001`, host
port `3002` was unbound, and the dashboard couldn't reach the
backend. Fix: set `PORT=3002` explicitly in the backend service
environment in `docker-compose.yml`.

**2. `sendHeartbeat()` swallowed non-2xx responses (commit `ea7dc73`).**
`readStringUntil('\n')` returned 0 (success) even on HTTP 500. The
firmware then carried on as if the heartbeat had landed; the silence
watcher couldn't tell the difference between a truly healthy module
and one that was repeatedly failing to register. Fix: parse the
status code from the first response line (in `sendHeartbeat`,
`ESP32-CAM/client.cpp`) and return non-zero on non-2xx; route the
failure through `logbufNoteHttpCode` so admin telemetry shows it.

**3. Task watchdog cadence on a knife-edge (commit `ea7dc73`).**
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

### Documentation drifted from code in PR 27 first-pass review

**What happened.** PR 27 (this one) introduced ADRs 004-007 and
updated arc42 chapters 05/06/08/11/12 to reflect PR-17's code. An
independent senior-developer review found six P0 factual errors in
the first-pass content: ADR-005 named a `module_silence_alerts` table
that doesn't exist (real impl is a column on `module_configs`);
ADR-007 named NVS namespace `"telemetry"` (real namespace is `"boot"`);
ADR-007 + esp-reliability.md claimed heartbeat status feeds the
breaker (it doesn't — heartbeat status only feeds `logbufNoteHttpCode`
for telemetry); ADR-006 described firmware version as a single source
of truth (three sources, all currently disagreeing); ADR-004 +
image-upload-flow.md + esp32cam.md collapsed two distinct heartbeat
endpoints (`POST /heartbeat` telemetry vs `POST /modules/<mac>/heartbeat`
post-upload aggregate) into one; production-deployment.md referenced
`docker-compose.production.yml` (real file is `docker-compose.prod.yml`)
on every step.

**Why it happened.** The first-pass author wrote the ADR/runtime-view
content from the **commit messages** of PR 17 rather than reading the
code that PR 17 merged. Commit messages summarise intent; code is
what shipped. A bee-name commit message says "single source of truth";
the code merged with three uncoordinated `#define` macros. A breaker
commit message says "feeds the same counter"; the code wires
heartbeat status to a different sink entirely.

**How to avoid it next time.** When writing or reviewing arc42
chapters, ADRs, or runtime-view docs, **read the actual files** in
`ESP32-CAM/`, `duckdb-service/`, `image-service/`, etc. and **cite
line numbers** in the doc text. If the doc claims the value of an NVS
key or the name of a DB column, the cited file must contain that
value or column. If a reviewer can't `git grep` your claim and find
it in code, it's not documentation, it's storytelling. The rule is
captured in the [CLAUDE.md never-violate list](../../CLAUDE.md).

### Drift sweep is not a substitute for a CI check

**What happened.** The PR closing #21/#34/#35 added ~30 lines of new
boot/setup code to `ESP32-CAM/ESP32-CAM.ino` and `esp_init.cpp`,
silently shifting every later line in those files. Multiple `path:line`
references in `docs/06-runtime-view/esp-reliability.md`,
`docs/09-architecture-decisions/adr-007-...md`, ADR-004, ADR-006, the
chapter-11 hardcoded-secrets entry, the chapter-11 firmware-version
table, the glossary, the api-reference, and four user-facing wizard
translation strings (plus the Step 3 wizard SSID hardcode) became
stale. Two consecutive senior-reviewer rounds caught new drift even
after the author wrote a "How to avoid it next time" lesson — the
manual sweep itself was the failure mode. The author also substituted
one wrong line citation (`esp_init.cpp:233`) for another (`:249`),
landed at a third (`:252`), and was still wrong — the `LED_GPIO_NUM`
removal a few minutes later shifted the file by another line, leaving
the citation pointing at `Serial.printf("PW length: …")` instead of
the plaintext-password log it was supposed to flag. The fourth round
of review caught it. By the time the citation was correct in the
moment, line numbers had moved again.

**Why it happened.** The original structural rule was "cite file:line
for every claim." That rule produces correct citations on the day
they're written, then guarantees stale citations the next time anyone
edits the cited file. Manual `git grep` sweeps before push are easy
to miss; humans re-grep for the patterns the previous review named,
not the patterns the current review will name. The lesson recorded
itself but the next round of fixes shipped with eight fresh stale
`client.cpp:NNN` citations the lesson would have caught.

**How it's avoided now.**

- **Citation form.** Prefer `path's <symbol>` or `path::symbol`
  (e.g. `client.cpp's sendHeartbeat`) over `path:line`. Symbols don't
  drift on line shifts; line numbers do. The senior-reviewer agent
  prompt at `.claude/agents/senior-reviewer.md` was updated to
  demand `git grep -n` verification before any `path:line` claim.
- **Mechanical gate.** `scripts/check-doc-citations.sh` walks every
  `path:line` reference in `docs/` and `CLAUDE.md`, reads the cited
  line in the current source, and reports MISSING / PAST_EOF /
  BLANK_LINE / AMBIGUOUS / OK with a content preview. Wired via:
  - `make check-citations` for manual runs.
  - `.husky/pre-push` so every push from a contributor with husky
    installed is verified.
  - A `doc-citations` job in `.github/workflows/tests.yml` so the
    same gate fires on every PR even if the contributor skipped
    husky. (This is the actual CI check the section's title promises.)
  - The "Standard end-of-implementation gate" section of CLAUDE.md
    instructs reviewers to inspect the report alongside the diff.
- **What the gate catches.** Missing files and past-EOF citations
  fail the push. Blank-line landings warn (the lessons-learned
  narrative legitimately quotes old citations as examples of past
  drift; those land on blanks after source moves on). Humans inspect
  the OK rows for "drifted to a closing brace / unrelated line"
  cases — the one drift form the heuristic can't catch.
- **Sweep i18n alongside docs.** The 7→5 second drift and the
  `HiveHive-Access-Point` SSID drift both lived in
  `homepage/src/i18n/translations.ts`, not in `docs/`. The lesson
  is "user-facing strings are a documentation surface."
- **Prose claims about device behaviour drift just like citations.**
  The LED redesign in this same PR made AP / Connecting / Connected
  modes silent in `lib/led_state/led_state.cpp`'s `ledOnAt`, but four
  unrelated surfaces still told the user to expect blinking — Step 5
  troubleshoot copy (EN + DE), `esp-flashing.md`'s "AP heartbeat
  pattern" line, and the `esp32-onboarding` skill's "LED should start
  flashing" line. None used `path:line`, so the citation gate could
  not catch them. When changing observable device behaviour (LED
  pattern, audible signal, boot sequence, captive-portal text), grep
  the whole repo (`docs/`, `homepage/src/i18n/`, `.claude/skills/`)
  for prose making the old promise.

**Resolution.** The Maps API key citations in chapters 3/5/11 were
left for the next editor to resolve. They surfaced in `make
check-citations` when the #39 fix added a `#include "module_id.h"`
to `ESP32-CAM/esp_init.cpp` and shifted the cited lines by one,
and were converted to the symbol form `esp_init.cpp`'s
`getGeolocation` in that same commit. The gate worked as intended.

### Same canonicalisation bug shipped at three call sites (issue #39)

**What happened.** PR-17 fixed the eFuse-MAC canonicalisation bug at
the `/upload` and `/heartbeat` seams (`client.cpp's postImage` and
`sendHeartbeat`) by routing `esp_config->esp_ID` through
`hf::formatModuleId`. The third call site —
`esp_init.cpp's initNewModuleOnServer`, which posts to `/new_module`
— was missed. Boards in the field have been failing module
registration with HTTP 400 on every boot, while image upload
(canonicalised) and heartbeat (canonicalised) both succeed. The
silent-failure mode hid behind a working dashboard.

**Why it happened.** The fix was scoped per call site instead of per
field. `esp_config->esp_ID` is the unsanitised input; the third
caller (in `esp_init.cpp` rather than `client.cpp`) was missed
during the original PR-17 review pass.

**How to avoid it next time.** When fixing a wire-shape bug on a
shared field, grep for the **field name**, not for the call sites
the bug report mentions. For HiveHive specifically: any future
canonicalisation change goes through `hf::formatModuleId`, and
`grep -rn 'esp_config->esp_ID' ESP32-CAM/` is the gate — every
result must either flow through the helper or be a comment/log.

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
| [#18](https://github.com/schutera/highfive/issues/18) | Hardcoded Google Maps API key in `ESP32-CAM/esp_init.cpp:362` | Secret in source. Should be revoked in Google Cloud Console and re-issued via env var or build-time injection.               |
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

- **Google Maps API key** in `ESP32-CAM/esp_init.cpp:362` — see
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

**Out-of-scope follow-up: pre-existing drift not fixed in this PR.**
The Maps API key citations in chapters 3/5/11 and any future drift
in files this PR didn't touch will surface in the
`make check-citations` report next time someone edits those files.
That's the gate's job now.

### `lib/<name>/` includes diverge between PIO and arduino-cli (issue #36, PR #55)

**What happened.** `bash ESP32-CAM/build.sh` (the arduino-cli release
path) failed to link with `undefined reference to hf::wifiStatusName`
and `hf::ledOnAt` after a clean checkout on a fresh box. Two source
files used path-prefixed includes for lib subdirectories
(`#include "lib/wifi_diag/wifi_diag.h"` in `esp_init.cpp`, and
`#include "lib/led_state/led_state.h"` in `led.h`); the other six
consumers used bare-name (`#include "module_id.h"` etc.). Under PIO
both forms work because `lib_dir = lib` adds every `lib/<name>/`
subdirectory to the include path AND auto-compiles its `.cpp` files.
Under arduino-cli with `--libraries ESP32-CAM/lib`, only **bare-name**
includes trigger the library-discovery → auto-compile → link chain.
The path-prefixed form resolves the header (so compile succeeds) but
never registers the library, so its `.cpp` is silently dropped from
the link.

**Why it happened.** The two outliers were probably written when the
codebase still had a flat layout, then survived the `lib/` refactor
because nobody re-ran `bash build.sh` end-to-end after that refactor.
PIO compiled fine, so the mismatch was invisible. The post-compile
guard added earlier in PR #55 caught a different `build.sh` bug
(quote-escaping doubled), but only after we got past the linker.
Manual end-to-end testing on a real ESP32-CAM was what surfaced this.

**How to avoid it next time.**

- When adding a new `ESP32-CAM/lib/<name>/` module, always include its
  header by **bare name**: `#include "<name>.h"`. Documented in
  [`docs/07-deployment-view/esp-flashing.md`](../07-deployment-view/esp-flashing.md)
  ("Adding a new `lib/<name>/` module").
- Don't trust `pio run` as the sole build verification when changing
  firmware. PIO and arduino-cli have different library-discovery and
  define-injection paths; "PIO is happy" doesn't mean `bash build.sh`
  is. The cheapest CI improvement here would be a job that runs
  `bash ESP32-CAM/build.sh` on PRs that touch `ESP32-CAM/`.
- The post-compile guard in `build.sh` covers macro-injection drift,
  not link-time symbol drift. Linker errors are loud, but they only
  fire when someone actually runs `build.sh`.

### Use-after-return on `esp_camera_fb_return` warm-up logging (issue #36)

**What happened.** Both warm-up loops in `ESP32-CAM/ESP32-CAM.ino`
(`setup()`'s sensor warm-up and the post-recovery loop) printed
`fb->len` _after_ calling `esp_camera_fb_return(fb)`. The driver may
reuse the buffer immediately, so the printed byte count was undefined
behaviour — it happened to look right because the buffer was usually
not yet reused, but a future driver/PSRAM pressure regime could print
zero, garbage, or trip a panic on a freed pointer.

**Why it happened.** The natural reading order ("get → log → release")
got reordered to "get → release → log" during a refactor that pulled
the release out of the success branch's tail. The log line and the
release sat next to each other so the order looked symmetric; the bug
hides in plain sight unless you remember `esp_camera_fb_return` is a
free.

**How to avoid it next time.** When releasing any pointer-bearing
resource (camera frame buffer, malloc, smart-pointer reset), capture
any value you still need into a local _before_ the release call. The
fix in the same lines is the canonical pattern:

```cpp
size_t fb_len = fb->len;
esp_camera_fb_return(fb);
Serial.printf("...%u bytes\n", (unsigned)fb_len);
```

Code review prompt: when you see a `Serial.printf` or `log` reading a
field through a pointer, look up to see whether that pointer was
released earlier in the same scope.

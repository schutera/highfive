# 11. Risks and Technical Debt

Known issues that aren't bugs to be fixed in the current PR but that
future contributors must know about. Two sub-registers below:
**open issues** (active items in GitHub) and **lessons learned**
(things we paid for and don't want to relearn).

## Open issues

Tracked on GitHub at [schutera/highfive/issues](https://github.com/schutera/highfive/issues).
Highlights worth knowing about even if you're not assigned:

| #                                                     | Title (short)                                                                | Why it matters                                                                                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#18](https://github.com/schutera/highfive/issues/18) | Hardcoded Google Maps API key in `ESP32-CAM/esp_init.cpp`'s `getGeolocation` | Secret in source. Should be revoked in Google Cloud Console and re-issued via env var or build-time injection.                                                                              |
| [#19](https://github.com/schutera/highfive/issues/19) | `StaticJsonDocument` size in ESP firmware                                    | Risk of silent truncation on telemetry growth.                                                                                                                                              |
| [#20](https://github.com/schutera/highfive/issues/20) | Capture interval is hardcoded                                                | Should be configurable via the AP form.                                                                                                                                                     |
| [#26](https://github.com/schutera/highfive/issues/26) | OTA firmware update support                                                  | Today every firmware update requires physical USB. Tracked as a feature request with a recommended ArduinoOTA-first phasing.                                                                |
| [#56](https://github.com/schutera/highfive/issues/56) | GPIO0 reconfigure trigger lands in DOWNLOAD_BOOT (and corrupts flash)        | Documented user path drops the chip into ROM bootloader; finger-roll variant reproduces a flash-read-err loop requiring re-flash. WiFi-fail auto-fallback is the working trigger today.     |
| [#57](https://github.com/schutera/highfive/issues/57) | Extract captive-portal `/save` logic into a host-testable helper             | The keep-current-on-empty contract has three layers (HTML attr, JS validator, server check); the server half is currently un-unit-testable. Land before adding a second keep-current field. |

## Field-name drift

The `modul_id` typo (missing "e") is **live on the wire** between
`image-service` and `duckdb-service` as of 2026-04-25. Don't fix it
without changing both ends in lockstep. Full discussion:
[../08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).

The `progess_id` / `hateched` typos in `backend/database.ts` were
fixed in commit `778c9b1`. Don't reintroduce them.

## Hardcoded secrets

- **Google Maps API key** in `ESP32-CAM/esp_init.cpp`'s `getGeolocation`
  `apiKey` local in the function body — see
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

### Setup wizard shipped two silent-success bugs (issues #43, #44)

**What happened.** Two failure modes in the setup wizard were
mis-classified as success or non-actionable: (a) when
`homepage/public/firmware.bin` was missing, Vite's SPA fallback served
`index.html` with HTTP 200, the wizard handed the HTML payload to
`esptool-js`, `writeFlash` silently no-op'd on garbage bytes, and
Step 2 flashed green in <1 s while the chip kept its old firmware;
(b) when the backend died during the 2-minute Step 5 poll window,
all 24 polls failed, the wizard set a single `verificationTimedOut`
flag, and the UI showed the orange "check the module" troubleshooting
screen — pointing the user at completely the wrong remediation.

**Why it happened.** Both bugs share the same shape: a fetch result
was fed to a side-effecting consumer (`writeFlash`, the
verification-classifier `setState`) without validating the response
shape beyond `response.ok`. Status code alone doesn't distinguish
"served firmware" from "served HTML fallback", and "all polls failed"
doesn't distinguish "ESP didn't show up" from "backend went silent".

**How to avoid it next time.** When a fetch result drives a
side-effecting consumer, validate the _shape_ of the response, not
just the status. For binary payloads: assert the `Content-Type` and
the magic byte before handing the bytes downstream. For polling
loops: track the failure category (network vs. semantic-empty), not
just success/fail, so the final state can route to the correct
remediation branch. Both fixes shipped in PR-B
(`fix/wizard-flash-and-poll-classification`).

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

### Captive-portal "hold BOOT, tap RESET" reconfigure trigger lands in DOWNLOAD_BOOT

**What happened.** During PR-47 hardware testing, the documented
reconfigure trigger printed by `ESP32-CAM.ino`'s `setup` ("hold the
CONFIG button (GPIO0), tap RESET to reboot, and keep holding CONFIG
for 5 seconds") never reached the firmware's GPIO0 long-press check.
Two reproducible failure modes on a CH340-based ESP32-CAM: holding
GPIO0 LOW during the RESET tap put the chip in `boot:0x3
DOWNLOAD_BOOT`, and finger-roll attempts (release RESET, then quickly
press BOOT) triggered an `ets_main.c 371 flash read err, 1000` boot
loop that required a full re-flash to recover.

**Why it happened.** GPIO0 is the boot strap pin the ESP32 ROM
bootloader samples at the rising edge of EN to choose between
`SPI_FAST_FLASH_BOOT` and `DOWNLOAD_BOOT`. If GPIO0 is LOW at that
moment, the chip enters the ROM bootloader and waits on UART for
esptool — app code does not run at all, so the firmware-side
`digitalRead(CONFIG_BUTTON)` check has no opportunity to win the
race; there is no race. The `flash read err, 1000` variant has an
**unproven mechanism** — possibly a power glitch or partial-erase
residue from prior DOWNLOAD_BOOT entries; we did not isolate it
during PR-47 testing and should not invent one. What is reproducible
is the failure, not the cause.

**How to avoid it next time.** Don't trust a documented "hold a strap
pin to enter app-side mode" sequence on hardware where that pin is
also the boot strap — the boot ROM always wins, by construction. The
working trigger today is the WiFi-fail auto-fallback at
`ESP32-CAM.ino`'s `setup` (3 consecutive failed joins →
`setESPConfigured(false)` → AP). PR-47 also replaced the misleading
`-- ESP already configured. To reconfigure: hold the CONFIG button…`
print with one that advertises the auto-fallback path; the broader
fix (wire CONFIG to a non-strap GPIO, or remove the long-press path
entirely) is tracked at
[issue #56](https://github.com/schutera/highfive/issues/56).

### Captive-portal JS validator and `/save` handler are two halves of one contract (issue #46)

**What happened.** The original PR-47 fix for issue #46 changed
`ESP32-CAM/host.cpp`'s `sendConfigForm` to render the password input with
`value=""` and updated `/save` to preserve `cfg_password` on empty
submission. Both halves were correct in isolation. But the existing
`validateForm` JS rejected every visible field with empty content,
so the placeholder-promised "leave blank to keep current password"
path was unreachable through the UI for the entire interval between
commits `ef0d10c` (the fix) and `d4b94b5` (the follow-up). Hardware
testing surfaced this; unit tests did not; the senior-reviewer pass
on the original PR did not.

**Why it happened.** The fix-#46 author updated the form's render
side and the `/save` handler but treated the JS validator as
out-of-scope cosmetic glue. It is not — it is the first half of the
"blank means keep current" contract. Code review caught the leak
fix; nobody clicked Save with the password field blank.

**How to avoid it next time.** Captive-portal forms have three
coordinated layers: HTML render attributes, JS pre-submit validator,
and server-side handler. Any change to the contract for a field
must touch all three (or document why two suffice). For HiveHive
specifically: when adding or modifying a field that can be empty,
exercise the empty-submission path manually before declaring the
fix done — the JS validator does not know about field-level
"optional" semantics by default. The current keep-current contract
is encoded in the `data-keep-current-on-empty` HTML attribute and
its mirroring server-side check (`submitted.trim();
if (submitted.length() > 0) cfg_X = submitted;`); both must move
together. Extraction of the server-side half into a host-testable
helper is tracked at
[issue #57](https://github.com/schutera/highfive/issues/57); land
that before adding a second keep-current field, or this lesson is
paid for again.

### `auth.md` "open AP" claim — captive portal is WPA2-protected

**What happened.** The "Captive-portal credential handling" section
added in PR-47 originally claimed the portal "is served from an open
WiFi AP — there is no PSK, anyone in RF range can join." Hardware
verification proved the opposite: the AP is WPA2-PSK with
`HOST_PASSWORD` hardcoded in `host.cpp`. The fix-#46 reasoning ("don't
echo the password to View Source") still holds, just for a different
threat model than the doc described. Corrected in the same PR.

**Why it happened.** The threat-model paragraph was drafted from the
assumed shape of the AP, not the actual `WiFi.softAP(HOST_SSID,
HOST_PASSWORD, …)` call. Code review and unit tests caught the fix;
hardware testing (a Windows "enter network password" prompt when
joining the AP) caught the doc.

**How to avoid it next time.** When writing a threat-model paragraph
about a WiFi or HTTP surface, grep for the actual API call
(`WiFi.softAP`, `app.use(...)`, `addRoute`) and read its arguments
before describing what the surface looks like to the network. Doc
review needs to inspect the API, not just the surrounding prose.

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

### Three partial-failure shapes shipped together (#30, #31, #32)

**What happened.** Three independent bugs at the backend ↔
image-service ↔ duckdb-service seam shared the same shape:

- `image-service/app.py's delete_image` would `os.remove()` the file
  even when duckdb returned 5xx, leaving an orphaned DB row pointing
  at a missing file (#30).
- `backend/src/database.ts's fetchAndAssemble` flipped every module
  whose dominant freshness signal was the heartbeat to `'offline'`
  the moment the `/heartbeats_summary` endpoint hiccuped, misleading
  the on-call into thinking the fleet was down (#31).
- Seven catch blocks in `backend/src/app.ts` returned 5xx to the
  caller while logging nothing. Production debugging from the logs
  alone was impossible (#32).

**Why it happened.** Each catch block was treated as "we caught it,
ship a generic 5xx and move on" rather than "we caught it, log
enough to debug AND classify into the smallest honest user-facing
signal". The image-service docstring even acknowledged the orphan
gap and pointed at #30 — but the gap stayed open because no test
pinned the desired behaviour.

**How to avoid it next time.** Every catch block at a service
boundary must answer two questions explicitly: (a) what gets logged
for the on-call (endpoint tag + structured payload, never naked
`return res.status(5xx)`), and (b) what does the caller see — forward
the upstream status, never lie with 200. When introducing a new
fan-out fetch, also classify partial failures into the smallest
honest signal (here: `'unknown'` instead of `'offline'`, plus an
out-of-band header `X-Highfive-Data-Incomplete` that old clients
ignore but the dashboard reads).

### Production stack shipped with two silent gaps (#37 + #38)

**What happened.** PR-27's `docker-compose.prod.yml` and chapter-7
runbooks shipped two production hazards:

1. The compose file used `${HIGHFIVE_API_KEY:-hf_dev_key_2026}` and
   `${VITE_API_KEY:-hf_dev_key_2026}` — a forgotten `.env` silently
   booted prod on the publicly-known dev key. Violates CLAUDE.md's
   "Never ship the dev API key as a production fallback" rule.
2. The compose file defined only `backend` and `frontend`. The
   upload pipeline (`image-service` + `duckdb-service`) and the
   `duckdb_data` volume were absent, the backend had no
   `DUCKDB_SERVICE_URL`, and the `'443:443'` port mapping was a
   no-op against a frontend nginx that only listened on `:80`.
   Following the runbook produced a dashboard that loaded but
   couldn't ingest images, on plain HTTP.

**Why it happened.** The prod compose was authored as a stripped-down
dev compose with the upload pipeline excised "for the next iteration"
and a `${VAR:-default}` fallback dropped in for fail-soft. The
runbook carried a banner-marked TODO that said "this is incomplete,
follow the issue" — operators had a signal, but the signal was useless
because nobody acted on it for several iterations and the artifact
shipped to production anyway. The actual lesson is that doc banners
are not a substitute for fixing the runbook; they normalise broken
state.

**How to avoid it next time.**

- **Production env interpolation must be `${VAR:?msg}`.** Fail-fast
  on missing or empty secrets, with an explicit error message that
  names the env var and points at `.env.production.example`.
  `${VAR:-default}` and `${VAR:-broken_sentinel}` are both wrong
  for production secrets — sentinels still let the deploy boot with
  broken config; only fail-fast catches the misconfiguration before
  startup.
- **The prod compose must be a strict superset of the dev compose.**
  Anything missing from prod that exists in dev is an architectural
  decision that needs an ADR, not a quiet omission. If a service is
  intentionally absent (e.g. duckdb-service is internal-only by
  ADR-001 and exposes no host port), document the why-not in the
  runbook's "Known gaps" section.
- **Doc banners are not a substitute for fixing the runbook.** A
  banner-marked TODO that says "this runbook is incomplete, see the
  follow-up issue" gives the appearance of due diligence while still
  shipping a broken artifact. If the artifact is broken, either fix
  it in the same PR or remove it from the docs index — don't ship a
  half-working file with a self-deprecating note.

### GPIO0 is a strap pin — never put a "hold this button at boot" UX behind it (fixed in #40)

**What happened.** The firmware shipped with a documented factory-reset
procedure ("hold IO0 for 5 seconds while powering on") at
`ESP32-CAM/ESP32-CAM.ino`'s `setup()` (formerly the `digitalRead(CONFIG_BUTTON)
== LOW` block), advertised across the firmware boot-time Serial
output, six doc files (`docs/troubleshooting.md`,
`docs/05-building-block-view/esp32cam.md`,
`docs/05-building-block-view/homepage.md`,
`docs/07-deployment-view/esp-flashing.md`,
`docs/08-crosscutting-concepts/hardware-notes.md`, and
`.claude/skills/esp32-onboarding/skill.md`), and four user-facing
i18n strings (English + German on both the assembly guide and the
wizard troubleshoot panel). The procedure was physically impossible
on AI
Thinker ESP32-CAM-MB: the ROM samples GPIO0 the moment EN/RST
releases, so holding it LOW enters UART download mode (visible as
garbled 74880-baud output, "waiting for download") instead of running
user firmware. The reset code path was unreachable in practice. Issue
#40 surfaced it during a manual onboarding test of
`feat/onboarding-feedback`.

**Why it shipped.** The host-native unit tests covered the helper
macros but didn't model strap behaviour, and the manual smoke-test
that _would_ have caught it was run on benches where GPIO0 was pulled
HIGH at boot by external circuitry — not on the bare AI Thinker
reference module the deployment docs target. The Serial.printf at the
top of `setup()` _told_ users to hold IO0, so when nothing happened on
real hardware the user assumed the procedure was finicky rather than
broken.

**Why the first PR-40 pass missed half the surface.** The first-pass
fix targeted the firmware code and the five `docs/` sites named in the
issue, but missed the four production i18n strings in
`homepage/src/i18n/translations.ts`'s `assembly.factoryReset` and
`step5.troubleshoot.resetText` blocks (English + German), plus a
related table row in `docs/05-building-block-view/homepage.md`. Senior-reviewer caught it.
This is the same failure mode the "Drift sweep is not a substitute
for a CI check" lesson 30 lines above warned about — and the warning
was sitting one screen-scroll away while the PR was being written.
The general lesson: prose warnings about cross-surface drift do not
durably hold; they only hold the day they're written. The mechanical
guard ships with this same PR rather than as a follow-up:
`scripts/check-stale-reset-prose.sh` (wired into
`make check-stale-reset-prose` and the `pre-push` hook) fails the
build if `hold.*IO0.*[0-9]+.*second`, `hold.*left.button.*ESP32-CAM`,
or related calque-grammar reappears anywhere under `homepage/`,
`docs/`, `.claude/skills/`, or `ESP32-CAM/`. Plus a vitest assertion in
`homepage/src/__tests__/i18n.test.ts` pins the four user-facing keys
(`en.assembly.factoryReset`, `en.step5.troubleshoot.resetText`, and
their German twins) against the regex regression class.

**Lesson.** When the ESP32 datasheet calls a pin a "strap pin", any
user-visible behaviour assigned to it must work _despite_ the strap
behaviour, not assume the strap is benign. Strap pins on the standard
ESP32 (GPIO0, GPIO2, GPIO12, GPIO15) are sampled at the EN-release
edge and their level there determines boot mode — by the time
firmware runs, the pin's level may have nothing to do with the
operator's intent. For this codebase: factory-reset moved to the
captive portal (`POST /factory_reset` endpoint in
`ESP32-CAM/host.cpp`'s `runAccessPoint`), and the legacy IO0-hold
procedure is removed from `ESP32-CAM/ESP32-CAM.ino`, the boot-time
Serial advice, all six doc files listed above, and the four
homepage i18n strings. The `check-stale-reset-prose.sh` gate exists
to keep it removed. Future "hold this button
at boot" features must use a non-strap GPIO (e.g. GPIO13 or GPIO14
on the ESP32-CAM, both broken out and both safe at strap time).

### Telemetry sidecar envelope drift — admin UI silently rendered `—` for every field

**What happened.** PR-42 (the issue-#42 telemetry-first stage-breadcrumb
PR) shipped an initial round-1 fix to extend the homepage's
`TelemetryRow` with the new `last_stage_before_reboot` field. The fix
extended `homepage/src/services/api.ts`'s `TelemetryEntry` interface
and `homepage/src/components/ModulePanel.tsx`'s `TelemetryRow` JSX,
ran `npm test && npm run build` (both green), and the round-1
reviewer's P0 was declared addressed.

The round-2 reviewer caught what no test exercised: the homepage was
reading a **flat** wire shape (`entry.fw`, `entry.last_reset_reason`,
`entry._received_at`) but `image-service/services/sidecar.py`'s
`LogSidecarEnvelope` had been wrapping telemetry inside a typed
envelope (`{mac, received_at, image, payload: {…}}`) since some prior
refactor. Every `TelemetryEntry` field on the homepage had been
`undefined` at runtime — the existing `reset` row had been showing
`—` for every entry across the dashboard, silently, since that
envelope refactor. Adding a new optional field next to the existing
broken ones rendered nothing because the existing ones rendered
nothing. The fix-up commit message claimed "telemetry surface now
actually surfaces the field"; in production it did not surface
anything at all.

**Why it shipped.** Three TypeScript optionals stacked: every
field is `string | undefined`, every `entry.X || '—'` falls through
silently when `X` is undefined, and no test exercised the actual wire
shape end-to-end. The author trusted `npm test && npm run build` as
proof the fix was real and never opened the dev stack to confirm a
single sidecar entry rendered. The round-1 P0 was technically a
typo-class bug — read the wrong level of the JSON — but the lesson
is meta: the very same PR's chapter-11 contribution
(`Documentation drifted from code in PR 27 first-pass review`) names
exactly the failure mode that re-occurred inside the round-1 fix-up.

**Lesson — the lesson PR-42 actually earned, not the one it set out
to earn.**

1. **TypeScript optionals are not type safety.** A wire-shape mismatch
   between an emitter and a consumer that's all-`field?: T` falls
   through to all-`undefined` at runtime. The compile passes; the
   tests pass; the operator's dashboard shows `—` for every entry.
   Contract types whose every field is optional don't actually pin
   anything — they're `unknown` with extra steps.

2. **Run the dev stack before claiming a UI claim is true.** When a
   PR's docs say "the admin Telemetry view renders the field", the
   verification step is `docker compose up && curl /api/modules/.../logs &&
open http://localhost:5173/dashboard?admin=1` — not `npm test &&
npm run build`. The unit test surface and the wire-shape surface
   are different surfaces. Both need a check-step.

3. **Wire-shape contracts at service boundaries belong in
   `contracts/`** (per ADR-004). The fact that `TelemetryEntry`
   lived in `homepage/src/services/api.ts` rather than
   `contracts/src/index.ts` is exactly the conditions
   "Frontend / backend type drift before `@highfive/contracts`"
   above warns against. The shape was crossing the
   backend↔homepage boundary; it belonged in the workspace package.
   Round-2 fix moved it.

4. **Test the wire shape, not just the type.** Round-2 fix added
   `homepage/src/__tests__/TelemetryRow.test.tsx` mounting
   `TelemetryRow` with a realistic envelope fixture and asserting
   the fields actually render. Without that pin, the same drift
   recurs the next refactor.

**How to avoid next time.** Three concrete rules landed in
[`CLAUDE.md`'s "Verifying UI claims, wire shapes, and component-test
fixtures"](../../CLAUDE.md#verifying-ui-claims-wire-shapes-and-component-test-fixtures)
section in the same PR — UI-claim verification, contracts-package
discipline, and realistic component-test fixtures. The rules earned
their own slot in the project orientation rather than living only as
post-mortem prose so the next contributor sees them before writing
the bug, not after.

### TASK_WDT in `postImage:read_body` — WiFiClient read loops must feed the watchdog (issues #42, #53)

**What happened.** The ESP32 rebooted via TASK_WDT on every other boot
during normal STA-mode operation (`reset_reason=7`). The stage-breadcrumb
library in `ESP32-CAM/lib/breadcrumb/` (RTC slow memory, survives software
resets) identified `postImage:read_body` as the stage consistently active
when the watchdog fired. The response-body reading loop in `client.cpp`'s
`postImage` uses `WiFiClient.read()` in a polling loop with a 5-second
silence-based exit (`millis() - start > 5000`). When the server sends
trickle data, each received byte resets `start = millis()`, preventing the
silence exit from ever triggering. The loop can run for >60 s with no
`esp_task_wdt_reset()` call — the WDT fires.

Note: every boot also logged `WiFiClient.cpp setSocketOption() fail on -1,
errno: 9, "Bad file number"`, indicating the socket is in an error state
across reconnects. The WDT-feed fix stops the reboot symptom; the
underlying socket-state corruption is tracked separately at
[issue #60](https://github.com/schutera/highfive/issues/60).

**Why it happened.** The write-body loop in the same function already had
`esp_task_wdt_reset()` inside it (added for the same reason in an earlier
PR) but the two read loops (headers and body) were never given the same
treatment. The write → feed / read → no-feed asymmetry was invisible until
the trickle-data scenario surfaced on real hardware.

**How to avoid it next time.** Any loop that calls blocking or polling
`WiFiClient` methods (`readStringUntil`, `readBytes`, `read`) must contain
an `esp_task_wdt_reset()` call if the loop can iterate for more than a few
seconds. The write-body loop in `client.cpp`'s `postImage` is the reference
model — feed the watchdog on each chunk write; follow the same pattern for
each chunk (or byte) read. Pair the feed with `client.setTimeout(N)` where
`N < TASK_WDT_TIMEOUT_S` so a single blocking read can't itself exhaust the
budget (the existing `setTimeout(8000)` at `postImage`'s static-init block
already does this — it is the other half of the same defence). The same
fix also added `delay(1)` in the body-read polling loop's else branch to
stop the loop from CPU-spinning between byte arrivals — `delay(1)` is the
Arduino-on-ESP32 way to yield to other FreeRTOS tasks while waiting on a
non-blocking poll.

### Hardware-test misdiagnosis: assumed cadence without reading the constant (issue #42)

**What happened.** During hardware verification of the WDT-feed fix above,
docker logs showed exactly one heartbeat from the module after first boot,
then silence for 8+ minutes. A "silent hang in `sendHeartbeat`" hypothesis
was built on top of that observation: a follow-up issue was filed
([#59](https://github.com/schutera/highfive/issues/59), since closed),
Serial-debug instrumentation was added on a debug branch, and a fresh
diagnostic cycle was walked through. The instrumentation immediately showed
the loop iterating cleanly every 30 s, with the line `[DBG] iter=2
heartbeat skipped (interval not reached)`. The "missing" heartbeats were
not missing — `ESP32-CAM/ESP32-CAM.ino`'s `HEARTBEAT_INTERVAL_MS` is
`(60UL * 60UL * 1000UL)`, **one hour**, not the 30 s loop-tick cadence
assumed during the diagnosis. There was no hang; the WDT fix was working
as designed all along.

**Why it happened.** The Docker log shape ("one heartbeat then silence")
was equally consistent with two explanations: (a) a real hang, and (b) a
1-hour heartbeat interval. The reviewer picked (a) because the active
investigation context was about hangs, and never grep'd for the cadence
constant to disambiguate. The matching error log
(`WiFiClient.cpp setSocketOption() fail on -1, errno: 9`) on every connect
looked causal to the silence-hypothesis when it was incidental to it — the
errno-9 is a real, separate socket-state issue (see the WDT-feed lesson
directly above), but it does not cause a hang; the connect succeeds and
the upload completes. Costs of the misdiagnosis: one fork-the-fork branch,
~20 lines of instrumentation, a noise PR filed on the upstream issue
tracker, and a contributor's evening. A second, related test-completeness
miss landed in the same session: the 3 loop iterations observed only
exercised `postImage` once (the `firstCaptureDone` flag prevents another
non-noon recapture, and the test wasn't at noon so the noon path didn't
fire either) and `sendHeartbeat` once (the one-hour interval kept iter 2
and 3 in the skip-heartbeat branch). The 90 s test window was therefore
mostly the no-network-call branch of `loop()` running and `delay(30000)`
returning. The trickle-data scenario the WDT fix targets was not
artificially re-induced — the verification proves the fix doesn't regress
the happy path, not that it cures the original failure mode under load.

**How to avoid it next time.** Before building a theory on top of
"behaviour X happens with cadence Y," `git grep` for the constant that
defines Y and confirm the value. For HiveHive specifically: any timing-
related claim about ESP firmware behaviour (heartbeat cadence, capture
schedule, retry backoff, sleep length) must be backed by reading the
relevant `#define` or constant in `ESP32-CAM/`. Same rule applies to
backend polling intervals (`backend/src/`) and silence-watcher thresholds
(`duckdb-service/`). Generalisation: the
`Documentation drifted from code in PR 27 first-pass review` lesson above
is about not assuming a documented value matches code; this is the runtime
sibling — don't assume an observed cadence matches the model in your head.
Read the constant. For verification: when a hardware test is meant to
exercise a specific failure mode, confirm the test path actually reaches
that mode (e.g. by injecting the failure on the server side) rather than
asserting "no regression on the happy path" and calling the fix verified.

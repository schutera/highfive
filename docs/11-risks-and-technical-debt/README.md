# 11. Risks and Technical Debt

Known issues that aren't bugs to be fixed in the current PR but that
future contributors must know about. Two sub-registers below:
**open issues** (active items in GitHub) and **lessons learned**
(things we paid for and don't want to relearn).

## Open issues

Tracked on GitHub at [schutera/highfive/issues](https://github.com/schutera/highfive/issues).
Highlights worth knowing about even if you're not assigned:

| #                                                     | Title (short)                                                         | Why it matters                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#19](https://github.com/schutera/highfive/issues/19) | `StaticJsonDocument` size in ESP firmware                             | Risk of silent truncation on telemetry growth.                                                                                                                                              |
| [#20](https://github.com/schutera/highfive/issues/20) | Capture interval is hardcoded                                         | Should be configurable via the AP form.                                                                                                                                                     |
| [#26](https://github.com/schutera/highfive/issues/26) | OTA firmware update support                                           | Today every firmware update requires physical USB. Tracked as a feature request with a recommended ArduinoOTA-first phasing.                                                                |
| [#56](https://github.com/schutera/highfive/issues/56) | GPIO0 reconfigure trigger lands in DOWNLOAD_BOOT (and corrupts flash) | Documented user path drops the chip into ROM bootloader; finger-roll variant reproduces a flash-read-err loop requiring re-flash. WiFi-fail auto-fallback is the working trigger today.     |
| [#57](https://github.com/schutera/highfive/issues/57) | Extract captive-portal `/save` logic into a host-testable helper      | The keep-current-on-empty contract has three layers (HTML attr, JS validator, server check); the server half is currently un-unit-testable. Land before adding a second keep-current field. |

## Field-name drift

The canonical wire field on `POST /add_progress_for_module` is
`module_id`. The legacy typo `modul_id` (missing "e") is still
**accepted** by `duckdb-service/models/progress.py`'s
`ClassificationOutput` via Pydantic `AliasChoices` as a deprecation
alias; `image-service`'s `UploadPipeline._record_progress` emits the
canonical name. The alias is removable once nothing in or out of the
tree references it — don't regress emitters back to `modul_id`. Full
discussion:
[../08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).

The `progess_id` / `hateched` typos in `backend/database.ts` were
fixed in commit `778c9b1`. Don't reintroduce them.

## Hardcoded secrets

- **Google Geolocation API key** — formerly hardcoded as the
  `apiKey` local in `ESP32-CAM/esp_init.cpp`'s `getGeolocation`.
  Removed in the PR that closed
  [issue #18](https://github.com/schutera/highfive/issues/18); the
  key now enters the binary at build time via
  `ESP32-CAM/extra_scripts.py` (PlatformIO) or
  `ESP32-CAM/build.sh` (`arduino-cli`), sourced from a
  `GEO_API_KEY` env var with a `.gitignored`
  `ESP32-CAM/GEO_API_KEY` file fallback. Full mechanism:
  [`docs/08-crosscutting-concepts/auth.md`](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).
  The original key remains in git history and must stay revoked.
- **Dev API key fallback** `hf_dev_key_2026` in
  [`backend/src/auth.ts`'s `DEV_FALLBACK_KEY`](../../backend/src/auth.ts)
  — intentional for local dev. Must be overridden via `HIGHFIVE_API_KEY`
  for any non-local deploy. Code-side enforcement: `auth.ts` refuses to
  load when `isProduction()` is true and the env var is unset, or when
  the env var is the dev fallback (case-insensitively). The operator
  cannot ship the dev key as the prod gate without the backend crashing
  at startup. See [02-constraints](../02-constraints/README.md).
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

### Same-batch ESP firmwares collided on the auto-generated module name (issues #91, #92, #93, #94)

**What happened.** Two distinct modules with MACs `b0:69:6e:f2:3a:08`
and `e8:9f:a9:f2:3a:08` both registered with the dashboard as
`fierce-apricot-specht`. The dashboard had no way to tell them apart,
the server happily accepted both rows, and operators discovered the
ambiguity only by deleting one module and watching the wrong one
disappear. Compounding it: the captive portal's "Module Name" field
was being silently discarded on every reboot, so even an operator who
tried to rename a module by hand saw their input vanish.

**Why it happened.**

1. `generateModuleName()` seeded indices into the three 32-entry word
   lists from `bytes[0..2]` of `ESP.getEfuseMac()`. On little-endian
   ESP32, those positions are the **LSB three octets** of the MAC —
   which are manufacturer-shared for same-batch devices. The three
   shared octets (`f2:3a:08`) drove `fierce` (`08 % 32`), `apricot`
   (`3a % 32`), `specht` (`f2 % 32`); the unique-prefix octets that
   would have disambiguated the two modules were ignored.
2. `loadConfig()` parsed `SSID`, `PASSWORD`, `UPLOAD_URL`, `INIT_URL`,
   `EMAIL` out of SPIFFS, but never read `MODULE_NAME`. The variable
   was _written_ to SPIFFS correctly by the captive portal; the read
   path was missing entirely. Every boot took the
   `generateModuleName()` fallback regardless.
3. `module_configs.name` had no `UNIQUE` constraint, and
   `add_module()`'s upsert conflicted only on `id` (MAC). Two distinct
   MACs with the same name were both accepted without warning.

**How to avoid it next time.**

- **Treat MAC-derived defaults as collision-prone by construction.**
  Manufacturer batches share their suffix bytes; any hashing /
  indexing strategy that doesn't mix all six bytes will collide on
  the dashboard at some point. The fix XOR-pairs paired bytes
  (`mac[0]^mac[3]`, …) so every octet contributes to every word
  index — see `ESP32-CAM/lib/module_name/`.
- **Pull SPIFFS read/write paths into the same code review.**
  `saveConfig()` and `loadConfig()` are two halves of one contract;
  if you add a field to one, you have to add it to the other. The
  asymmetry here went undetected for months because the two
  functions live in different files (`host.cpp` and `esp_init.cpp`)
  and neither has a unit test covering the round-trip.
- **A "human label" column needs UNIQUE, but the firmware-reported
  column cannot have it.** The firmware UPSERTs on every boot, and
  same-batch collisions would turn UNIQUE into "second module
  refuses to register." Two columns (`name` mutable + advisory,
  `display_name` UNIQUE + admin-settable, coalesced at the client)
  is the right separation. See [ADR-011](../09-architecture-decisions/adr-011-module-display-name-override.md).
- **Host-test the byte-mixing logic.** The XOR fix is one line, but
  the regression test for the _specific_ field collision case (the
  two `fierce-apricot-specht` MACs) is the structural guard that
  catches a future "let's simplify the index derivation" refactor.
  Lives in `ESP32-CAM/test/test_native_module_name/`.

### Critical-rules prose-to-code audit, extended — five more hardenings in one PR (issues #86, #87)

**What happened.** PR #84 closed the dev-fallback-as-production-admin-gate
incident by lifting one CLAUDE.md "Critical rules" entry into a
code-side startup guard. The senior-review cycle on PR #84 also called
out three sibling problems that the same audit pattern would close:
two trailing-edge auth-surface findings (timing-safe-equal on the
secret compare; case-insensitive dev-key match at frontend build time)
plus three more "do not violate" rules in CLAUDE.md that were still
prose-only — `TASK_WDT_TIMEOUT_S ≥ 60s`, `PORT=3002` in
docker-compose, and "`sendHeartbeat` must not swallow non-2xx". The
PR-#84-only lesson named this in its "How to avoid it next time"
item 1: _"The remaining 'Critical rules' entries deserve the same
audit."_ This PR is the second iteration of that pattern.

**Why it happened.** The bugs that earned those CLAUDE.md entries
(`ea7dc73`, PR-17 review critical) were paid for with field outages.
The fixes landed in code but the rules were transcribed as prose for
the next maintainer to remember — which works exactly until the next
maintainer is a fresh contributor, a future-you under time pressure,
or a refactor that "simplifies" something across the boundary. The
"Critical rules" list grew because the same anti-pattern kept playing
out: a load-bearing constraint encoded as a sentence rather than as
a build error.

**How to avoid it next time.** Two lessons compound on PR #84's:

1. **When you find yourself adding a "do not violate" rule to
   CLAUDE.md, first ask whether it can be a build error or a fast
   self-describing crash at first run.** A `static_assert` on a
   `#define` (firmware), a startup `throw` with a self-describing
   message (Node service), a load-time guard in a Vite bundle (the
   crash fires at first browser import, not during `vite build` —
   Vite inlines `import.meta.env` values but doesn't execute module
   tops; that's intrinsic), or a pure helper plus a native test
   pinning its contract (firmware non-2xx) cover most of the cases.
   The prose entry is the fallback when none of those mechanisms fit
   — not the first option. PR #84 used a startup throw; this PR added
   `static_assert`, a startup warn-on-unset, a build-time validator,
   constant-time-compare via a single boundary, and a native test
   pinning a refactor-resistant contract.
2. **Removing the prose entry is part of the work.** If the rule is
   now code-enforced, the prose entry isn't a redundant safety net —
   it's a hint that two sources of truth exist, and CLAUDE.md is the
   wrong one. Keeping both invites the next maintainer to weaken the
   code-side check on the assumption that the prose carries the rule.
   This PR removed three now-enforced entries. The dev-API-key
   entry stays because `NODE_ENV=development` is an intentional
   off-ramp the operator owns — safelist semantics and pinned tests
   live in `backend/src/env.ts`'s `DEV_ENV_TOKENS` +
   `backend/tests/auth-prod-guard.test.ts`. Next iteration of this
   pattern: move the dev-fallback behind an explicit
   `ALLOW_DEV_FALLBACK=1` opt-in env var that no production deploy
   would set, and the prose entry can come out too.

The remaining "Critical rules" entries — force-push to main, hook
bypass, `--amend` after hook failure, `DuckDB` connection from
image-service, `localhost` in inter-service URLs, commit-message-vs-
code trust — are either review-time disciplines or partial-enforcement
cases. None map cleanly to a build error today; revisit if the
project grows enforcement infrastructure (e.g. a custom ESLint rule
or a CI lint pass).

### Plaintext API key on the wire was the default for months (issue #79)

**What happened.** The shipped `ESP32-CAM/config.json` baked
`http://highfive.schutera.com/upload` and `.../new_module` as the
factory defaults. Every flashed module sent the `HIGHFIVE_API_KEY`,
image bodies, and hourly telemetry in clear-text
over WiFi. A single passive `tcpdump` on any LAN segment between a
module and the server captured the shared admin secret and granted
full server compromise — the same key gates `/api/modules*` and the
admin telemetry surface. The production server was already serving
HTTPS on every relevant path (Let's Encrypt R13 → ISRG Root X1,
HSTS set on the API + upload responses); the firmware was the
sole HTTP consumer because nobody had checked.

**Why it happened.** The firmware predated the production deployment.
The early-development URLs were LAN dev (`http://10.0.0.5:8002/...`)
where TLS is unavailable and not worth setting up. When the project
moved to a Mark-hosted box, the LAN-dev shape persisted in
`config.json` as `http://highfive.schutera.com/...` — same scheme,
new host, same lack of TLS — because nobody probed the new server's
HTTPS capability before committing the defaults. The
`HTTPClient` calls already had `https://` support via the framework's
`WiFiClientSecure`; no firmware change was needed to start using
TLS, only a URL-scheme flip and CA-pinning.

**How to avoid it next time.** Probe the production server's TLS
capability the first time the firmware points at it, not after
n months of shipping plaintext. A two-line `curl.exe -sI
https://prod.example.com/upload` is enough to discover whether
HTTPS is already served — and if it is, the firmware-side migration
is purely a URL-scheme flip plus a CA root embed. The
`getGeolocation` path in `ESP32-CAM/esp_init.cpp` was a second
silent leak: it already used `https://googleapis.com` but with no
`setCACert`, so the WiFi-fingerprint payload was encrypted but
unauthenticated to the peer. Both lessons collapse into a single
rule: when a firmware call site is `https://`, it must also be
CA-pinned. See [ADR-010](../09-architecture-decisions/adr-010-esp-firmware-tls-trust-model.md)
for the trust-model decision and the embedded-roots design.

### OTA `shouldOtaUpdate` accepts downgrades (surfaced during #79 smoke test)

**What happened.** During the PR #82 hardware smoke test on 2026-05-15, a
test module running `mason` (the TLS-migration firmware) was put on its
home WiFi while the production manifest at `firmware.json` still
advertised the previous `leafcutter` version. On every boot the module
fetched the manifest, observed that `mason != leafcutter`, and proceeded
to download and flash `leafcutter` — wiping the TLS-migration firmware.
Next boot, the now-`leafcutter` module fetched the manifest, observed
`leafcutter != mason` was no longer true (since it was now itself
`leafcutter`), and stopped. The trap surfaced as a one-shot downgrade in
the test, but a misconfigured production deployment (manifest rolled
back, binary not) would expose the same bidirectional pingpong.

**Why it happened.** [`ota_version.cpp`'s `shouldOtaUpdate`](../../ESP32-CAM/lib/ota_version/ota_version.cpp)
implements version comparison as plain `strcmp(current, manifest) != 0`.
Bee names ([ADR-006](../09-architecture-decisions/adr-006-bee-name-firmware-versioning.md))
are deliberately unordered identifiers — there is no total order from
which "newer than" could be derived. The current logic treats any
difference as a green light to flash, which conflates the upgrade and
downgrade directions. The unit test
`test_should_update_returns_true_on_diff` in
[`test_native_ota_version/test_ota_version.cpp`](../../ESP32-CAM/test/test_native_ota_version/test_ota_version.cpp)
pins this behaviour explicitly, so it was a conscious choice from #26,
not a bug introduced by #79.

**How to avoid it next time.** Two layers:

1. **Operationally**, when rolling out a new firmware version, upload
   the binary to the server _before_ updating `firmware.json` to
   advertise the new version. The manifest is the trigger; if it points
   at a binary that does not yet exist, modules see `404` and skip.
   Atomicity is on the operator.
2. **Architecturally**, the firmware should not be able to downgrade by
   accident. Tracked as issue [#83](https://github.com/schutera/highfive/issues/83):
   add a monotonic `sequence` integer alongside the bee name in
   `ESP32-CAM/VERSION` and in `firmware.json`; `shouldOtaUpdate`
   refuses any flash where `manifest.sequence <= current.sequence`
   unless the manifest sets an explicit `allow_downgrade: true` flag.
   Deferred from PR #82 to keep the TLS-migration diff focused.

### Operator-vigilance rule was unenforced — dev API key was the active admin gate in production (PR #84)

**What happened.** PR #82's hardware smoke test against
`https://highfive.schutera.com` exercised the migrated TLS endpoints
(`/new_module`, `/upload`, `/heartbeat`, `/geolocation`) — all four
passed. As a side-investigation the smoke test poked at the
production admin endpoint with the dev API-key string
`hf_dev_key_2026` (a constant visible in
[`backend/src/auth.ts`'s `DEV_FALLBACK_KEY`](../../backend/src/auth.ts),
the backend tests, and CLAUDE.md), and the production admin endpoint
accepted it. The backend was running with `HIGHFIVE_API_KEY` either
unset (so the dev fallback activated) or set literally to the dev
string. Either way, anyone who grepped the public repo for that
constant could log into the deployed admin endpoint as administrator.

**Why it happened.** CLAUDE.md's
[Critical rules](../../CLAUDE.md) section had carried this exact rule
for months — _"Never ship the dev API key (`hf_dev_key_2026`) as a
production fallback. Override `HIGHFIVE_API_KEY`."_ The rule was
correct, prominent, and load-bearing. But it was prose-only.
Enforcement relied on the operator remembering to set the env var on
every production environment, every redeploy, every config change.
The code itself happily activated the public dev fallback when the
env var was missing or set to the dev string. Operator vigilance is
a brittle enforcement mechanism: it works perfectly until a
deployment shortcut, a `.env` copy from `.env.example`, or a fresh
environment slips past it.

**How to avoid it next time.** Two distinct lessons:

1. **A "do not violate" rule in CLAUDE.md is a candidate for
   code-side enforcement.** If the failure mode is silent and operator
   vigilance is the only gate, lift the rule into a startup check, a
   CI guard, or a build-time throw.
   [`backend/src/auth.ts`'s startup guard](../../backend/src/auth.ts)
   demonstrates the pattern: the backend refuses to load when
   `isProduction()` is true and `HIGHFIVE_API_KEY` would fall back to
   the dev string, or when the env var is set (case-insensitively) to
   the dev string. The remaining "Critical rules" entries deserve
   the same audit — for each, ask "could a missed env var, a wrong
   config path, or a default value silently bypass this?" If yes, the
   rule belongs in code, not in prose.
2. **Side-investigation during smoke tests pays off.** PR #82's
   primary goal was TLS handshake verification; the dev-key probe was
   a five-minute curiosity check that surfaced the highest-severity
   issue of the cycle. Build the habit of asking, during any
   auth-adjacent smoke test, _"would the documented dev shortcut work
   here?"_ — the desired answer is "no, the deploy rejected it" or
   "fast-crash with a clear remediation message." If the answer is
   "yes, it logged in", the smoke test has just found the next P0.

Hardening landed in PR #84. Both follow-up issues
([#86](https://github.com/schutera/highfive/issues/86) — constant-time
admin-key compare via `verifyApiKey`;
[#87](https://github.com/schutera/highfive/issues/87) — frontend
case-insensitive dev-key match via `validateBuildTimeApiKey`) closed
in the Critical-rules prose-to-code audit PR (lesson above).

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
print with one that advertises the auto-fallback path.

**Resolution status.** PR-47 shipped the prose fix (Option 2 in #56:
replace the GPIO0 hint with auto-fallback advice). The hardware
redesign (Option 3: wire CONFIG to a non-strap GPIO like GPIO13 or
GPIO14) is **descoped indefinitely** — the WiFi-fail auto-fallback at
`setup()`'s `WIFI_FAIL_AP_FALLBACK_THRESH` is the working trigger and
meets the operator-onboarding requirement. Closed at PR E.

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
is encoded in the `data-keep-current-on-empty` HTML attribute, a
matching client-side validator skip, and `hf::resolveKeepCurrentField`
in `ESP32-CAM/lib/form_query/` as the server-side third half; all
three must move together when adding a new keep-current field.

**Server-side half now host-testable (issue #57, PR E).**
`host.cpp`'s `runAccessPoint` no longer carries the inline
trim-and-conditional-assign block; the logic moved into
`hf::resolveKeepCurrentField` with 5 Unity tests pinning empty /
whitespace-only / non-empty / both-empty / internal-whitespace-
preserved. A future regression that re-introduces unconditional
assignment (or strips internal whitespace incorrectly) now fails CI
rather than waiting for hardware testing. The three-layer contract
itself is unchanged; only the third layer's surface moved.

**Adding a second keep-current field is now mechanical.** Tag the
input in `sendConfigForm` with `data-keep-current-on-empty="1"`
(the JS validator's `dataset.keepCurrentOnEmpty === '1'` check
already generalises across fields), and route the `/save` assignment
through `resolveKeepCurrentField(getParam(query, "<name>"),
cfg_<name>)`. No new helper, no fresh inline check. Don't pre-abstract
the form-side `pwKeepAttr` / `pwHint` strings until there are at
least two such fields — there is no second field today.

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

### Third-party API keys belong in build-time macros, not source (issue #18)

**What happened.** The Google Geolocation API key used by
`getGeolocation` in `ESP32-CAM/esp_init.cpp` was committed as a
string literal at the top of the function body and pushed to a
public GitHub repository. Anyone reading the repo could spend the
quota on the owning Google Cloud project until the key was
revoked. The fix required two motions: an out-of-band human
action (revoke + re-issue in Google Cloud Console, which only the
project owner can do) and a code change (move the value out of
source).

**Why it happened.** The shape of the firmware code made
inlining the key the path of least resistance: there was no
existing build-time injection point at the time the function was
first written, so the literal sat there waiting for someone to
notice. By the time someone did, the value was already in git
history — removing it from `HEAD` does not unleak it, only
revocation does.

**How to avoid it next time.** Three rules:

1. **Treat any third-party API key as a build-time macro from
   day one.** The canonical pattern in this repo is
   `ESP32-CAM/extra_scripts.py`'s `env.Append(CPPDEFINES=[("NAME",
env.StringifyMacro(value))])` mirrored by `build.sh`'s
   `--build-property build.extra_flags=-DNAME=...`. Source order
   is env var → `.gitignored` file → empty-string default with a
   runtime guard. New keys (Slack webhooks, Discord tokens, OTA
   signing material, …) should follow the same shape — including
   the "only the length is logged at build time" rule, so CI
   build output is safe to share.
2. **If a key has already been pushed, rotation is the only
   real fix.** Removing the literal from `HEAD` and force-pushing
   is both insufficient (history caches, mirrors, code search
   indices) and forbidden here (no force-push to `main`). Revoke
   first, then commit the code change. Document the rotation
   procedure (e.g. the numbered procedure in
   [auth.md](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation))
   so the next person doesn't re-derive it under pressure.
3. **Watch for the third macro.** The "two builders, same macro,
   must agree" pattern (`extra_scripts.py` mirroring `build.sh`
   mirroring the Arduino-IDE `#ifndef` fallback in `esp_init.cpp`)
   is now load-bearing for two macros — `FIRMWARE_VERSION` (since
   PR #36) and `GEO_API_KEY` (since this entry). When a third
   build-time macro lands (Slack webhook, OTA signing material,
   per-environment Discord tokens, …), the three-way duplication
   starts to bite. The right move at that point is to consolidate
   the source-order + length-only-logging logic into a single
   `ESP32-CAM/build_macros.{sh,py}` that both paths source/import,
   instead of pasting a fourth `-D` into `build.extra_flags`.

**Coverage caveat.** The runtime guard in `getGeolocation` is
hardware-verified (a real ESP32-CAM module flashed from this
branch returned real Garching coordinates, not Null Island), but
it is **not** unit-tested. The function lives in `esp_init.cpp`
and depends on `WiFi.h` / `HTTPClient.h`, neither of which is
available to PlatformIO's `[env:native]`. A test-extraction
refactor of a four-line `if (apiKey[0] == '\0')` early-return
would be disproportionate; the missing coverage is intentional,
not forgotten.

### Orphan `/record_image` endpoint — every bare upload invisible (issue #58)

**What happened.** `duckdb-service/routes/modules.py`'s `record_image`
(`POST /record_image`) shipped as the canonical way to insert an
`image_uploads` row. Nothing in `image-service` called it. Every
successful `POST /upload` persisted the JPEG, wrote the sidecar, ran
classification, and POSTed progress + heartbeat — but never inserted
the row. As a result:

- the admin page (`backend /api/images` → `image-service /images` →
  `duckdb /image_uploads`) showed nothing for any bare upload,
- the dashboard's `last_image_at` column on `/api/modules` was empty,
- and the only way to test the partial-failure fix for #30 was the
  `Invoke-RestMethod -Uri /record_image` workaround documented in the
  issue.

Caught during manual testing of #50; pre-existing.

**Why it happened.** The duckdb endpoint was added in the same
iteration that introduced `UploadPipeline`, but the pipeline step that
calls it was forgotten — both halves of the contract need to land
together or the endpoint is fiction. No test exercised the
post-upload row from outside `image-service`, so neither suite
flagged the gap.

**How to avoid it next time.**

- **An endpoint without a caller is dead code; an endpoint with one
  caller is a contract.** When you add an HTTP route on a service that
  exists only to be called by another service in the monorepo, the
  caller's PR commits the call in the same change — or the endpoint
  doesn't ship. `grep -rn record_image image-service/` would have
  surfaced the gap on day one.
- **Cross-service catch blocks log.** The fix wires
  `_record_image_upload` into the pipeline with a `[record_image]
print(..., flush=True)` log on failure (matching the
  `[delete_image]` style in `image-service/app.py`'s `delete_image`)
  rather than the silent `except RequestException: pass` the older
  `_record_progress` / `_record_heartbeat` steps use. Same lesson as
  the "Three partial-failure shapes" entry above: every catch block
  at a service boundary answers what gets logged for the on-call and
  what the caller sees. The caller still sees 200 — file is on disk,
  classification ran — but the orphan is observable.
- **A boundary-spanning round-trip test would have caught this.**
  `tests/e2e/test_upload_pipeline.py` exercises the upload write
  path; an assertion that `GET /api/images` lists the just-uploaded
  filename pins the contract that the unit suites can't (each unit
  suite tests its own side of the boundary in isolation).

**Latency budget note.** Wiring `_record_image_upload` into
`UploadPipeline.run` adds a fourth serial duckdb-service round-trip
to the upload path (alongside `progress_count`, `add_progress`, and
the post-upload aggregate `heartbeat`). With `DuckDBService.__init__`'s
default `timeout=5.0`, worst-case duckdb-down latency on `/upload`
moves from ~15 s to ~20 s. Firmware's `TASK_WDT_TIMEOUT_S` is 60 s
(see [ADR-007](../09-architecture-decisions/adr-007-esp-reliability-breaker-and-daily-reboot.md)),
so nothing breaks today, but the budget tightened. A future
performance pass could fire `record_image` on a background thread or
batch the duckdb writes — both invasive, neither warranted yet.

### CLAUDE.md "Open-issue roadmap" drifted from the code (issues #19, #20, #36)

**What happened.** PR D was planned against the five-item roadmap entry
"`fix/esp-firmware-housekeeping` (closes #19, #20, #36)" in CLAUDE.md. On
read-through verification against `main`, three of the five items were
already done — independently fixed in earlier PRs without the roadmap
section being updated:

- **#36 Bug 1** (use-after-free on `fb->len` in the warm-up loops):
  closed in commit `4045116` ("fix: ESP32 firmware follow-ups (#36)").
  `ESP32-CAM/ESP32-CAM.ino`'s `setup`'s warm-up loop captures `size_t
fb_len = fb->len;` before `esp_camera_fb_return(fb)`, and the
  post-recovery loop does the same. The chapter-11 "Use-after-return
  on `esp_camera_fb_return` warm-up logging (issue #36)" entry above
  documents the fix; the roadmap kept listing the bug as pending.
- **#36 Bug 2** (heartbeats route doesn't canonicalise the mac):
  closed in commit `4045116` (same).
  `duckdb-service/routes/heartbeats.py`'s `post_heartbeat` wraps the
  inbound `raw_mac` in `ModuleId.model_validate(...).root` before the
  `INSERT`. The roadmap was written before this fix landed.
- **#36 Bug 3** (`FIRMWARE_VERSION` was three uncoordinated sources):
  closed in commit `4045116` (FIRMWARE_VERSION injection added to
  `ESP32-CAM/extra_scripts.py`), refined in commit `07c10ac` ("close
  #18 — inject Google Geolocation API key at build time") which added
  the `GEO_API_KEY` sibling alongside. `ESP32-CAM/VERSION` is now
  the sole source. `ESP32-CAM/extra_scripts.py`'s pre-build hook
  injects `("FIRMWARE_VERSION", env.StringifyMacro(version))` for the
  PlatformIO path; `ESP32-CAM/build.sh` passes
  `-DFIRMWARE_VERSION=\"${VERSION}\"` for the arduino-cli path;
  `ESP32-CAM/esp_init.h`'s `#ifndef FIRMWARE_VERSION` / `#define
FIRMWARE_VERSION "dev-unset"` is the documented Arduino-IDE-only
  fallback. No `"1.0.0"` or `"honeybee"` string remains in the tree.

The sharpest framing: **commit `4045116` is titled "fix: ESP32
firmware follow-ups (#36)" — the same PR that closed all three of
issue #36's sub-bugs**. The GH issue itself stayed open against the
roadmap, but the code shipped at the same time. The PR-D roadmap
entry was citing an issue whose actionable content had already been
delivered by the _same-numbered_ PR.

The actual PR D shipped only the **#19** (host.cpp `StaticJsonDocument`
512 → 1024 + `serializeJson > 0` guard before `setESPConfigured(true)`)
and **#20** (`cfg_interval_ms` default 300 → 60000 + form hint + the
load-fallback fix) work; the other three were closed by PR-body
quotation of the actual-already-resolved code.

**Why it happened.** The "Open-issue roadmap" section was written
once when the issues were filed and never reconciled when the fixes
landed in earlier PRs. PRs A and B (closed in earlier rounds, also
deleted from the same roadmap section per the documented protocol)
removed their own entries on close; the fixes that landed _without
an associated PR-D-closing-this commit_ (Bug 1 and Bug 2 in
particular, plausibly hardened during the round-2 senior-reviewer
passes on the PRs that earned the chapter-11 entries cited above)
left the roadmap section behind.

**How to avoid it next time.** Three rules, in priority order:

1. **The "delete the section when the PR is opened" protocol must
   apply to _any_ PR that resolves an item in the roadmap, not just
   the PR explicitly tagged with the roadmap-section letter.** If a
   side-quest commit during PR-N happens to close a bug listed under
   PR-D's roadmap entry, that line gets deleted in the same commit
   that lands the fix. The roadmap is _signal that work is owed_; a
   stale line in it is a lie about ownership.
2. **Plan-phase verification reads the code, not the roadmap.** PR D's
   planning agent caught all three already-done items by reading
   `ESP32-CAM/ESP32-CAM.ino`'s `setup`'s warm-up loop, `routes/heartbeats.py`'s
   `post_heartbeat`, and `extra_scripts.py`'s `FIRMWARE_VERSION` injection
   directly. The "Trust code, not commit messages" rule in CLAUDE.md
   extends to "trust code, not the roadmap" too. Three minutes of
   `grep` saves a PR's worth of phantom changes.
3. **A roadmap entry should cite _which_ file/symbol still needs the
   fix, not a generic description.** The PR-D entry said
   "`host.cpp`'s `saveConfig` and `esp_init.cpp`'s `loadConfig`"
   for #19. Two `loadConfig` symbols exist (`host.cpp`'s reads the
   captive-portal RAM shadow, `esp_init.cpp`'s reads the production
   `esp_config_t`); the roadmap named the wrong one. The actual
   `<512>` sites were both in `host.cpp` — its `saveConfig` _and_
   its own `loadConfig`. A symbol-form citation read against the
   code at write time would have surfaced this — the same discipline
   the "Drift sweep is not a substitute for a CI check" entry above
   demands of `path:line` references in `docs/`.

**Dead-weight discovery: `CAPTURE_INTERVAL` was written but never
read — removed in PR-G.** When PR-D landed, no firmware path read
`esp_config->CAPTURE_INTERVAL` for capture scheduling.
`ESP32-CAM/ESP32-CAM.ino`'s `loop` schedules captures purely on the
`firstCaptureDone` flag and the `tm_hour == 12 && tm_yday !=
lastCaptureDay` clock — once on boot, once daily at noon. The
interval value moved through `host.cpp`'s captive-portal RAM
shadow, SPIFFS, `esp_init.cpp`'s `loadConfig`, into
`esp_config_t::CAPTURE_INTERVAL`, and stopped there. Issue #20's
filed-symptom ("300 ms means ~3 upload attempts per second") was
based on an earlier version of `loop` (or anticipated behaviour)
that never landed. PR-D hardened the read/write path of a value
that was inert; the surface itself was removed in PR-G via Option B
from
[#65](https://github.com/schutera/highfive/issues/65) (remove the
field) — the form, the SPIFFS key, the `esp_config_t` member, and
the `/save` handler floor are all gone. Operator-configurable
cadence is left to a future feature PR that would interact with
ADR-007's daily-reboot logic and ship with hardware-cadence
verification.

**ArduinoJson v6 `|` semantics — load-bearing for the missing-key
path.** `JsonVariant::operator|(T default)` returns the default
**only** when the variant is unbound, `null`, or not convertible to
`T`. For an int variant, a stored `0` is convertible to `int` and
`|` returns `0`, not the default. This is why PR-G adds explicit
`| hf::defaults::k*ProductionFallback` to every camera-field read
in `esp_init.cpp`'s `loadConfig` — without it, a missing
`VERTICAL_FLIP` / `BRIGHTNESS` / `SATURATION` key returned 0 from
the framework, silently overwriting the default-init's documented
production fallback (`1` / `1` / `-1`). A stored `0` for these
fields is still a legitimate operator choice and reads through
unchanged; the `|` only fires for the missing-key case.

**Dual-reader asymmetry (resolved in PR-G via named constants).**
`host.cpp`'s `loadConfig` and `esp_init.cpp`'s `loadConfig` are
two independent readers of the same `/config.json` keys, with
intentionally different fallbacks per site:

- `host.cpp`'s `loadConfig` → form-prefill values (what the
  captive-portal form shows the operator on first boot).
- `esp_init.cpp`'s `loadConfig` → production fallbacks (what the
  device runs when the key is missing or no config file exists).

The defaults differ on purpose. The form prefills the operator-
facing default; the production reader picks the value the device
should actually run with when nothing is configured. Aligning the
two to one value would re-enable an entire class of silent-
misconfiguration bugs (a missing key in `esp_init.cpp` would then
read as the form-prefill default rather than the production
fallback, defeating the safety-net intent).

The permanent fix recommended here — a shared
`firmware_defaults.h` with **named** constants per
`(field, intent)` pair — shipped in PR-G as
[`ESP32-CAM/lib/firmware_defaults/firmware_defaults.h`](../../ESP32-CAM/lib/firmware_defaults/firmware_defaults.h).
Each pair is now `hf::defaults::k<Field>FormFallback` and
`hf::defaults::k<Field>ProductionFallback`, used at exactly one
site each. A future contributor staring at `host.cpp` and
`esp_init.cpp` cannot mistake the form-prefill default for the
production fallback just by looking at the literal — the names
distinguish them. The bug class behind PR-42's "Telemetry sidecar
envelope drift" lesson is now structurally harder to reintroduce
for this set of fields, closing
[#66](https://github.com/schutera/highfive/issues/66).

### Post-reflash dashboard latency: status is derived, not stored (#15)

**What happened.** After flashing a new firmware build onto a
module via USB, the dashboard kept showing the module as 'offline'
for 30–90 seconds after the flash completed and the device was
clearly alive (Serial monitor showed `[BOOT]`, WiFi connected, the
operator could see network traffic). The status only flipped to
'online' once the first daily capture fired its post-upload
aggregate heartbeat. For a once-on-boot + daily-noon capture
cadence, that meant operators stared at a stale 'offline' badge
through most of the reflash workflow.

**Why it happened — and where the narrative had to be corrected.**
The dashboard's `Module.status` is **derived** server-side in
`backend/src/database.ts`'s `fetchAndAssemble` from the freshest
of three timestamps — `image_uploads.uploaded_at`,
`module_configs.updated_at`, and the latest
`module_heartbeats.received_at` — with a 2 h window.
A `module_configs.status` column once lived on the schema and,
despite its name, was never read by the dashboard. It was the
dead-weight twin of `CAPTURE_INTERVAL` and was dropped in the
follow-up PR that closed
[#69](https://github.com/schutera/highfive/issues/69) (see the
"Stored-vs-derived state needs a named owner" sub-section below).
Treat the rest of this entry's references to that column as
historical context for the lesson, not a description of the
current schema.

The senior-reviewer of this PR caught a load-bearing factual
error in the first draft of this entry **and** in the in-source
comment at `backend/src/database.ts`'s `fetchAndAssemble` (the
"earlier draft gated `'unknown'` on `!m.updated_at`" note): both
asserted that `updated_at` "never refreshes after registration."
That is false. `duckdb-service/routes/modules.py`'s `add_module`
contains an `ON CONFLICT (id) DO UPDATE SET ... updated_at =
NOW()` branch (at the time the lesson was written, the same
clause also rewrote a `status` column that has since been dropped
— see [#69](https://github.com/schutera/highfive/issues/69)) that
fires on every call. Firmware calls `initNewModuleOnServer`
unconditionally in `setup()` on every boot, so `updated_at` is
rewritten on every reflash and every daily reboot. That UPSERT
plants a freshness signal in `module_configs.updated_at` long
before the boot heartbeat fires, and the dashboard's `lastSeenAt`
candidate set picks it up.

So why is the boot heartbeat still warranted? **Three reasons,
none of them about `lastSeenAt` freshness:**

1. **Defense-in-depth for the registration POST failing.** The
   `initNewModuleOnServer` HTTP call can fail (network race,
   server transient unavailability). If registration fails AND
   we wait for the loop's first-iteration heartbeat, the
   dashboard sees a stale `updated_at` for the full setup
   pipeline duration (30+ s). The boot heartbeat plants a
   second, independent freshness signal in `module_heartbeats`
   so the dashboard recovers even if registration didn't.
2. **Fresh telemetry for the panel that the UPSERT doesn't
   reach.** Heartbeat rows carry `battery`, `rssi`, `uptime_ms`,
   `free_heap`, and `fw_version` — and surface as
   `Module.latestHeartbeat` (per ADR-004), which the
   `/heartbeats_summary` query reads strictly from
   `module_heartbeats`, never from `module_configs`. The
   registration UPSERT _does_ write `module_configs.battery_level`
   on every boot, but that column feeds a different DTO field;
   the telemetry panel itself doesn't read it. So `rssi`,
   `uptime_ms`, `free_heap`, and `fw_version` are not written
   anywhere on the boot path at all, and `battery` on the panel
   would still show the pre-reflash heartbeat value until the
   hourly cadence ticks. The boot heartbeat refreshes the panel
   within seconds. (The first draft of this bullet said "none of
   which the UPSERT refreshes" — that was wrong about
   `battery_level`; corrected here against the DDL.)
3. **The hourly cadence isn't aware of boots.** `lastHeartbeatMs
== 0` short-circuits the first iteration, but that iteration
   runs after the full setup pipeline — WiFi + geolocation +
   registration + camera init + 3-frame warm-up + NTP sync,
   consistently 30+ s and sometimes more on real hardware. The
   boot heartbeat closes that window for the telemetry panel,
   even though the status badge was already covered by the
   registration UPSERT.

**How to avoid it next time.** Two complementary rules:

1. **Plant freshness signals early — including ones the next
   table over already provides.** When two write paths
   contribute to the same derived field (here `lastSeenAt`),
   firing both early is cheap belt-and-braces. The #15 fix
   inserts a `sendHeartbeat(&esp_config)` call immediately after
   `initNewModuleOnServer()` returns, before the slow camera
   init begins, so the boot signal is independent of the
   registration POST succeeding **and** carries fresh telemetry
   that the registration UPSERT doesn't. Same fix serves the
   ADR-007 daily-reboot path with no extra code. The general
   rule: when verifying a state-derivation bug, enumerate every
   write path that contributes to the derived field and confirm
   each one's behaviour from the actual DDL, not from comments.
   The first draft of this entry shipped a "`updated_at` never
   refreshes" claim that the `ON CONFLICT` UPSERT directly
   contradicts.
2. **Stored-vs-derived state needs a named owner.** The
   `module_configs.status` column was dead weight at the time
   this lesson was written — it had a CHECK constraint
   (`'online' | 'offline'`), was rewritten `'online'` on every
   registration, and was never read by the dashboard. Resolved
   by [#69](https://github.com/schutera/highfive/issues/69):
   removed from the `CREATE TABLE` for fresh DBs and migrated
   off existing DBs via a transactional table-rebuild in
   `duckdb-service/db/schema.py`'s `init_db`. The rebuild was
   necessary because DuckDB v1.4 rejects every `ALTER TABLE` on
   `module_configs` (DROP COLUMN, DROP CONSTRAINT, SET DEFAULT)
   with `DependencyException` due to the
   `nest_data.module_id → module_configs.id` foreign key — the
   FK locks the whole table regardless of which column the ALTER
   targets, so the rebuild copies dependents into TEMP tables,
   drops the FK chain in reverse order, recreates each table
   with the cleaned schema, and restores data. Same shape as
   [#65](https://github.com/schutera/highfive/issues/65)'s
   `CAPTURE_INTERVAL` resolution in PR-G (drop rather than
   retrofit writers). The lesson stands: leaving a
   stored-but-unread field in place encourages the next
   contributor to "update status" in a new code path and discover
   only at integration time that the dashboard ignores their
   writes. **Operational corollary**: dropping a column from a
   DuckDB table referenced by a foreign key is not a one-liner —
   plan for a multi-table rebuild migration, a regression test
   (see `duckdb-service/tests/test_schema_migration.py`), and a
   backup step in the production-deploy runbook when the next
   such column surfaces.

When a field exists on a schema but no read path consults it, the
design has a third party who left and didn't come back; either wire
it through or remove it, but don't leave it in the table as a
debugging hazard. Two such dead-weight fields existed at the time
this lesson was written; both have been dropped — see PR-G for
[#65](https://github.com/schutera/highfive/issues/65)
(`CAPTURE_INTERVAL` in `esp_config_t`) and the PR that closed
[#69](https://github.com/schutera/highfive/issues/69)
(`module_configs.status`).

### Column-name-vs-behaviour drift: `first_online` (#75)

**What happened.** The per-upload heartbeat handler at
`duckdb-service/routes/modules.py`'s `heartbeat` shipped with an
unconditional `SET first_online = ?` write where `?` was today's
date. The column's name asserts "the calendar date the module was
first registered", but its actual behaviour was "the date of the
most recent upload." A module onboarded on 2024-04-15 and
uploading daily showed `firstOnline: 2026-05-13` on the dashboard
within hours of its first upload of that day. The bug rode along
through every dashboard render that surfaced `Module.firstOnline`
from the contracts package.

**Why it happened.** Two paths write to the same column —
`add_module` at registration (legitimately "this is the
registration date", written on the INSERT path; the `ON CONFLICT
DO UPDATE` clause deliberately omits it on re-registration) and
the per-upload heartbeat (where the write was never load-bearing
for any consumer). The heartbeat inherited the write from an
early iteration that conflated "first-online" with "last-online,"
and nobody re-examined the SQL when the column's semantic owner
was clarified. The bug then hid in plain sight: the column had a
believable value (today's date or some recent date) on every
read, so no monitoring trip fired. Discovery chain: PR #76's
round-2 senior-reviewer flagged the unconditional `SET
first_online` while reading the route to verify the dead-weight
`status` column was actually gone; the author recorded it as a
caveat in `image-service/services/upload_pipeline.py`'s
`_record_heartbeat` docstring. PR #76's round-3 senior-reviewer
caught the unticketed footnote as a tracking-debt issue and the
author filed [#75](https://github.com/schutera/highfive/issues/75)
in the same fixup commit. This PR closes it.

**How to avoid it next time.**

1. **A column's name is a contract.** When a single column has
   multiple write paths (`add_module` + heartbeat here), each
   write site must honour the contract the name asserts. The
   `COALESCE(first_online, ?)` fix encodes the contract in the
   SQL itself — "fill on first write, never overwrite." Apply
   this discipline at code-review time: any
   `UPDATE ... SET <name_implies_invariant> = ?` should justify
   why the invariant doesn't apply, or use COALESCE.
2. **Defensive branches against `NOT NULL` columns are
   intentional, not redundant.** The schema declares
   `first_online DATE NOT NULL`, so the COALESCE-on-NULL branch
   is unreachable in current production. It is shipped anyway —
   defensive against legacy rows, manual SQL inserts, and any
   future migration that relaxes the NOT NULL. Inline comments
   make this intent explicit so a future reader doesn't
   "simplify" the SQL by removing the COALESCE.
3. **The docstring-footnote-to-tracking-issue arc must complete
   before merge.** PR #76's round-2 introduced the footnote;
   round-3 caught that no issue tracked it and filed #75 in the
   same fixup commit. The footnote-as-IOU pattern is fine as long
   as someone files the issue before the merge that ships the
   footnote — if the chain breaks (footnote ships, no issue
   filed), the bug ages out into the codebase until the next
   reader stumbles over it. Worth a step in the senior-reviewer
   checklist: "any docstring footnote naming a known bug must
   cite a tracking issue."

ADRs (`docs/09-architecture-decisions/adr-001` and
`adr-004-heartbeat-snapshot-in-contracts`) still list the
heartbeat as updating `battery_level/first_online/image_count`.
That phrasing is intentionally left alone — ADRs record the
decisions in force when written, not the running behaviour. The
chapter-11 entry you're reading is where running-behaviour
corrections live.

### OTA migration is one-way: partition table change blocks the first OTA (issue #26)

**What happened.** Issue #26 (closed by this PR) introduced OTA firmware
updates for ESP32-CAM modules. The change required flipping the
partition layout from the ESP32 default (single ~1.9 MB app slot, no
OTA slots) to `min_spiffs` (two ~1.9 MB app slots — `app0`/`app1`
— plus a smaller SPIFFS). The catch: **a module running the old
partition layout cannot install the new partition layout via OTA**.
The first OTA-capable binary still has to arrive via USB or the web
installer's merged-bin flash; every subsequent update can then be
wireless.

**Why it happened.** The bootloader reads the partition table from
flash offset `0x8000` at every boot. The OTA write path
(`Update.write()` / `esp_ota_write()`) targets the inactive
application slot — at offset `0x10000` or `0x1F0000` for the
`min_spiffs` layout — and does **not** touch the partition-table
region. So an OTA push to a module on the old single-slot layout has
no second slot to write to; `Update.begin()` fails. Even if you
contrived a way to write the new partition table directly to
`0x8000`, you'd be doing an unsafe live edit of the bootloader's
read source under a running application — there's a reason the OTA
abstraction doesn't expose that surface. The clean answer is "first
flash via USB; all subsequent flashes OTA".

This makes the partition flip a **one-way migration gate**. Every
module currently deployed in the field needs one final USB visit
before it can participate in OTA. After that, no more USB visits.

**How to avoid it next time.** Two complementary rules:

1. **When introducing a feature whose enablement requires changing
   a region that the feature itself does not control, document the
   one-way migration explicitly — runtime view + deployment view +
   ADR all at once.** A reader who finds only the runtime-view doc
   ("here is how OTA works") will draft a "push the new firmware to
   every field unit" plan without realising the first push to each
   unit cannot succeed. The one-way step has to be impossible to
   miss when planning a rollout.
   [`docs/06-runtime-view/ota-update-flow.md`](../06-runtime-view/ota-update-flow.md),
   [`docs/07-deployment-view/esp-flashing.md`](../07-deployment-view/esp-flashing.md)'s
   "First-time OTA migration" subsection, and
   [ADR-008](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md)'s
   "Consequences" section all carry the warning so a future operator
   coming in from any entry point hits it.

2. **When the merged-bin web installer and the OTA fetch path
   diverge in what they expect, make the divergence loud in the
   build artifact, not in operator memory.**
   [`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh) publishes both
   `homepage/public/firmware.bin` (merged: bootloader + partitions +
   app, for the web installer) **and**
   `homepage/public/firmware.app.bin` (app-only, for the OTA fetch),
   each with its own md5 in the shared `firmware.json` manifest. The
   filenames differ; the manifest fields differ
   (`md5`/`built_at` for web installer,
   `app_md5`/`app_size` for OTA). Two complementary guards keep them
   from crossing:
   - **Manifest-shape guard.** The
     [`ESP32-CAM/lib/ota_version/`](../../ESP32-CAM/lib/ota_version/)
     parser rejects manifests missing `app_md5`/`app_size`; the
     native tests in `test/test_native_ota_version/` pin the wire
     shape. A future contributor who removes `app_md5` from the
     manifest emit-side gets a loud parse failure on every module's
     next boot, not a silent bricking.
   - **Artifact-correspondence guard.**
     [`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh) asserts
     `firmware.app.bin` is strictly smaller than `firmware.bin`
     before writing the manifest. A refactor that crosses the two
     `cp` sources (or a change to esptool merge that flips the
     sizes) fails the build loudly. Without this assertion the
     manifest's MD5 would happily match whatever bytes
     `firmware.app.bin` contains — including, by accident, the
     merged image — and the OTA path would write bootloader bytes
     onto the app slot at flash time.

### OTA rollback isn't bootloader-driven on Arduino-ESP32 (PR-F manual T4)

**What happened.** ADR-008's first cut described OTA rollback as ROM-
bootloader work: "If the firmware crashes, watchdog-fires, or panics
before reaching the gate, the bootloader reverts to the previous
`ESP_OTA_IMG_VALID` slot on the next reset." Round-1 review accepted
the design and the round-1 implementation gated an app-side
forceRollback on `esp_ota_get_state_partition(running) ==
ESP_OTA_IMG_NEW || ESP_OTA_IMG_PENDING_VERIFY`. Manual T4 (mining
firmware with `abort()` before mark-valid) then reproduced an
unrecoverable mining-boot loop — 4+ panic-reboot cycles, no rollback
ever firing.

**Why.** Two facts the IDF docs imply but don't make obvious to a
reader of one chapter at a time:

1. Arduino-ESP32 ships a **prebuilt** bootloader with
   `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=n`. Without that config the
   ROM does not transition a new slot into `ESP_OTA_IMG_PENDING_VERIFY`
   on first boot and does not roll back on subsequent panics — the
   slot just keeps booting. So `esp_ota_mark_app_valid_cancel_rollback()`
   in our setup() flow is **load-bearing for nothing** unless the app
   itself takes action.
2. `esp_ota_set_boot_partition()` in the IDF version arduino-esp32 v2
   uses can in practice leave the new slot reporting
   `ESP_OTA_IMG_VALID` immediately after `Update.end()`. Gating an
   app-side check on "state != VALID" therefore also skips bad slots.
   Round-2 of T4 reproduced this by widening the check; the loop
   continued.

The fix that actually fires is state-free: every faulty reboot
(reset_reason ∈ {PANIC, TASK_WDT, INT_WDT, WDT, BROWNOUT}) increments an
NVS counter, mark-valid at end of setup() resets it, threshold of 3
forces `esp_ota_mark_app_invalid_rollback_and_reboot()`. Senior-
review caught one more bug in this design: the early state-free
draft incremented on **every** boot, which collided with
`WIFI_FAIL_AP_FALLBACK_THRESH = 3` and would have triggered false
rollback to old firmware on three consecutive transient WiFi outages.
The reset-reason gate fixed that.

**How to avoid next time.**

- **Verify safety nets on hardware, not in IDF docs.** Anything that
  claims "the bootloader will recover this" needs to be exercised by
  deliberately bricking a slot on the same firmware build path that
  ships. The unit-test surface for partition-state transitions is
  essentially nil; what looks correct on a screen passes review and
  still doesn't fire.
- **Trust code, not the IDF version table.** arduino-esp32's
  bootloader config differs from `idf.py menuconfig` defaults; the
  prebuilt `bootloader.bin` is checked into the framework package and
  is what ships, regardless of what the IDF version's docs imply.
- **When a "transient failure" threshold and a "permanent failure"
  threshold both default to 3 boots, they will collide.** Search
  for other thresholds the new threshold could clash with before
  declaring victory. Manual T4 surfaced this only because round-1
  testing happened to retry WiFi connect at the same time the
  forceRollback counter was incrementing — easy to miss otherwise.
- **`ESP.restart()` from inside `setup()` is invisible to the
  reset-reason gate.** Round-3 senior-review caught
  `ESP32-CAM/esp_init.cpp`'s `initEspCamera` calling `ESP.restart()`
  on `esp_camera_init` failure — producing `reset_reason=SW`, which
  the gate treats as a clean reboot. A bricked OTA whose camera
  driver fails to init would have reboot-looped forever without
  triggering rollback. Use `abort()` (or `esp_system_abort()`) for
  fatal-this-slot-is-broken signals in setup; reserve `ESP.restart()`
  for "operator-initiated clean reboot" paths (AP-fallback,
  captive-portal factory-reset, daily-reboot, upload-circuit-breaker
  in `loop()`). Any future `ESP.restart()` added inside `setup()` is
  a regression vector for this design.

**Trail of the fix.** Commit `0ed2537` introduced the state-gated
version (didn't fire); commit `9ad1658` rewrote it state-free (fires,
but with the WIFI_FAIL collision); commit `deec615` added the
reset-reason gate (closes WIFI_FAIL collision); a follow-up commit
on the same branch changes `initEspCamera`'s `ESP.restart()` to
`abort()` (closes the `ESP.restart()`-in-setup blind spot caught by
senior-review round 2).

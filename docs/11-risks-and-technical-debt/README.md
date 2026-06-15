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
- **Dashboard visitor IPs leave HiveHive infra to reach ipapi.co.**
  `GET /api/user-location` (issue #14, [ADR-012](../09-architecture-decisions/adr-012-dashboard-ip-geo-hint.md))
  forwards the visitor's IP to a free third-party IP-geolocation
  service to compute the "first-paint near you" map centre. The IP is
  not logged on our side and not joined to any HiveHive identifier,
  but it does briefly leave our infrastructure. The current Impressum
  / data-protection notice does not mention this; if HiveHive ever
  reaches an audience that warrants a real GDPR posture, this flow
  needs to surface there. Tracked here, not as a bug.

## Lessons learned

This section grows over time. Each entry is a problem we paid for —
write the lesson here so the next contributor doesn't repeat it.
Format: short title + **What happened** + **Why it happened** +
**How to avoid it next time**.

### A sparse wire field broke an `ARG_MAX` summary fold — the dashboard signal would have latched forever (#172, review-caught)

**What happened.** #172 added `last_hb_fail_code` / `last_hb_fail_count`
to the heartbeat so a reboot-looping module reports _why_ its hourly
heartbeats fail. The first cut attached the fields **only when a streak
existed** (`if (prevHbFail.count > 0)` in
`ESP32-CAM/client.cpp`'s `sendHeartbeat`), mirroring the conditional
geolocation-recovery fields right above it. Every unit test passed and
the field round-tripped correctly. But the backend folds the latest value
into the dashboard via `ARG_MAX(last_hb_fail_count, received_at)` in
`duckdb-service/routes/heartbeats.py`'s `get_heartbeats_summary`, and a
recovered module — sending nothing → NULL — would have made the
**"possible reboot loop" banner stick forever**: once a module had logged
a non-zero streak, it could never visibly recover. Caught in senior-review,
before merge, not in the field.

**Why it happened.** DuckDB's `ARG_MAX(value, ordering)` **ignores rows
where `value` IS NULL** — it does not return "the `value` at the max
`ordering`", it returns "the max-`ordering` row _among rows with a
non-null value_". So a sparse column (present only on the exceptional
path, NULL otherwise) makes `ARG_MAX` skip every recovery row and latch
the last non-null reading. The `#148` diagnostic fields next to it didn't
hit this only because they're sent on _every_ heartbeat (always non-null
for that firmware). The conditional-attach instinct — copied verbatim
from the geolocation fields a few lines up — was wrong here because those
fields drive a one-shot `UPDATE` side effect, never an `ARG_MAX` fold.
Verified empirically: `ARG_MAX(cnt, ts)` over `(ts=10:00, cnt=3)`,
`(ts=11:00, cnt=NULL)` returns `3`, not NULL.

**How to avoid it next time.** A wire field that a summary endpoint folds
with `ARG_MAX` / `LAST` / any "latest non-null wins" group-by **must be
sent densely** — emit an explicit `0`/sentinel on the normal path, never
omit-it-to-NULL — so the latest row always wins and a transient state can
clear. Sparse-when-absent is only safe for fields read row-by-row (the
`/heartbeats` list endpoint) or fields that drive a side effect rather
than a fold (the geolocation `latitude`/`longitude` recovery). Beware the
**dense-vs-sparse juxtaposition trap** now living a few lines apart in
`sendHeartbeat`: `battery` is deliberately **omitted** (sparse — the
`measurements` dual-write treats `0` as a real sample, so a missing
reading must be an absent row), while the fail-streak is deliberately
**dense** (the summary `ARG_MAX` treats NULL as skip, so a healthy state
must be a real `0`). They are opposite **on purpose**; a "consistency"
cleanup that aligns one to the other reintroduces a shipped-and-fixed bug
in whichever direction it moves. Regression pin:
`duckdb-service/tests/test_heartbeats_endpoint.py`'s
`test_heartbeats_summary_clears_streak_after_recovery_not_latching` seeds
a `count=3` streak then a `count=0` recovery and asserts the summary
returns `0`. This is the same "envelope right, behaviour wrong" family as
the `date_trunc` all-zeros bug below — and the same CLAUDE.md rule #5
fix: aggregation tests must seed real data and assert it lands in the
expected bucket.

### `RTC_NOINIT` survives `ESP.restart()` but **not** the bench RTS/EN reset — `esp_reset.py` cannot exercise any cross-reboot RTC feature (#172, found while QA-ing the PR)

**What happened.** Verifying the #172 heartbeat-failure streak on real
hardware, the streak (`last_hb_fail_count`) reset to `0` on every reset and
never accumulated across reboots, even though each boot's heartbeat
demonstrably failed and called `hbFailureNote`. It looked like the
`RTC_NOINIT` slot wasn't persisting at all — i.e. a feature bug. It is not:
the streak is fine in the field, the **bench reset tooling** just can't
produce the reset _type_ the feature needs.

**Why it happened.** `RTC_NOINIT_ATTR` data (the issue-#42 cross-reboot
breadcrumb in [`ESP32-CAM/lib/breadcrumb`](../../ESP32-CAM/lib/breadcrumb/) and
the `lib/hb_failure` streak both use it) lives in RTC slow memory, which is
retained across a **software** reset (`ESP.restart()` → `ESP_RST_SW`) and
wiped on a **power-on / EN-pin** reset (`POWERON_RESET`, `rst:0x1` in the
boot banner). [`scripts/esp_reset.py`](../../scripts/esp_reset.py) and
[`scripts/esp_capture.py`](../../scripts/esp_capture.py) reset the board by
pulsing the CH340's RTS line, which pulls **EN** low — a `POWERON_RESET` that
**clears RTC memory**. So a bench reset is indistinguishable, to RTC, from a
power cycle: the magic guard correctly reports "no streak" and the count
starts fresh every boot. Every _field_ reboot path, by contrast, is a clean
`ESP.restart()` — `livenessReboot`, `wifiHealthReboot`, the daily reboot, OTA
post-flash, and the upload circuit breaker — so the #170 reboot-loop case
(a `livenessReboot`) preserves the streak and the next boot heartbeat carries
it. The dense-`0` emission, store, summary fold and dashboard banner were all
verified end-to-end by injecting heartbeats directly; only the on-silicon
_cross-reboot accumulation_ is what the bench reset cannot show.

**How to avoid it next time.** When QA-ing **any** `RTC_NOINIT` feature
(breadcrumb, heartbeat-failure streak, future RTC counters), do not expect
state to survive an `esp_reset.py` / `esp_capture.py` reset or a physical RST
button press — those are EN/`POWERON_RESET` and wipe RTC. Trigger a
**software** reboot instead (induce a watchdog `ESP.restart()`, or wait for
the real `livenessReboot`), and confirm the boot banner reads a software
reset reason, not `rst:0x1 (POWERON_RESET)`. The pure note/peek/clear logic is
better asserted in the native suite
([`test_native_hb_failure`](../../ESP32-CAM/test/test_native_hb_failure/test_hb_failure.cpp),
[`test_native_breadcrumb`](../../ESP32-CAM/test/test_native_breadcrumb/test_breadcrumb.cpp))
than on hardware; reserve the board for the dense-emission-on-the-wire check,
which a single boot proves.

### `build.sh` release binaries ran without PSRAM — the FQBN's missing `FlashMode=dio` linked `qio_qspi` libs against a `dio`-flashed image (#163)

**What happened.** A `build.sh`-built (release-path) firmware booted reporting
`-- PSRAM: found=0 size=0 bytes` and `initEspCamera` fell back to `FRAMESIZE_VGA` +
`CAMERA_FB_IN_DRAM` + `jpeg_quality 15` (warm-up frames ~10–13 KB). Every
`pio run -e esp32cam` binary on the **same** board reported
`found=1 size=4192123 bytes` (frames ~22–37 KB). Because `build.sh` is the OTA
release path, every field module would silently upload degraded images after the
next OTA, with nothing failing loudly.

**The false lead (a real bug, but not this symptom's cause).** First diagnosis:
`build.sh`'s `--build-property "build.extra_flags=…app macros…"` wholesale-replaced
the ESP32 core's default `build.extra_flags`, which is the only thing that threads
`{build.defines}` — i.e. `-DBOARD_HAS_PSRAM` + the two psram cache-fix flags — into
the compile recipe (`platform.txt`'s `recipe.cpp.o.pattern` references
`{build.extra_flags}`, never `{build.defines}` directly). That genuinely dropped
`BOARD_HAS_PSRAM` (and `-DESP32`, `CORE_DEBUG_LEVEL`, `ARDUINO_USB_CDC_ON_BOOT`), so
it was fixed by moving app macros to the empty-by-default `compiler.c.extra_flags` /
`compiler.cpp.extra_flags` slots. **But flashing the define-fixed binary still gave
`found=0`.** A compile-flag audit passed; the symptom didn't move. This is the
lesson's core: _the define reaching the compiler was necessary but not sufficient,
and only a bench flash + serial check exposed that._

**The real cause (bench-isolated).** With the defines now identical between the two
builds, the only remaining difference was `build.memory_type`: **pio linked
`dio_qspi`, `build.sh` linked `qio_qspi`.** The core's link/compile recipe pulls
precompiled libraries _and the bootloader_ from
`{compiler.sdk.path}/{build.memory_type}`, where
`build.memory_type={build.boot}_qspi` (`platform.txt`, core 2.0.17). A bare FQBN
(`esp32:esp32:esp32cam`) takes the global default `build.boot=qio` → `qio_qspi`. But
`build.sh` flashes in **dio** mode (`FLASH_MODE=dio`), and pio's board JSON pins
`flash_mode=dio` → `dio_qspi`. So `build.sh` ran a `qio`-compiled bootloader + libs
against a `dio`-flashed chip; that flash-mode/lib mismatch makes `esp_psram_init()`
fail at boot. The `boards.txt` `FlashMode.dio` menu (`esp32cam.menu.FlashMode.dio`, core 2.0.17) sets **both**
`build.flash_mode=dio` _and_ `build.boot=dio`, so selecting it via the FQBN makes the
libs, bootloader, and flash mode all agree — matching pio, which is why pio always
reported `found=1`. Bench-proven on COM13 (AI-Thinker, ESP32-D0WD-V3):
`qio_qspi → found=0`, `dio_qspi → found=1`.

**How to avoid it next time.**

1. **A passing compile-flag/define audit does not prove runtime behaviour.** Only a
   bench flash of the _release_ binary + a serial check (`-- PSRAM: found=1`) proves
   PSRAM (or any boot-time hardware bring-up) actually works. Infer-from-the-binary
   was wrong here once already this session.
2. `build.sh` now pins `FQBN=esp32:esp32:esp32cam:FlashMode=dio` and grows **two**
   permanent guards over its `--verbose` `build/compile.log`: (a) `-DBOARD_HAS_PSRAM`
   reached g++, and (b) the linked memory_type is `dio_qspi` (not `qio_qspi`) so it
   matches the dio flash mode. Guard (b) is the one that catches this class of bug.
3. When a sketch's `arduino-cli` FQBN omits the IDE menu selections (FlashMode,
   PSRAM, PartitionScheme…), it silently inherits core defaults that may not match
   the board's intent or the flash parameters you pass to `esptool merge_bin`. Make
   the menu selections explicit in the FQBN and keep them consistent with `FLASH_MODE`.
4. Inject app macros via `compiler.{c,cpp}.extra_flags`, never by overriding
   `build.extra_flags` (which clobbers `{build.defines}`).
5. The release runbook (`docs/07-deployment-view/firmware-release.md`) now flashes one
   bench module and confirms `found=1` before publishing.

### Seeded "JPEGs" are undecodable random bytes — a pixels-rendered assertion can never pass against default fixtures (#154 phase 1)

**What happened.** The new `module-latest-capture.spec.ts` asserted the
ModulePanel "Latest capture" `<img>` actually decodes
(`complete && naturalWidth > 0` — the one thing jsdom structurally cannot
prove). It timed out on every run: the card rendered, the `src` was
right, the bytes came back `200` — and `naturalWidth` stayed `0` forever.

**Why it happened.** `tools/mock_esp.py::_make_fake_image` uploads
pseudo-random bytes wrapped in JPEG SOI/EOI markers. The upload pipeline
never decodes images, so every server-side layer is happy — but a browser
cannot decode them, ever. The failure mode was already known implicitly:
`admin-image-pagination.spec.ts` counts grid cells instead of `<img>`
elements "because thumbnails may fail to load" — the institutional
knowledge existed but lived in one spec's comment, not in the fixture
docs, so the next spec author (this one) re-paid for it.

**How to avoid it next time.** If a spec must prove pixels decode, seed a
real JPEG for that fixture — `seed_ui_fixtures.py::seed_admin_gallery_images`
now uploads `dev-tools/mock_fully_filled.jpg` as the gallery module's
newest capture for exactly this. Never assert image _loading_ against
default mock-ESP uploads. Rules + the re-seed-pollution gotcha (re-running
the seed on a reused stack accumulates uploads and breaks exact-count
specs) are documented where spec authors will look:
`tests/ui/README.md` → "Seeded image bytes are NOT decodable".

### A documented "this is unaffected" claim cost a debug session — Docker Desktop's Windows forwarder stalls ESP **uploads** too (#154 bench session)

**What happened.** A freshly flashed module booted healthy, joined Wi-Fi,
and registered, but **never uploaded an image** (`imageCount` stuck at 0).
Serial showed the capture succeeding (real ~40 KB JPEG) then
`[HTTP] body write failed at 28937/40104 bytes`. The
"Bench OTA download stalls on Windows" troubleshooting entry explicitly
said image **uploads** were _unaffected_ by the Docker Desktop Windows
port-forwarder — so that entry was initially dismissed as unrelated, and
time was spent chasing the camera/firmware instead.

**Why it happened.** The forwarder stalls **any** bulk TCP stream to/from a
slow remote Wi-Fi client after ~one receive-window — in _both_ directions.
The original entry's "uploads unaffected" line was an untested assumption
(the OTA bench only exercised the download direction). Reproduction from the
host can't catch it: host→own-LAN-IP short-circuits via loopback and never
hits the forwarder's slow-remote-client path, so a host `curl` of a 164 KB
image succeeds while the ESP's 40 KB upload stalls.

**How to avoid it next time.** (1) Don't write "X is unaffected" in a
troubleshooting entry unless X was actually tested — an untested negative
claim actively misleads. (2) On Windows, the fix for **all** ESP↔stack bulk
transfers is **WSL2 mirrored networking** (`networkingMode=mirrored` in
`~/.wslconfig`), not per-path native proxies — and after switching modes you
**must** `docker compose down && up` (resumed containers keep stale port
proxies that break `localhost:8000`/`:8002` entirely). Full symptom + fix:
[troubleshooting.md → "Bulk ESP↔stack transfers stall on Windows + Docker Desktop"](../troubleshooting.md).

### Surviving `setup()` is not proof of a healthy OTA image — mark-valid gated on first server contact (#148 Phase 3)

**What happened.** The #26 OTA rollback gate validated a freshly-flashed slot
by **surviving `setup()`** (`esp_ota_mark_app_valid_cancel_rollback()` at
end-of-`setup()`), and the faulty-boot counter only counts panic/WDT/brownout
reboots. So an OTA image that boots clean, completes `setup()`, but can **never
reach the server** — broken TLS root bundle, malformed heartbeat, a Wi-Fi join
bug that associates but never routes — validated itself and was **never rolled
back**. It ran mute (or, once the Phase 3 liveness watchdog landed, rebooted
every ~2 h via `ESP_RST_SW`, which the counter ignores by design). The original
gate proved "the boot path doesn't crash," not "this image actually works."

**Why it happened.** "Healthy" was modelled as "didn't panic during setup,"
which is necessary but not sufficient — a mute image clears that bar. The
faulty-reset gate (correctly) excludes clean reboots to avoid false rollbacks on
transient WiFi outages (ADR-008 invariant #1), but that same exclusion means a
clean-booting-but-mute image produces no faulty resets and so never accumulates
toward rollback.

**How to avoid it next time.** #148 Phase 3 redefines validation as **first
successful server contact** (2xx heartbeat/upload), not surviving `setup()`. An
`ota/unproven` NVS flag — set **only** by the OTA writer before booting a new
slot — gates a second rollback trigger (`nc_boots`): an unproven slot that never
phones home across `HF_OTA_MAX_NOCONTACT_BOOTS` boots reverts. The flag makes it
**safe by construction**: a proven/factory slot is `unproven = 0` and immune, so
a multi-hour outage never rolls back good firmware. Logic is pure + native-tested
in [`lib/ota_rollback`](../../ESP32-CAM/lib/ota_rollback/ota_rollback.h)
(`test_native_ota_rollback`). Lesson: a self-validation signal for a remote
auto-rollback system must assert the thing the system exists to deliver
(reaching the server), not a cheap proxy (not crashing); and gate any
destructive recovery on a flag that only the relevant actor can set, so the
recovery can't fire on the innocent majority. Full design: ADR-008's
mark-valid-on-first-contact addendum.

### Modules went silently offline within ~1 h of restart — async WiFi reconnect + unconditional heartbeat-timer advance (#143, #149)

**What happened.** During the #143 investigation, two field modules
(`b0696ef23a08`, `680183ca4b70`) repeatedly went offline within ~1 h of a
manual restart and stayed silent for hours. The dashboard marks a module
offline after 2 h with no liveness signal, while the firmware heartbeats
hourly — so "last seen 4–5 h ago" meant the hourly heartbeat had **stopped**,
i.e. the module was alive-but-disconnected (a "WiFi zombie": CPU fine,
feeding the WDT, but offline), not waiting for the daily photo. Two `loop()`
gaps caused it: (1) WiFi recovery relied **entirely** on the async path
(`onWifiEvent` → `WiFi.reconnect()`), which can stall under weak RSSI / AP
rotation with nothing to reboot the module until the 24 h daily reboot; and
(2) `loop()` stamped `lastHeartbeatMs = millis()` **unconditionally** after
`sendHeartbeat()`, which returns early without sending when WiFi is down, so
a single bad moment cost a full hour of silence before the next attempt.

**Why it happened.** The reliability doc
([`esp-reliability.md`](../06-runtime-view/esp-reliability.md)) described a
loop-side `reconnectWifi()` that rebooted after ~1 min of failed reconnects
— but that function was only ever **declared** in `esp_init.h`, never defined
or called (a doc that documented intent, not code: exactly the "never trust
commit messages/docs over code" trap). The real recovery was async-only.
(#149 removed the dead declaration so the next person who greps it isn't
misled by the doc correction.) And the heartbeat timer
advanced regardless of outcome because the success/skip/fail distinction was
never modelled — the branch only knew "we called it."

**How to avoid it next time.** #149 added `hf::WifiHealthMonitor` (reboot via
`ESP.restart()` after WiFi is down > 10 min — `ESP_RST_SW`, so it does not
trip the OTA rollback counter) and `hf::HeartbeatScheduler` (5-min retry
backoff on a failed/skipped ping instead of a full hour), both pure and
pinned by `test_native_loop_health`. Lesson: any "self-healing on failure X"
claim in the firmware must be backed by code in `loop()` **and** a native
test that injects the failure and asserts the recovery fires at the
threshold — an aspirational doc paragraph is worse than none, because it
stops people looking. Related gap found while here and **fixed in the same
PR**: `logbufNoteWifiReconnect()` was defined but never called, so the
`wifi_reconnects` telemetry read 0 in the field — now wired into
`onWifiEvent`'s `STA_DISCONNECTED` branch so the reconnect count is a real
signal (the first diagnostics slice of #148; the rest of #148's heap-leak /
silent-hang root-cause work remains open).

### A client-side privacy transform protects nothing (#145, ADR-020)

**What happened.** Module GPS coordinates were "fuzzed" by ~1 km before
plotting on the map — but the fuzzing (`fuzzLocation` in
[`homepage/src/components/MapView.tsx`](../../homepage/src/components/MapView.tsx))
ran **in the browser**, so the backend still shipped the **exact**
coordinates over the wire (`GET /api/modules`), visible to anyone in
DevTools or the raw JSON. Worse, the offset was a pure function of
`moduleId` with no secret and the algorithm shipped in the public JS
bundle, so even the displayed pin was trivially reversible to the true
point. After #142 made reads public, this meant precise nest locations
were readable by anyone with no credential.

**Why it happened.** "We fuzz the location on the map" reads as a privacy
control, but the map is the _last_ consumer — the data is already public
by the time the browser rounds it. A privacy transform on the client is
cosmetic by construction: the client receives the secret (here, the exact
coordinate) before it can hide it.

**How to avoid it next time.** Enforce data-minimization at or before the
**trust boundary**, never after it. If a value must not reach a caller,
the server must not send it — round/redact server-side (ideally
round-on-write so it is never persisted either), and treat any client-side
"masking" as presentation only. The fix generalizes coordinates at three
layers (firmware, duckdb round-on-write, backend response boundary) so the
exact fix is never served or stored — see
[ADR-020](../09-architecture-decisions/adr-020-coordinate-generalization.md).

### Merging firmware source is not a release — the SEQUENCE bump is the release (#150, #132)

**What happened.** PR #150 merged the noon-capture firmware source to
`main` but left `ESP32-CAM/VERSION=carpenter` / `ESP32-CAM/SEQUENCE=4` —
identical version identifiers to the already-deployed release. The
on-device OTA comparator
([`shouldOtaUpdate`](../../ESP32-CAM/lib/ota_version/ota_version.h)) only
flashes when the published manifest's `sequence` is **strictly greater**
than the running one, so **every field module silently ignored the
merge**: the fix sat on `main`, looked shipped, and reached zero
modules. A colleague had to cut a real release (`woolcarder` / sequence
5, commit `39d2faa`) — bump both files, rebuild, republish — before the
fleet pulled it. Per that release commit, **#132 was an earlier instance
of the same class** (a rebuilt same-sequence binary that silently drifts
from the deployed one).

**Why it happened.** "Merge to `main`" is the release ritual for the web
services, so it reads as done — but firmware has a second, manual gate:
the artifacts are gitignored and served from a **rebuilt frontend
image**, and the comparator keys on `SEQUENCE`, not on the source being
present. Nothing fails loudly — CI is green, the diff is merged, and the
only signal that the fleet didn't update is the dashboard **Firmware**
pill never advancing, which nobody watches by default. Bumping `VERSION`
alone has the same trap: the label differs but `sequence` doesn't, so
the comparator still refuses.

**How to avoid it next time.** Treat a firmware change as **unshipped
until a `prod-<codename>` tag exists**. Follow the runbook at
[`docs/07-deployment-view/firmware-release.md`](../07-deployment-view/firmware-release.md):
bump **both** `VERSION` and `SEQUENCE`, run `build.sh`, republish the
frontend image, commit, and tag. After publishing, verify
`curl https://highfive.schutera.com/firmware.json` shows the new
`sequence` and that a module's `latestHeartbeat.fwVersion` flips within a
daily-reboot cycle. The one-line invariant: **the `SEQUENCE` integer
must increment for a release to reach the field; if it didn't change,
nothing shipped.**

### Reusing a firmware codename strands every module still on it — `digger`→`squash` (#149)

**What happened.** The #149 silent-offline `loop_health` watchdog landed
on `main` as `ESP32-CAM/VERSION=digger` / `SEQUENCE=7` — but
`build.sh` was never run, so it sat unpublished (the
"[merging is not a release](#merging-firmware-source-is-not-a-release--the-sequence-bump-is-the-release-150-132)"
trap, recurring). While cutting the real release we caught a second,
subtler bug: **`digger` was already a live field codename** — an early
web-installer build (`sequence 2`); module `brave-kiwi-gans` was still
reporting `fwVersion=digger` in its heartbeats. The comparator
([`shouldOtaUpdate`](../../ESP32-CAM/lib/ota_version/ota_version.h))
requires `manifest.version != my_version`, so a `digger`/seq7 manifest
would have **skipped `brave-kiwi-gans` outright** — the sequence jump
(2→7) never even gets evaluated because the equal-version check
short-circuits first — stranding it on the old, buggy build forever. We
renamed the codename to `squash` (sequence unchanged at 7) and published
`squash`/seq7; `squash` differs from `woolcarder`, `digger`, and every
prior codename, **and** seq7 exceeds every published field sequence
(`woolcarder`/5 being the highest), so both AND-conditions hold and all
field modules OTA forward. The rename alone is necessary but not
sufficient — a hypothetical straggler already at seq≥7 would still need
the sequence gate to pass.

**Why it happened.** Bee-name codenames _look_ like throwaway labels —
the docs called the value "just a human label, must differ from the
deployed one." But the deployed release (`woolcarder`/seq5) is not the
only firmware alive in the field; a straggler that never rebooted can
sit on a much older codename. The namespace is also routinely
reused/overloaded — `digger` was simultaneously an early **firmware**
codename (seq2) and a **deploy tag** (`prod-digger`, the #147 merge) —
which makes "is this name free?" non-obvious and easy to get wrong.

**How to avoid it next time.** Treat the **codename like the sequence: a
forward-only identifier, never reused.** Before picking one, cross-check
both namespaces — `git log --oneline -- ESP32-CAM/VERSION` (firmware
codenames) and `git tag -l 'prod-*'` (deploy tags). The
[firmware-release runbook](../07-deployment-view/firmware-release.md#release-checklist)
step 1 and its [comparator note](../07-deployment-view/firmware-release.md#how-a-module-decides-to-flash)
now spell out that `version != my_version` is a hard AND condition and
that "differ" means differ from every codename still alive in the field,
not just the last release.

### `production` branch drifted from the deployed services (undocumented deploy source)

**What happened.** While auditing the OTA-release docs, `origin/production`
— the branch
[`production-deployment.md`](../07-deployment-view/production-deployment.md)
names as the prod services source — was found sitting far behind `main`
with a divergent history, while the **live** services clearly run
`main`-only code: e.g. the #142 admin-session endpoints
(`POST /api/admin/login`) respond in production, and that commit is on
`main` but not on `production`. So the documented deploy source does not
match what is actually deployed.

**Why it happened.** Two deploy tracks share the repo — firmware OTA (cut
on `main` + `prod-*` tags) and the Docker services (documented as
deployed from `production`). The services track was evidently re-pointed
at `main` (or deployed ad hoc) without updating the `production` branch
or the doc, so the branch became a stale artifact that still reads as
authoritative.

**How to avoid it next time.** Pick and document one services deploy
source. If services now deploy from `main`, update
[`production-deployment.md`](../07-deployment-view/production-deployment.md)
and retire the `production` branch; if `production` is still intended,
fast-forward it on every services deploy. Until reconciled, do not trust
the `production` branch as a picture of prod. Firmware OTA is unaffected
(it lives on `main` + `prod-*` tags) — see
[`firmware-release.md` → Git: branch & tag model](../07-deployment-view/firmware-release.md#git-branch--tag-model).

### Production API key shipped in the public JS bundle; the `/admin` gate authenticated nothing (issue #142)

**What happened.** The homepage read `VITE_API_KEY` and Vite inlined the
**production** `HIGHFIVE_API_KEY` into the shipped `assets/api-*.js` as a string
literal — recoverable by anyone from `https://highfive.schutera.com`. With it, an
unauthenticated third party could read every module (incl. GPS) and image **and**
call the admin/delete routes (deletes used the same key). Separately, the `/admin`
`LoginGate` did `fetch('/api/health', { headers: { 'X-API-Key': password } })` and
treated any `res.ok` as success — but `/api/health` is public, so **any string**
logged in, and the real calls used the baked key, not the typed password. The gate
was cosmetic.

**Why it happened.** A single-page app cannot hold a secret: anything bundled
ships to every visitor. The original design treated the frontend↔backend boundary
as if the browser could keep `HIGHFIVE_API_KEY` private (ADR-003's "one secret,
two headers" assumed a trusted holder). It can't. And the login gate was wired to
the one endpoint that ignores the credential, so it never actually validated.

**How to avoid it next time.** Never put a secret behind `import.meta.env.VITE_*`
(see the new [CLAUDE.md critical rule](../../CLAUDE.md) and
[ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md)).
Privileged browser access means a real login that the **server** validates,
yielding an `HttpOnly` cookie — the secret never crosses to the client. Gate a
login form against an endpoint that actually checks the credential, never a public
liveness probe. When you make reads public to remove a bundle secret, treat the
read data as genuinely public and shape it accordingly — here, module GPS at ~11 m
precision is now openly readable; **coordinate generalisation for unauthenticated
callers is a tracked follow-up** ([#145](https://github.com/schutera/highfive/issues/145), filed from #142).

### Daily noon image came back near-black while a restart always produced a good frame — bench A/B ruled out the "obvious" firmware cause (#143)

**What happened.** A field module (`b0696ef23a08` / _calm-raisin-baer_) uploaded **near-black noon frames** from ~2026-06-01 onward (mean luminance ~10–15/255, no scene structure even when amplified), yet a simple **power-cycle restart always produced a perfectly-exposed image** — and with _less_ light than midday (today's pair: `12:00` black at 8.3 KB, `18:01` restart good at 19 KB). The leading hypothesis in #143 was that the scheduled noon capture skips the 3-frame auto-exposure **warm-up** that only `setup()` runs, so the noon shot is a single "cold" grab. We reproduced both paths on a bench module (`hive-02`, COM9) pointed at a local stack and compared warm vs cold frames directly.

**Why it happened (what the bench actually showed).** On healthy hardware the warm-up hypothesis is **false**: a cold single `esp_camera_fb_get()` with **zero** warm-up, at 20 s / 40 s / 80 s / 160 s idle, exposed **identically** to a warmed-up grab — same scene, same ~11–12 KB JPEG, never black. Forcing the firmware into the **VGA / internal-DRAM fallback path** (the exact config the field module runs, because it reports `PSRAM not found`) **also** exposed fine. So neither of the two firmware variables that differ between restart and noon reproduces the black frame. The tell: the field module's `PSRAM not found` is itself a **hardware-fault symptom** (marginal PSRAM/power), corroborated by its boot log showing `reset_reason=7` (watchdog) + ROM-level `flash read err`, and by the _variable_ black severity (June noon frames ranged 8–20 KB, only the worst were hard-black). A healthy bench board cannot emulate a flaky-PSRAM board by flipping a compile-time code path, which is exactly why it would not reproduce — so the root cause is most likely **board-specific marginal hardware**, not firmware logic. (This also explains #143's own counterexample: May noon cold-grabs were fine — it's intermittent because it's hardware.)

**How to avoid it next time.** (1) **Don't ship the "obvious" firmware fix without a bench repro.** #143's candidate fix ("add a warm-up before the noon grab") would have changed nothing — the bench proved the warm-up is not the differentiator. An afternoon on the bench is cheaper than an OTA that fixes nothing. (2) **Mitigation regardless of root cause:** the one path observed to _always_ work is a restart, so the scheduled noon capture now routes through `primeCameraLikeBoot()` ([`ESP32-CAM/ESP32-CAM.ino`](../../ESP32-CAM/ESP32-CAM.ino)) — a PWDN power-cycle + reinit + 3-frame warm-up, the same cold-start the boot path runs. Crucially the reinit goes through the **non-aborting** `recoverCameraSoft()` (not the boot path's `abort()`-on-failure `initEspCamera`): a capture-quality mitigation must never introduce a steady-state panic — on the marginal hardware it targets, an `abort()` at noon would risk a daily panic→reboot→(after 3) firmware rollback. On a reinit failure it skips that day's capture and retries next loop. It is **explicitly unvalidated** (we could not reproduce the failure on healthy hardware, so we could not confirm the fix); validating it needs the actual field board (or any `PSRAM not found` board) on the bench running the same A/B. (3) **Treat `PSRAM not found` on an ESP32-CAM as a hardware-health red flag**, not a benign "image quality will be reduced" fallback — pair it with the `reset_reason` / breadcrumb telemetry to spot a marginal board. (4) A _separate_ "modules show offline" symptom surfaced in the same session (old `mason` firmware's geolocation-TLS waste + two `loop()` hardening gaps: no WiFi-health reboot fallback, and the hourly heartbeat advancing its timer even when the ping is skipped) — filed as issue #149, not tracked further here.

### Pinned `GTS Root R1` for geolocation; Google rotated `googleapis.com` to `GTS Root R4` — every module silently stuck at "Standort ausstehend"

**What happened.** A field module (`ready-peach-baer`) was online and heartbeating hourly but never left the `(0,0)` map sentinel — the dashboard showed "Standort ausstehend" (location pending) indefinitely. Not one of 2000+ `duckdb-service` log lines carried a `[heartbeat] patched … lat/lng` recovery. Investigation showed the older "real" module's coordinates were a suspiciously round `48.200000, 11.770000` (manually set), i.e. Wi-Fi geolocation had effectively **never** worked. Root cause: [`ESP32-CAM/esp_init.cpp`'s `attemptGeolocation`](../../ESP32-CAM/esp_init.cpp) pins the Google root via `setCACert`, and `www.googleapis.com` had rotated its served chain from `…->WR2->GTS Root R1` (RSA) to `…->WE2->GTS Root R4` (ECC). The firmware trusted only R1, so every geolocation TLS handshake failed peer verification → negative `httpResponseCode` → `(0,0)`. The key was fine (verified HTTP 200 from the prod box); image upload + heartbeat kept working because those hit `highfive.schutera.com` (a different, ISRG-rooted endpoint).

**Why it happened.** Single-root CA pinning has no margin for the CA serving a _different_ valid root. A public CA rotating between its RSA and ECC roots is a routine, announced-but-easy-to-miss event; pinning exactly one of a CA's sibling roots converts that routine rotation into a silent fleet-wide outage. The failure was invisible because the geolocation path is best-effort by design (bounded retry → `(0,0)` sentinel → heartbeat-side recovery, see "First-boot geolocation race" below), so a _permanent_ failure looks identical to a _transient_ one — no alert, no error surfaced to the operator, just a map pin that never resolves.

**How to avoid it next time.** (1) Pin a **bundle of all of a CA's current roots**, not one — `setCACert` accepts concatenated PEM blocks and mbedTLS treats each as an independent anchor. The geolocation call now pins `hf::tls::kGoogleApisCaBundlePem` (GTS Root R1 + R4); see [ADR-010](../09-architecture-decisions/adr-010-esp-firmware-tls-trust-model.md). (2) When a "best-effort with sentinel fallback" path can fail _permanently_, give it a visible signal — a counter or a one-line server log when a module re-registers at `(0,0)` for the Nth consecutive boot would have surfaced this in a day instead of being noticed by eye. (3) Diagnostic shortcut for "module online but no location": from the server, `curl -sX POST "https://www.googleapis.com/geolocation/v1/geolocate?key=$(cat ESP32-CAM/GEO_API_KEY)" -d '{"considerIp":true}'` isolates key/quota from the firmware's pinned-TLS path, and `openssl s_client -connect www.googleapis.com:443` shows which root the chain currently uses. Fixed in firmware `longhorn` / OTA sequence 3.

### ESP config-form complexity creep — re-simplified to the `59523d3` Wi-Fi-only shape

**What happened.** The captive portal that a field operator uses to
onboard an ESP32-CAM started as a Wi-Fi-credentials-only form (commit
`59523d3`, 2026-03-30, "streamline setup flow"). Over the following
months it re-accreted every configurable knob the firmware has: a
free-text module name, both server URLs (each split into base / port /
endpoint since #79, [ADR-010](../09-architecture-decisions/adr-010-esp-firmware-tls-trust-model.md)),
the four camera settings, and — when #40 moved factory reset off the
GPIO0 strap pin — a "Factory reset (advanced)" disclosure with its own
`/factory_reset` route. The complexity crept back via `ad9ee17`; the
factory-reset disclosure landed in `8c1be9c`. We re-simplified back to
the `59523d3` Wi-Fi-only shape ([ADR-018](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md)):
module name is derived from the MAC
(`ESP32-CAM/esp_init.cpp`'s `generateModuleName`), server URLs are
baked in at build time behind `DEV_SERVER_HOST` (mirroring `GEO_API_KEY`),
camera settings come from `firmware_defaults.h`, and reconfigure is by
re-flash (the web-installer flash now does a full chip erase via
`eraseAll: true` in `homepage/src/components/setup/flashEsp.ts`'s
`flashEsp`, so a re-flash wipes config and reopens the Wi-Fi-only setup
page — the `/factory_reset` route is gone).

**Why it happened.** Each individual addition looked locally reasonable
("operators sometimes want to retarget a module", "let's expose the
camera flip", "we need an in-field reset now that IO0 is unusable"). No
single PR was wrong on its own terms, but the cumulative effect was a
form that asked the operator to make six decisions they should never
make in the field — three of which (the form-vs-production fallback
asymmetry on camera settings, name typos, URL retyping) actively caused
bugs. The form had no recorded "this is deliberately minimal" guard, so
the default reviewer instinct was "one more field is fine".

**How to avoid it next time.** Keep advanced knobs — server URLs,
camera settings, module name, factory reset — **off** the operator-
facing captive portal. Default them in firmware (`firmware_defaults.h`
production fallbacks, MAC-derived name) or behind a build-time file
(`DEV_SERVER_HOST`, the same pattern `GEO_API_KEY` uses), and make
reconfigure a re-flash rather than a form field. ADR-018 is the
recorded "deliberately minimal" guard: when a PR proposes adding a
field to the captive portal, it has to argue past ADR-018 first. The
operator types exactly two values, SSID and password, and nothing else.

### Admin "failed to load images": stale `IMAGE_SERVICE_URL` after a no-`--update-env` PM2 restart, masking an unbounded image-list query that tripped a 5s timeout

**What happened.** The admin page (`/admin`) showed "Failed to load
images. Is the image service running?" while the image-service PM2
process was healthy and serving. Two independent faults stacked:

1. The backend (`highfive-api`) had been restarted at some point
   _without_ `--update-env`, so PM2 reused the environment captured at
   first launch — from before `IMAGE_SERVICE_URL` was added to
   `ecosystem.config.js`. `pm2 env <id>` showed `DUCKDB_SERVICE_URL`
   but no `IMAGE_SERVICE_URL`, so the backend fell back to its dev
   default `http://image-service:4444` (a **Docker** service name that
   does not resolve on the PM2 host). Every `/api/images` 502'd.
2. After fixing the env, images _still_ failed: `duckdb-service`'s
   `GET /image_uploads` ran `SELECT … ORDER BY uploaded_at DESC` with
   **no `LIMIT`**, returning all ~15k rows in ~12s against an 8 GB DB
   file. `image-service`'s proxy used a **5-second** read timeout, so
   the call timed out → 500 → 502 at the backend → the same UI error.

**Why it happened.** (1) `pm2 restart`/`reload` does _not_ re-read the
ecosystem `env` block unless you pass `--update-env`; a config edit is
invisible to a running process until then, so the file looked correct
while the live env was stale. (2) The list query was written when the
table was small; an unbounded `ORDER BY` over a bloated table crossed
the fixed proxy timeout as data grew. The 8 GB file (mostly churn from
high-frequency tables, not the 15k image rows) made even a 15k-row
sort slow.

**How to avoid it next time.** After editing `ecosystem.config.js`
env, deploy with `pm2 reload ecosystem.config.js --update-env` and
verify with `pm2 env <id>` — never trust the file alone. Never proxy
an unbounded list across a fixed network timeout: paginate at the
source (`limit`/`offset`, newest-first) so latency is bounded by page
size, not table size, and pick a timeout with real headroom over the
worst-case _bounded_ page (here 15s vs a ~50ms page). When a symptom
points at a service ("is X running?"), confirm the _path_ end-to-end
(`pm2 env`, `getent hosts <name>`, time the slow hop with `curl -w
%{time_total}`) before concluding the service is down — here it never
was. The fix is `duckdb-service/routes/modules.py`'s
`list_image_uploads` (now `LIMIT`/`OFFSET` + `total`), the bumped
timeout in `image-service/app.py`'s `list_images`, and the
`feat/admin-image-pagination` "Load more" UI in
`homepage/src/pages/AdminPage.tsx`.

### `image_uploads.uploaded_at` stamped in container-local time, new reader assumed UTC (ADR-015 review)

**What happened.** When the `activity_timeseries` endpoint landed
(ADR-015, weather-correlation chart), the writer
`duckdb-service/routes/modules.py`'s `record_image` was still
stamping `uploaded_at` with naive-local `datetime.now()`, while the
new reader computed its window upper bound from
`datetime.now(timezone.utc).replace(tzinfo=None)`. The two only
agree because the `python:3.x-slim` base image defaults to UTC; a
prod-ops `TZ=Europe/Berlin` override on the container would have
written rows 1-2 hours past the reader's window upper bound, making
the most recent uploads silently invisible to the chart.

**Why it happened.** The reader was written timezone-aware (correct);
the existing writer pre-dated the reader and was timezone-naive
(formerly correct, because the reader was day-granularity and the
schema's `DEFAULT CURRENT_TIMESTAMP` was the dominant timestamp
source). Adding a new consumer with a different timezone discipline
exposed the latent inconsistency. The schema's
`DEFAULT CURRENT_TIMESTAMP` on `image_uploads.uploaded_at`
(`duckdb-service/db/schema.py`'s `_MODULE_CONFIGS_DDL` neighbour
block) carries the same naive-local risk and is the next thing to
audit if a TZ-flipped container is ever staged.

**How to avoid it next time.** Pick UTC at the writer for any
column that crosses service boundaries or feeds an aggregation.
The fix in `record_image` is two lines (`datetime.now(timezone.utc)`
instead of `datetime.now()`). When adding a new timezone-aware
reader against existing data, grep the writers for `datetime.now()`
(no `tz` arg) first; if any survive, fix them in the same PR.

### `date_trunc('day', ts)` returns DATE not TIMESTAMP — daily aggregation silently rendered all-zeros (PR-120 manual-test discovery)

**What happened.** The `activity_timeseries` endpoint (ADR-015) joins
DuckDB-aggregated bucket counts with a Python-side dense-fill cursor.
On the hourly path it worked; on the daily path **every bucket
silently rendered `count: 0` regardless of how many uploads existed**.
Hourly returned 6 non-zero buckets, daily returned 0 against the
exact same `image_uploads` rows — caught by eyeballing a 30-day view
during the PR-120 manual walk after the unit suite was 122/122 green.

**Why it happened.** `date_trunc('hour', ts)` returns a TIMESTAMP
(DuckDB hands it back to Python as `datetime.datetime`); but
`date_trunc('day', ts)` returns a DATE (handed back as
`datetime.date`). The route's normalisation branched on
`isinstance(bucket, datetime)` and fell through to `str(bucket)` for
the date case, producing keys like `"2026-05-20"` that never matched
the dense-fill cursor's `"2026-05-20T00:00:00"` ISO keys. Every
daily lookup missed and the gap-fill loop emitted zero.

The unit tests passed because they only asserted the daily bucket
_count_ (`len(body["buckets"]) == 7`), which still hits 7 with all
zeros. Wire shape was tested; aggregation _behaviour_ on the daily
path was not. The hourly path had a behaviour test — daily didn't,
because writing the same test for daily felt redundant. It wasn't.

**How to avoid it next time.** When two SQL aggregations share a
single Python normalisation path, write one behaviour test per
aggregation that asserts data lands in the expected bucket — not
just that the bucket count matches. "Same shape" is not "same
behaviour" when the DB type differs by argument. For DuckDB
specifically, prefer an explicit `::TIMESTAMP` cast on `date_trunc`
results when the consumer expects a uniform Python type — the cast
is a no-op on the hourly path and a correctness fix on the daily
path. The fix in `routes/modules.py`'s `activity_timeseries` is one
SQL token; the regression pin is
`tests/test_module_endpoints.py`'s
`test_activity_timeseries_daily_groups_uploads_by_day`. CLAUDE.md
rule #3 ("component tests must mount with a realistic fixture, not
a mock object the test author guessed at") applies one layer
deeper than originally framed: aggregation tests must seed real
data and assert real output, not just the response envelope.

### Windows host parity: build.sh tripped on three path assumptions and a unit test depended on a jsdom polyfill that doesn't exist (PR 2 / issues #99, #100)

**What happened.** A contributor on Windows 11 + Git Bash + Node 22 +
arduino-cli 1.x hit two unrelated parity gaps in the same week.
[`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh) failed three different
ways before producing artifacts: the hardcoded `$HOME/.arduino15`
arduino-cli data dir was wrong (Windows uses `%LOCALAPPDATA%/Arduino15`),
the hardcoded `esptool.py` invocation was wrong (Windows arduino-cli
prefers `esptool.exe` because the shipped `esptool.py` crashes against
a newer pip-installed `esptool` module), and `python3` was wrong
(Windows ships an MS Store stub at `python3.exe` that is on PATH so
`command -v python3` finds it, but it exits non-zero with "Python wurde
nicht gefunden" when invoked). Separately,
[`homepage/src/__tests__/flashEsp.test.ts`](../../homepage/src/__tests__/flashEsp.test.ts)
reported `3 failed | 76 passed`: the validator at
[`flashEsp.ts`'s `assertFirmwareResponse`](../../homepage/src/components/setup/flashEsp.ts)
called `blob.slice(0, 1).arrayBuffer()`, and jsdom 25.0.1 (pinned via
[`package-lock.json`](../../package-lock.json)) defines `slice()` on
its `Blob` polyfill but **no `arrayBuffer()` anywhere on the Blob
prototype** — `Object.getOwnPropertyNames(Blob.prototype)` returns
just `['constructor', 'slice', 'size', 'type']`. Vitest's jsdom env
shadows `globalThis.Blob`, so the entire blob round-trip path throws
under tests. The build.sh failures don't reproduce in CI because
GitHub Actions Ubuntu runners have a `python3` that resolves to a
real interpreter (no MS Store stub) and an arduino-cli that installs
under `~/.arduino15` — both trip-wires were latent there. The
`flashEsp.test.ts` failures don't reproduce in CI either, but CI runs
the same jsdom 25.0.1 pin on the same Node 22 — so the discriminator
must be either OS-level (Linux's Node-vs-jsdom Blob class shadowing
order differs from Windows) or job-shape (the homepage unit job doesn't
exercise the failing assertions). This was NOT pinned down before
shipping the refactor; the next contributor who edits these tests
should `gh run download` the homepage-unit log from an Ubuntu run and
confirm whether the 6 `assertFirmwareResponse` cases (PR #106's count
at the time of this incident — PR #106 itself later added a 7th case
for the `resp.clone()` invariant in `4891e6e`, and PR A added three
more for the merge_bin layout for a current total of 10; see the
entry just below) actually ran and passed there, or whether they
were skipped silently. Logging the gap because the refactor sidesteps
the question — but the lesson is incomplete until somebody answers
it.

**Why it happened.** Both gaps are the same anti-pattern: an implicit
"the dev box looks like the maintainer's box" assumption. The shell
script assumed a POSIX-shaped install layout because that's what the
author ran. The unit test reached for a Web API (`Blob.arrayBuffer`)
that's documented in MDN, looked plausible in the test runner, and was
silently absent from the polyfill the runner actually uses. Neither
gap was caught by CI because CI runs on Linux only, where both
assumptions happen to hold.

**How to avoid it next time.**

1. **Probe, don't assume.** Whenever a shell script reaches outside
   the repo (env vars, system paths, executables), probe with
   `command -v` and `${VAR:-}` and `for candidate in …`. The cost of
   one extra branch beats one extra hour of a contributor unwinding
   inline workarounds — and the workarounds always rot back. Validate
   probed executables by actually invoking them (`--version`) before
   committing; PATH-presence is not interpreter-existence on Windows.
2. **When a unit test depends on a Web API method, inspect the
   polyfill's prototype, not MDN.** `Object.getOwnPropertyNames(SomeClass.prototype)`
   tells the truth about what jsdom actually implements; MDN tells
   the truth about what browsers implement. The two diverge silently.
   Prefer reading the response body via `Response.arrayBuffer()` (Node
   native, unaffected by jsdom polyfills) over the `Blob` round-trip
   when feasible.
3. **"CI passes on Linux" does not entail "this works on Windows + Git Bash".**
   The mandatory senior-reviewer subagent gate is where the "what
   platforms has this been exercised on?" question lands. Add a
   Windows runner to CI if the cost of running parity locally is high
   enough; treat it as a follow-up, not a bundle into the parity fix
   itself.

### Step 2 wizard validator rejected the only firmware.bin the build produces (PR A / issue #107)

**What happened.** The wizard's pre-flash validator at
[`flashEsp.ts`'s `assertFirmwareResponse`](../../homepage/src/components/setup/flashEsp.ts)
gated on `firmware.bin[0] === 0xE9` and rejected every artefact
produced by [`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh):
`esptool merge_bin` emits a blob whose first 0x1000 bytes are 0xFF
flash-erase padding, with the bootloader (the byte that actually is
0xE9) at offset 0x1000. The byte-level evidence from the failing
hardware smoke (captured against a freshly built firmware.bin, PR
#106 T7):

```
firmware.bin size:            1226832
firmware.bin[0x0000]:         0xFF   ← flash-erase pad (rejected by old validator)
firmware.bin[0x1000]:         0xE9   ← bootloader magic (the one the new validator reads)
firmware.bin[0x8000-0x8001]:  0xAA 0x50   ← partition-table magic
firmware.bin[0xe000]:         0x01
firmware.bin[0x10000]:        0xE9   ← app magic

firmware.app.bin size:        1161296
firmware.app.bin[0x0000]:     0xE9   ← raw app, no padding (the byte-0=0xE9 accept path)
```

The bug was invisible in CI because every test fixture in
[`flashEsp.test.ts`](../../homepage/src/__tests__/flashEsp.test.ts)
started with 0xE9 by construction; it surfaced on the first
Windows-host hardware smoke (T7 of PR #106's test plan), where Step
2 reported "Flashen fehlgeschlagen" against a freshly built
firmware.bin.

**Why it happened.** The validator was added in PR #104 alongside a
confidently-worded docstring that asserted "the merged single-blob
produced by esptool.py merge_bin all begin with 0xE9." Nobody on the
review chain held the actual bytes against the claim — the reviewer
trusted the docstring; the docstring trusted the author's mental
model; the author's mental model came from app-only OTA payloads
(which DO start with 0xE9) and over-generalised to the merged blob.
The first real merged-blob bytes touched the validator under
hardware test, where the false claim broke immediately.

**How to avoid it next time.**

1. **For any byte-gate on a binary artefact, the test fixture must
   contain bytes from a real build of that artefact at least once.**
   Synthetic 4-byte fixtures starting with the expected magic only
   test the validator's logic against itself. If a real-bytes fixture
   would couple the unit test to the build pipeline (it would here —
   `firmware.bin` is built by `build.sh`, not by `vitest`), capture
   the wire-shape evidence in the lessons-learned entry alongside the
   validator — either as a hex dump of the first 0x2000 bytes, or as
   the annotated key-offset summary used above. The point is "ground
   truth from a real build", not the specific dump format.
2. **When a docstring asserts a layout fact ("X begins with byte Y"),
   cite the file where the `#define` actually lives, not a transitive
   `#include` consumer.** For ESP-IDF 5.x, `ESP_IMAGE_HEADER_MAGIC` is
   defined in `components/bootloader_support/include/esp_app_format.h`;
   `esp_image_format.h` just re-exports it. esptool's `merge_bin`
   source is the authority for the merged-blob layout itself.
   Uncited layout claims are guesses, and the citation forces the
   author to verify before writing.
3. **"CI passes" + "build script succeeds" together do not exercise
   the producer ↔ validator wire shape** unless the test environment
   actually feeds the producer's bytes into the validator. The
   hardware-side T7 smoke is the cheapest moment to catch this gap;
   it must remain a gate, not optional.

### `displayName ?? name` lived in seven docs and eight render sites; six review rounds to extinguish (PR 1 / issues #103, #102, #101)

**What happened.** The "operator-visible module label" rule —
"prefer `displayName` over `name`" — was implemented at eight render
sites in the homepage tree
([DashboardPage](../../homepage/src/pages/DashboardPage.tsx) ×3,
[ModulePanel](../../homepage/src/components/ModulePanel.tsx),
[AdminPage](../../homepage/src/pages/AdminPage.tsx) ×5,
[RenameModuleModal](../../homepage/src/components/RenameModuleModal.tsx),
[Step5Verify](../../homepage/src/components/setup/Step5Verify.tsx))
and described as `displayName ?? name` in seven prose locations
([api-reference.md](../api-reference.md) ×2,
[glossary](../12-glossary/README.md),
[ADR-011](../09-architecture-decisions/adr-011-module-display-name-override.md),
[building-block-view/duckdb-service.md](../05-building-block-view/duckdb-service.md),
[api-contracts.md](../08-crosscutting-concepts/api-contracts.md),
[contracts/src/index.ts](../../contracts/src/index.ts)). PR 1 found a
defense gap (the wire shape permits `displayName: ""`, but `??` only
short-circuits on `null` — so an empty-string override would render
as a blank `<h3>` "ghost row") and went round-by-round closing it.
Round 3 fixed the sort key in `DashboardPage`. Round 4 noticed two
`<h3>` render sites in the same file still used `??`. Round 5
promoted the fix to a shared helper
([`homepage/src/lib/displayLabel.ts`](../../homepage/src/lib/displayLabel.ts))
and swept seven sites in homepage plus six prose citations. Round 6
caught two more prose citations (a backend code comment and a
building-block-view doc) the round-5 sweep had missed by enumerating
six known sites rather than re-grepping.

**Why it happened.** A behavioural rule that's also a prose
contract accretes copies. Every doc that documents the wire shape
restates the rule, every render site implements its own coalesce
inline, and the next behaviour change has to be applied N times.
N grew silently from "a few" to thirteen across this codebase.
Splitting one fix across N rounds is the symptom; the root cause is
that the rule had no canonical home — until round 5 promoted
`displayLabel` to `homepage/src/lib/`, there was no single place to
point at, so every doc and every render site became its own source
of truth.

**How to avoid it next time.**

1. **Make the rule a callable, then point at it.** The structural
   fix that closed this PR was `homepage/src/lib/displayLabel.ts`
   with `Pick<Module, 'name' | 'displayName'>` as its parameter type
   and one `it()` per branch in
   [`displayLabel.test.ts`](../../homepage/src/__tests__/displayLabel.test.ts).
   Every prose citation now points at the helper file instead of
   restating the rule. The next behaviour change is one edit, not
   thirteen.
2. **Use a trip-wire grep to enforce single-source-of-truth.** When
   you promote a rule to a helper, the cost is "every prose copy of
   the old rule is now drift". A one-liner grep
   <!-- prettier-ignore -->
   (`git grep -nE "display_name \?\?|displayName \?\?" -- docs/
   backend/ duckdb-service/ contracts/ image-service/
   homepage/src/`) finds every survivor; folding that grep into
   `make check-citations` (see `scripts/check-doc-citations.sh`)
   turns the round-N senior-review ritual into a CI check that
   catches the drift at commit time. Done in PR 1 as part of the
   round-6 wrap-up.
3. **When sweeping doc citations of a rule you just removed, grep
   first, enumerate second.** PR 1's round-4 commit enumerated six
   doc sites it had updated; rounds 5 and 6 each found one more the
   enumeration missed. Same pattern as PR-II's "Three layers, one
   rule was actually four surfaces" — author confidence that the
   sweep is complete is not a substitute for the grep.

The meta-lesson is the same as the
[Three layers, one rule](#three-layers-one-rule-was-actually-four-surfaces--the-dashboard-side-list-silently-filtered-pending-modules-pr-ii-final-pass-smoke)
entry's, just with a longer tail: a behavioural contract restated in
prose at N sites and enforced inconsistently at N render sites is
not a contract — it is N wishes. Make one of them callable, point
the other (N-1) at it, and add a grep so the rule's structural
position is auditable.

### `updated_at` carried two unrelated semantics; a metadata UPDATE silently corrupted the liveness signal (PR-I round-1 review)

**What happened.** PR I's first cut of the new
`PATCH /modules/<id>/display_name` route in
`duckdb-service/routes/modules.py::set_display_name` set
`display_name = ?, updated_at = NOW()` in the same UPDATE — the kind of
"bump the row's modified timestamp on any write" pattern that looks
harmless until you read the consumer. `backend/src/database.ts::fetchAndAssemble`
folds `updated_at` into
`lastSeenAt = max(last_image_at, updated_at, latestHeartbeat.receivedAt)`,
and `Module.status` is derived from a 2 h window on that value. So
renaming an offline module via the admin UI would have flipped it to
`'online'` on the dashboard for two hours, with no telemetry behind
the signal. The senior-reviewer subagent caught this on round 1
before merge; round 2 dropped the `updated_at` bump and added a
before/after regression test
(`duckdb-service/tests/test_modules.py::test_patch_display_name_does_not_bump_updated_at`).

**Why it happened.** `module_configs.updated_at` carries two
semantically distinct roles that the DDL doesn't separate:

1. **Row-metadata timestamp** — "when was this row last written?"
   This is the obvious read of the column name; any write naturally
   bumps it.
2. **Per-module liveness signal** — folded into `lastSeenAt` by the
   read path, used to derive `Module.status`. Only writes that
   represent the _device_ being heard from (registration UPSERT,
   post-upload aggregate heartbeat) should bump it.

The column comment (in the DDL) names neither role explicitly. The
read-path role lives a service away in TypeScript. An author writing
the new route, looking only at the DDL, has no way to know they're
about to corrupt the liveness signal — and the test suite at the time
had no invariant pinning the "metadata edits do not bump updated_at"
half of the contract.

**How to avoid it next time.**

- **Treat any column whose value is folded into a derived signal in
  another service as a tripwire.** Either rename it to make the read
  role visible (`last_heartbeat_or_upload_at`), split it into two
  columns (one for row metadata, one for liveness), or — at minimum —
  pin an invariant test on every write path that the column isn't
  bumped when the write isn't a liveness event. We added the third
  here but the first or second would be more robust long-term; the
  long-term fix is tracked at
  [issue #97](https://github.com/schutera/highfive/issues/97).
- **When writing a route that UPDATEs a `module_configs` column, read
  `backend/src/database.ts::fetchAndAssemble` first.** Until the
  liveness derivation moves into duckdb-service or becomes an
  explicit view, the contract on `updated_at` lives across a service
  boundary that DDL alone won't show you.
- **The senior-reviewer subagent's "the column's read-path role is
  X" line of inquiry is the one that caught this.** Worth burning a
  review cycle on any PR that adds a write to a column whose name
  doesn't fully describe its read-path semantics.

### Admin rename failed silently on seeded modules — DuckDB FK over-enforcement + stacked rollback (PR B / issue #105)

**What happened.** Operators trying to rename one of the five seeded
modules (`Garten 12` and friends) via the admin UI got "Save failed.
Please try again." Backend logs showed a JSON parse error (`Unexpected
token '<'`) — duckdb-service was returning Flask's HTML 500 page.
Beneath the HTML body, duckdb-service had logged two stacked
exceptions: a `ConstraintException: Violates foreign key constraint
because key "module_id: 000000000002" is still referenced by a foreign
key in a different table`, immediately followed by a
`TransactionException: cannot rollback - no transaction is active`.
Both bugs were live simultaneously; the second masked the first.

**Why it happened.**

1. **DuckDB FK over-enforcement** (the primary bug). DuckDB 1.4.4 (and
   1.5.2, verified during the fix) rejects `UPDATE module_configs SET
display_name = ?` whenever the targeted row's `id` is referenced
   by `nest_data.module_id`, _even though_ the UPDATE doesn't touch
   `id` and would not break referential integrity. The behaviour is a
   conservative reading of the SQL standard's "updates that affect
   referenced rows must be propagated" rule. Seeded modules all carry
   `nest_data` rows so all five were unrenamable out of the box; an
   ESP that registered post-seed with no nests yet would have renamed
   fine — the test suite seeded the latter and missed the former.
2. **Stacked rollback** (the secondary bug). The route used manual
   `con = get_conn() / con.commit() / con.rollback()` instead of the
   project's `write_transaction()` helper. DuckDB defaults to
   autocommit; `con.rollback()` in the exception handler — with no
   active transaction — raised a `TransactionException` whose
   traceback escaped the route's wrapper, so Flask served its
   default HTML 500 page instead of the JSON the backend's parser
   expected.

**The workaround.** The fixes the issue's reporter listed
(`PRAGMA foreign_keys = OFF`, `ALTER TABLE DROP CONSTRAINT`,
INSERT ... ON CONFLICT DO UPDATE) all turned out to be inapplicable
in DuckDB:

- `PRAGMA foreign_keys` is a SQLite pragma. DuckDB returns
  `Catalog Error: unrecognized configuration parameter
"foreign_keys"`.
- `ALTER TABLE nest_data DROP CONSTRAINT ...` raises
  `NotImplementedException: No support for that ALTER TABLE option
yet`.
- `INSERT INTO module_configs ... ON CONFLICT (id) DO UPDATE` hits
  the same FK over-enforcement — DuckDB treats the UPSERT branch as
  a regular UPDATE for FK purposes (even though `add_module`'s
  fresh-row UPSERT works because no `nest_data` rows reference a
  not-yet-inserted module).

The only path through DuckDB's FK over-enforcement is to temporarily
move the referencing child rows out of the way: snapshot
`daily_progress` + `nest_data` rows for this module, delete them in
reverse-FK order, run the UPDATE on the now-unreferenced parent, then
re-insert the children. Bounded blast radius: only the renamed
module's children move (the `WHERE module_id = ?` filter pins it).

**Atomicity caveat (senior-review round 1 finding).** The dance
CANNOT run inside `write_transaction()`'s explicit `BEGIN/COMMIT`.
DuckDB's FK enforcement uses a transaction-snapshot view: even after
DELETing the children in the same transaction, the UPDATE on the
UNIQUE-constrained `display_name` column sees the snapshotted
references and trips the same FK exception that motivated the dance.
The dance therefore runs in autocommit (each DELETE / UPDATE /
INSERT commits individually) and atomicity is provided at the
Python layer via a **compensating-restore** handler in the
exception path: if any phase raises, the handler re-inserts the
snapshotted children before the 500 surfaces. The global `lock` is
held for the whole dance so no concurrent writer races with the
half-deleted state. Pinned by `set_display_name`'s
fault-injection test (`test_set_display_name_restores_children_on_mid_dance_failure`)
and the FK-chain preservation test
(`test_set_display_name_preserves_full_fk_chain_nest_and_progress`).

The PR-B-side correction that surfaced this: `write_transaction`
itself was missing its `BEGIN`, so multi-statement callers got
silent partial-write semantics ("rollback on exception" was a
no-op because DuckDB autocommit had already committed each
statement). The senior-reviewer caught it; the fix adds explicit
`BEGIN/COMMIT` for that helper's 4 OTHER callers (add_module,
record_image, the legacy heartbeat route, add_progress_for_module),
all of which benefit from real atomicity. set_display_name's dance
is the one route that opts out of the helper because of the
DuckDB-snapshot incompatibility. Pinned by
`tests/test_repository.py`'s `test_write_transaction_rolls_back_partial_writes`.

**How to avoid it next time.**

- **Use `write_transaction()` for every duckdb-service route that
  mutates state.** The helper at
  [`duckdb-service/db/repository.py`](../../duckdb-service/db/repository.py)'s
  `write_transaction` now issues an explicit `BEGIN` so multi-
  statement callers get real atomicity. Manual `con.commit() /
con.rollback()` lifecycles are a smell — they bypass the helper's
  safety net and recreate both bugs.
- **The one exception is when an UPDATE on a row with FK references
  has to bypass DuckDB's snapshot-based FK enforcement** (the
  `display_name` rename being the only known case today). Such
  routes use a bespoke autocommit + compensating-restore pattern;
  document it explicitly in the route comment and pin it with a
  fault-injection test, otherwise a future refactor that switches
  back to `write_transaction()` reintroduces the FK-over-enforcement
  symptom.
- **Test fixtures must seed the realistic precondition for the route
  under test, not the minimum that lets the happy path pass.** The
  five seeded modules all carry `nest_data`; any `set_display_name`
  test that doesn't reproduce that shape is exercising a fictional
  schema. The new regression test
  (`test_set_display_name_works_on_module_with_nest_data`) seeds the
  FK reference explicitly. Same lesson the
  `assertFirmwareResponse` byte-0 incident (#107) taught: a
  validator's test fixture must contain bytes / rows from a
  realistic source at least once.
- **When a backend response surfaces "Unexpected token '<' ... is
  not valid JSON", the upstream almost certainly fell back to Flask's
  default HTML 500 page.** That means an exception escaped the
  route's wrapper. Logging the upstream body (not just status) in
  backend error paths makes this grep-able.
- **DuckDB's FK enforcement is conservative.** Any UPDATE on a row
  whose PK is FK-referenced will trip the over-enforcement,
  regardless of whether the UPDATE touches the FK column. Plan
  for it on any rename / metadata-edit route, not just `display_name`.
  The DELETE-children-and-restore dance is the supported workaround
  until DuckDB relaxes the constraint (which 1.5.2 did NOT — checked).

### Resolved — `updated_at` semantic overload split into two columns (PR B / issue #97)

The split shipped: `module_configs`
now carries `updated_at` (row-metadata, bumped on every UPDATE) and
`last_seen_at` (device-liveness, bumped only on `add_module`'s per-boot
registration UPSERT). The backend's `fetchAndAssemble` reads
`last_seen_at` for the 2 h status window; every other write site
(display-name rename, heartbeat-side geo-patch, legacy heartbeat
row-update) bumps only `updated_at`. The existing regression test was
inverted (renamed `test_patch_display_name_bumps_updated_at_not_last_seen_at`)
and two companion tests pin the new contract end-to-end. What this
changes for future writers: any new UPDATE on `module_configs` should
set `updated_at = NOW()` in the SET clause; NEVER write
`last_seen_at = NOW()` outside `add_module` — that column is the
contract for "ESP32 just announced itself", and `Module.status`
depends on it. The setup wizard's verification poll was also switched
from `m.updatedAt` to `m.lastSeenAt` — the old field is now polluted
by metadata writes that pre-split couldn't reach it.

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

**Closed in PR II — implementation note.** The architectural fix landed
as the 3-arg `hf::shouldOtaUpdate(current_version, current_sequence,
manifest)` in [`ESP32-CAM/lib/ota_version/ota_version.cpp`](../../ESP32-CAM/lib/ota_version/ota_version.cpp).
SEQUENCE lives in `ESP32-CAM/SEQUENCE` (single writer, same pattern
as VERSION) and rides through `build.sh` + `extra_scripts.py` +
`build_dev_artifact.py` to `firmware.json` and the firmware binary
macro. `parseOtaManifest` **rejects** manifests missing `sequence`
— see [ADR-008's "Sequence + allow_downgrade addendum"](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md#sequence--allow_downgrade-addendum-pr-ii-83)
for the full migration mechanic. The rollback procedure
(`allow_downgrade: true` for the deliberate rollback wave, then
immediately unset it) is documented in
[`docs/07-deployment-view/esp-flashing.md`](../07-deployment-view/esp-flashing.md).

**Sub-lesson: the dev-binary OTA self-overwrite (round-3 reviewer
finding).** The first PR II landing shipped `shouldOtaUpdate` as
`manifest.sequence > current_sequence` with no special-casing of
`current_sequence == 0` — which is the Arduino-IDE fallback set in
`esp_init.h` when a binary is hand-compiled without `build.sh` /
`extra_scripts.py`. Result: a dev hand-flashing a local binary onto
a module that's on the same LAN as the production homepage would
have seen the first OTA poll silently overwrite their code (because
`1 > 0` is true for any fleet release with `sequence >= 1`). Round-3
senior-review caught the comment-vs-code mismatch (the comments
already said "refuses every OTA from a properly-built fleet" —
which only became true after the guard landed). Fix: explicit
`current_sequence == 0 → refuse` clause, paired with two host
tests pinning both the no-allow_downgrade and allow_downgrade
branches. Operator implication: a dev binary requires a USB
reflash with a properly-built sequenced binary before it can
participate in OTAs; `allow_downgrade: true` on the fleet manifest
does NOT unlock dev-binary participation (deliberate — a rollback
wave shouldn't also clobber developer machines).

**How to avoid the same class next time.** When a comparator
acquires a new argument, write the host test for the sentinel
value (`0`, `null`, `""`, etc.) before writing the code; the host
test for `FIRMWARE_SEQUENCE=0` didn't exist in the first PR II
landing, so the comment claiming the sentinel was a refuse-signal
was not testable. Comments that describe behaviour without a
corresponding test will drift — the broader "trust code over
commit messages" rule in CLAUDE.md applies to ADR pseudocode and
source comments too, not just commit history.

### First-boot geolocation race: bounded retry + heartbeat-side recovery (#89, PR II)

**What happened.** The firmware's `getGeolocation` in
[`ESP32-CAM/esp_init.cpp`](../../ESP32-CAM/esp_init.cpp) was a
single-shot WiFi scan + Google Geolocation API POST called once
unconditionally in `setup()`. On the realistic failure mode — fresh
radio, DHCP still settling, WiFi scan returns empty before connection
is fully up — it silently returned, leaving `esp_config->geolocation`
at the `(0,0,0)` sentinel set in `setupConfig`. The next call,
`initNewModuleOnServer`, UPSERTed the row at `(0,0)` — the module
appeared at Null Island in the dashboard map until manually fixed.
Surfaced as issue [#89](https://github.com/schutera/highfive/issues/89);
the same root cause produced half of the symptom in issue
[#49](https://github.com/schutera/highfive/issues/49) ("jumping
geolocation in the dashboard" — the other half was the existing
deterministic `fuzzLocation`, which was a red herring).

**Why it happened.** Two design choices compounded.

1. `getGeolocation` had no retry loop. The Google API legitimately
   fails on a flaky first-boot WiFi association (BSSID list comes
   back too short / empty), and there was no second attempt within
   the boot window.
2. There was no in-uptime recovery path: heartbeats carried no
   lat/lng, so a module that registered at `(0,0)` could only be
   fixed by the next daily reboot (ADR-007) re-running `setup()`'s
   `getGeolocation+initNewModuleOnServer` pair.

**How to avoid it next time.** Two layers — pinned by tests in
[`ESP32-CAM/test/test_native_geolocation/`](../../ESP32-CAM/test/test_native_geolocation/test_geolocation.cpp)
and [`duckdb-service/tests/test_heartbeats_endpoint.py`](../../duckdb-service/tests/test_heartbeats_endpoint.py):

1. **Boot-time bounded retry** (3 attempts with 2s/6s/14s backoff)
   wrapping the existing single-shot logic. Worst case ~22s, well
   under the 60s `TASK_WDT` budget. Validated by a pure
   `hf::isPlausibleFix(float lat, float lng, float acc)` helper in
   [`ESP32-CAM/lib/geolocation/`](../../ESP32-CAM/lib/geolocation/geolocation.cpp)
   that rejects `(0,0,*)`, NaN, out-of-range, and zero-accuracy
   readings. Host-testable C++17, no Arduino deps — same pattern as
   `lib/module_name/` from PR I.
2. **Heartbeat-side recovery** for the case where all 3 boot
   attempts fail. The firmware still registers the module (at the
   `(0,0)` sentinel) so it appears in the operator UI with a
   "Location pending" pill, then `loop()` schedules `attemptGeolocation`
   retries every 30 minutes. On success the next heartbeat carries
   `latitude/longitude/accuracy` as form fields; the duckdb-service
   heartbeat endpoint UPDATEs `module_configs.lat/lng` **iff** the
   existing row sits at `(0,0)` — the conservative "only patch from
   (0,0)" rule guards against clobbering a deliberately-placed module.

The frontend `lib/location.ts::hasPlausibleLocation` helper applies the
same rule one layer further: any module that the server still has
recorded at `(0,0)` is filtered out of the map's marker set and
flagged with a "Location pending" pill in the side-list. Three
layers, one rule — `hf::isPlausibleFix` (firmware), `_is_plausible_fix`
(server), `hasPlausibleLocation` (frontend) — so a refactor that
drifts one without the others is a test-suite regression on three
sides at once.

**Deferred follow-ups:**

- The 30-minute deferred-retry cadence is a guess; the right
  cadence is "as often as plausible without DoSing Google's API on a
  captive-portal scenario". Field telemetry from the first
  deployment cycle should inform a tune.
- "Module physically moved" is NOT solved here. The heartbeat-side
  patch is `(0,0) → real fix` only. A module that's been picked up
  and reinstalled elsewhere will keep reporting heartbeats with the
  new fix; the server ignores them. A future feature could lift this
  via an explicit operator "relocate" gesture in the admin UI.
- `module_configs.lat`/`lng` has two writers — `/new_module`'s
  UPSERT and `/heartbeat`'s UPDATE — each carrying the (0,0)-
  preservation invariant inline. PR II's first round shipped the
  guard on the heartbeat side only; the senior-review caught that
  the register-side UPSERT also clobbers, so the same inline
  CASE/preserve logic now lives in `routes/modules.py` too. Two
  copies of the same rule.

  Clean fix: extract a single repository method that both call
  sites delegate to. The two writers don't share a wire shape
  (the heartbeat carries `accuracy`; `/new_module` doesn't), so
  the shared method takes only `(mac, lat, lng)` and leaves the
  accuracy-based plausibility check to the caller — the register
  path uses `ModuleData` Pydantic clamps at the entry point, the
  heartbeat path calls `_is_plausible_fix` inline. The shared
  function is just the SQL-level "patch from (0,0) only" rule.
  Out of scope for PR II — refactor with its own scope.

  The cross-test that pins the invariant is in
  `tests/test_modules.py::test_new_module_re_registration_does_not_clobber_recovered_location`
  paired with the heartbeat-side test in
  `tests/test_heartbeats_endpoint.py`. The four UPSERT-state
  quadrants are pinned by
  `test_new_module_re_registration_does_not_clobber_recovered_location`,
  `test_new_module_re_registration_with_real_fix_overwrites_existing`,
  `test_new_module_re_registration_after_null_island_with_real_fix_overwrites`,
  and `test_new_module_initial_registration_at_null_island_stores_zeros`.

  **The test files pin the (lat, lng) quadrant transitions but
  NOT the plausibility predicate itself.** Each writer carries its
  own test set; nothing fires if `_is_plausible_fix` is tightened
  (e.g. rejecting `accuracy > 10_000.0`) without parallel SQL
  changes. `/new_module`'s CASE is a pure SQL "is the incoming
  (0,0)" check, while `_is_plausible_fix` is a Python predicate
  that also rejects NaN, out-of-range, and zero accuracy — the
  convergence of input validity comes from
  `ModuleData.{latitude,longitude}: Field(ge=…, le=…)` Pydantic
  clamps at the entry point, not from the SQL itself. A future
  repo-method consolidation must lift the SQL rule AND the Python
  predicate together; treating only the SQL CASE as the seam will
  leave the asymmetric input validation untouched.

- Heartbeat-side recovery has a worst-case ~90 min staleness
  window: deferred retry can succeed up to 60 min before the next
  hourly heartbeat fires. For a stationary module this is
  irrelevant — the location won't change in 90 min. For a module
  physically moved during that window, the server records the
  pre-move location and then refuses to update because the chosen
  invariant is "only patch from (0,0)". Same bucket as the "module
  physically moved" deferred-follow-up above.

### A keyless release build shipped `(0, 0, 0)` modules that never appeared on the map

**What happened.** A firmware binary built **without `GEO_API_KEY`**
compiled cleanly and flashed fine, but every module flashed with it
reported `(latitude=0, longitude=0, accuracy=0)` on first boot. The
homepage map filters that `(0, 0)` Null Island sentinel client-side, so
those modules registered, uploaded, and heartbeated normally yet never
appeared anywhere the operator looks — the "new modules don't show up on
the dashboard" symptom, with no error to point at.

**Why it happened.** The Geolocation key is build-time-injected (issue
#18) and a missing key was only ever a **warning**: `build.sh` printed
`WARNING:` on `stderr` and produced the keyless binary anyway. The
firmware's runtime guard correctly skips the Google lookup on an empty
key, so nothing failed loudly — the binary was indistinguishable from a
good one until a flashed module silently no-showed on the map. This is a
sibling of the "First-boot geolocation race" entry above, but a distinct
root cause: that one is a _transient_ boot failure with a key present
(recoverable via deferred retry); this one is a _missing key at build
time_ (no key to retry with — every boot reports zeros).

**How to avoid it next time.** A latent constraint that only surfaces as
a silent field no-show should be a build error, not a warning (same
lesson as the "Critical-rules prose-to-code audit" entries). `build.sh`
now **errors and exits non-zero** when no key is found, so a keyless
binary can no longer reach an operator by accident. The deliberate
keyless path (a CI compile check that is never flashed) is gated behind
an explicit `HF_ALLOW_NO_GEO_KEY=1` opt-in that downgrades the failure
to a warning; the `pio run -e esp32cam` smoke env stays keyless as a
compile-only gate whose binary is never flashed. The guard lives in
`ESP32-CAM/build.sh`'s GeoKey block; operator-facing docs are
[`docs/07-deployment-view/esp-flashing.md`](../07-deployment-view/esp-flashing.md)
and [`docs/08-crosscutting-concepts/auth.md`](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).

### A dormant unescaped SSID echo became a live reflected-XSS path the moment the captive-portal page started running script

**What happened.** The captive portal's `sendConfigForm`
(`ESP32-CAM/host.cpp`) had long echoed the operator-entered Wi-Fi SSID
back into the form's `value="..."` **without HTML-escaping it**. For
years this was harmless: the page rendered no script and held no handle
to any other window, so a `"`/`<` in an SSID could at worst mangle the
form's own markup (self-XSS over a public-PSK AP). The onboarding-flow
change that made the saved page (a) run a `<script>` to
`postMessage('hivehive-config-saved')` + `window.close()` and (b) be
opened by the setup wizard via `window.open('http://192.168.4.1',
'_blank')` **without `noopener`** (the handle is needed for the
postMessage handoff) turned that dormant echo into a live **reflected
XSS / reverse-tabnabbing** vector: an SSID like
`"></script><script>window.opener.location=...</script>` survives the
round-trip (POST `/save` → stored → re-rendered on the saved page) and
can navigate the operator's wizard tab.

**Why it happened.** The escaping gap predated the feature; the feature
silently changed its blast radius. Nobody re-audited the existing echo
when adding the script + opener handle, because the diff "only added a
redirect," not an injection sink. The vector was caught by the
end-of-implementation senior-review, not by a test.

**How to avoid it next time.** Escape **every** operator-reflected value
at the output sink, not "where it looks risky today" — a sink's risk is
a function of the whole page, which a later change can alter without
touching the echo. The fix added a host-testable `hf::htmlEscape`
(`ESP32-CAM/lib/form_query/`) and routed the SSID echo through it, with
Unity tests in `test_native_form_query` that pin the attribute-breakout
payload produces no raw `<` or `"`. Related: the wizard's `message`
listener (`homepage/src/components/setup/useSetupWizard.ts`) accepts the
fixed signal from any origin and is safe **only** because it reads no
payload data — a `SECURITY:` comment now pins that invariant so a future
change that starts trusting the payload adds an origin/source check
first.

### "Three layers, one rule" was actually four surfaces — the dashboard side-list silently filtered pending modules (PR II final-pass smoke)

**What happened.** PR II's design intent was: a module stuck at the
`(0,0)` sentinel still appears in the operator UI with a "Location
pending" pill, so the operator can spot it and wait for the
heartbeat-side recovery (see the previous "First-boot geolocation
race" entry). Three rule definitions were aligned across firmware,
server, and frontend (`hf::isPlausibleFix`, `_is_plausible_fix`,
`hasPlausibleLocation`). The comment block at
[`homepage/src/components/MapView.tsx`'s `plottedModules`](../../homepage/src/components/MapView.tsx)
(named `fuzzedModules` at the time of this incident; renamed in #145 / ADR-020
when the cosmetic client-side fuzzing was removed — the filtering role is
unchanged) explicitly says "(0,0) and out-of-range modules are FILTERED OUT
entirely from the rendered map circle set — they still appear in
the dashboard side-list (with the 'Location pending' pill), but no
marker is plotted at Null Island". The PR description, the manual-
tests runbook's frontend-smoke section, and chapter-11's "First-boot
geolocation race" entry all asserted the same.

The dashboard side-list silently filtered them out anyway.
[`homepage/src/pages/DashboardPage.tsx`](../../homepage/src/pages/DashboardPage.tsx)
maps `visibleModules` (the bounds-filtered set MapView emits via
`onVisibleModulesChange`) into both the desktop floating list and
the mobile bottom-sheet. `MapView.tsx::plottedModules` already pre-
filters pending modules out before they can reach the callback, so
`visibleModules` is a plausible-only set by construction. Operator
impact: AdminPage rendered the pill correctly, the header counter
showed `N/N online` correctly, but the dashboard side-list silently
said `N-1 sichtbar` and the pending module had no UI affordance to
spot. Found visually during pre-merge manual dev-stack smoke; the
asymmetry between admin/header (correct) and dashboard list
(wrong) was the diagnostic.

**Why it happened.** The contract was prose-only.

1. **The contract lived in comments + the PR description, not in
   code.** The MapView comment block at `plottedModules`, the PR
   description's "side-list shows it with 'Location pending' pill"
   line, and the existing "First-boot geolocation race" entry one
   section above all asserted that pending modules appear in the
   dashboard side-list with the pill. None of those is an enforced
   contract — they're prose. The actual code never enforced what
   they asserted: `MapView.tsx::plottedModules` carried the
   `.filter((module) => hasPlausibleLocation(module.location))` from
   the original PR II commit `ef548e5` onward, and the downstream
   `visibleModules` (which `onVisibleModulesChange` feeds to
   `DashboardPage`) is derived from `plottedModules`. The side-list
   has consumed a plausible-only set since day one of PR II. The
   bug shipped with the first commit; round-1's later edit to the
   pre-bounds fallback branch was defensive consistency on a code
   path the parent never observed (`onVisibleModulesChange` is
   gated on `bounds` being truthy, so the pre-bounds fallback
   branch is computed but never propagated). The asymmetry the
   round-1 commit message describes was already cosmetic.
2. **No integration test pinned the cross-surface contract.**
   `MapView.test.tsx` only tests the pure `hasPlausibleLocation`
   helper. `ModulePanel.test.tsx` tests the pill render given a
   module directly. Nothing mounted `DashboardPage` with a mixed
   plausible/pending fixture and asserted the side-list's rendered
   DOM. So the prose claim that the side-list shows pending modules
   had no build-time gate to disagree with the prose claim itself.

**The meta-lesson.** **A behavioural contract asserted only in a
comment block, a PR description, or a chapter-11 entry is not a
contract — it is a wish.** PR II's prose said "pending modules show
up in the side-list with the pill"; the code shipped a filter that
made that impossible. Two senior-review rounds, a CLAUDE.md
"Verifying UI claims" finding, and a chapter-11 lessons-learned
entry all referenced the contract while it was structurally false.
The only thing that caught it was an operator opening the dashboard
during pre-merge manual smoke. Pin cross-surface contracts with a
mount-and-render integration test. Same pattern as PR-42's
[Telemetry sidecar envelope drift](#telemetry-sidecar-envelope-drift--admin-ui-silently-rendered--for-every-field)
entry — the wire-shape-mismatch story there was the same shape:
docs + types + code all individually correct, but the cross-layer
contract was wishful.

**Pinned partially by.** `tests/ui/tests/dashboard-side-list.spec.ts`
(Playwright, ADR-014) drives a real browser against the production-
built homepage with a seeded Null-Island module at `(0,0)` and asserts
that the module is visible in the side-list with the "Location
pending" pill. The spec pins the **structural rule** the side-list
must obey — "pending modules appear in the operator UI" — but **not**
the exact pre-104 bug shape, which is no longer possible to regress
in the same way: after PR-104's "dashboard side-list rework"
`DashboardPage`'s `sideListModules` is derived from the `/api/modules`
response with its own pending-bottom sort, not from MapView's
`visibleModules`. Re-introducing the original `.filter(hasPlausibleLocation)`
in MapView's `plottedModules` would leave the side-list unaffected.
The new failure mode the spec catches is "`sideListModules` learns
to filter pending modules out" or "the pill JSX branch is dropped".

**Current design (PR 1 / issues #103, #102, #101 — supersedes the
union-based fix.)** The original PR II patch closed the symptom by
defining `sideListModules = visibleModules ∪ pendingModules` in
`DashboardPage` — but that union was itself a smell, requiring
`DashboardPage` to reconstitute its own truth from a callback emitted
by `MapView`. PR 1 removed the coupling:

1. **DashboardPage owns the authoritative module set, MapView is a
   pure renderer.**
   [`homepage/src/pages/DashboardPage.tsx`](../../homepage/src/pages/DashboardPage.tsx)'s
   `sideListModules` is a single derivation from `modules` — a three-
   step deterministic sort: (1) pending-location modules sink to the
   bottom; (2) within each bucket, sort by `displayLabel` via a locale-
   pinned `Intl.Collator(lang)`; (3) final tie-break on `id`. The
   tertiary tie-break is what makes the determinism claim structurally
   true — without it, two modules with identical display names would
   fall through to JS stable-sort, which would in turn leak the
   nondeterministic order of `duckdb-service/routes/modules.py::get_modules`
   (no `ORDER BY` there today) into operator-visible behaviour.
   [`homepage/src/components/MapView.tsx`](../../homepage/src/components/MapView.tsx)
   consumes `modules` as a prop, filters via `plottedModules` for marker
   rendering, and emits no list-shaped data back. There is no
   `onVisibleModulesChange` and no `bounds` state.
2. **The side-list is no longer viewport-coupled** — operator-visible
   UX shift: panning/zooming the map does not change what the side-
   list shows. The list always contains every module. Two consequences
   to keep in mind: (a) the side-list count and the map marker count
   can legitimately differ (the count text was renamed to "X listed"
   to be honest about this); (b) for large fleets the side-list will
   grow without bound — if this becomes painful, the right answer is
   pagination or a separate "needs attention" surface, not re-coupling
   to viewport (which is what PR 1 explicitly walked away from).
3. **The integration test pins the full ordering invariant.**
   <!-- prettier-ignore -->
   [`DashboardPage.test.tsx`'s `DashboardPage Location-pending
   side-list` block](../../homepage/src/__tests__/DashboardPage.test.tsx)
   uses a three-module fixture (`pending-null-island`, `real-bodensee`,
   `alpha-foo`) deliberately ordered to distinguish three regression
   shapes: a no-op sort, a pending-last-only sort, and the current
   pending-last-plus-alphabetical sort. Indices 0 through 2 are pinned
   to `alpha-foo`, `real-bodensee`, `pending-null-island` by exact
   text, so any regression in either sort layer fails loudly. The same
   test pins the "Location pending" pill render and the header-counter
   parity.

The deferred follow-ups (renamed copy + defensive disjointness test)
that the original PR II entry mentioned both landed in PR 1: the copy
rename was applied as described, and the disjointness defense became
structurally unnecessary once the union itself was removed.

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

### Setup wizard Step 3 told users "open network — no password" while the AP is WPA2-protected

**What happened.** The same wrong "open AP" claim as the `auth.md`
incident above, but this time it shipped in the **user-facing setup
wizard** (`homepage/.../Step3WiFi.tsx` via `step3.openNetwork` in both
locales of `translations.ts`). The card showed the SSID
`ESP32-Access-Point` and the caption "This is an open network — no
password required.", but the firmware's `WiFi.softAP(HOST_SSID,
HOST_PASSWORD, …)` in `host.cpp` advertises a WPA2 AP with PSK
`esp-12345`. A field user followed the wizard, was prompted for a
password the wizard insisted didn't exist, guessed `esp-1234` (one
digit short), and got "unable to connect to this network." Fix: render
the PSK as a second copy-able field next to the SSID and replace the
caption with "this network is password-protected — enter the password
above". Every doc (`hardware-notes.md`, `esp-flashing.md`,
`troubleshooting.md`, `esp32cam.md`) already stated the password
correctly; the wizard was the lone surface that didn't.

**Why it happened.** The `auth.md` "open AP" fix corrected the _doc_
but never swept the _product_. The two surfaces describe the same
`WiFi.softAP` arguments, yet the lessons-learned remediation was scoped
to prose review and stopped at `docs/`. The wizard string had no test
asserting the rendered field matched `HOST_PASSWORD`, so jsdom unit
tests and the build stayed green while the only string that mattered to
a user in the field was wrong.

**How to avoid it next time.** When a code/doc-drift fix corrects a
claim that is _also_ surfaced in the UI, grep the frontend for the same
claim in the same change — `host.cpp`'s `HOST_SSID`/`HOST_PASSWORD` are
mirrored in `Step3WiFi.tsx`, and a constant in one must not silently
diverge from a translation string in the other. The
`tests/ui/tests/setup-wizard-happy-path.spec.ts` Playwright spec now pins
`#ap-ssid`/`#ap-password` to the literal firmware values so a future
divergence fails CI in the only layer that renders the production page.

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

**Pinned by.** `tests/ui/tests/dashboard-telemetry.spec.ts` (Playwright,
ADR-014). Drives a real browser against the production-built homepage,
seeds one telemetry-bearing sidecar via
`tests/ui/scripts/seed_ui_fixtures.py`'s `seed_telemetry_upload`
(which drives `tools/mock_esp.MockEsp`), and asserts the rendered
`TelemetryRow` contains the literal values (`UI_TEST_RESET`,
`fw ui-test-1.2.3`, `200 KB`, `-42 dBm`, `1h 0m`). The spec also
imports `TelemetryEntry` from `@highfive/contracts` so a future
rename at the wire-shape boundary is a TS compile error before the
spec even runs.

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

### Locate-button felt dead after the first permission deny (issue #14, PR #78, manual-test step T6)

**What happened.** PR #78 added a Google-Maps-style "show my
location" button to the dashboard map
(`homepage/src/components/MapView.tsx`'s `LocateControl`). During in-browser testing, the maintainer found
that after denying the geolocation permission once, subsequent
clicks on the button produced **no visible feedback** — no
network request, no new permission prompt, no UI state change.
The button felt broken.

**Why it happened.** Chrome (and most modern browsers) remember
the permission deny for the origin. On the second click,
`navigator.geolocation.getCurrentPosition()` invokes its **error
callback synchronously** with `PERMISSION_DENIED`, with no
re-prompt. Our code did call the error callback path — which sets
`busy = true → false` and updates the button's `title` attribute —
but the `busy` flip happens in microseconds (so the spinner CSS
animation never visibly starts), and `title` is only rendered by
the browser on hover (so the user clicking-but-not-hovering sees
nothing). The visible-feedback contract was implicit; the synchronous
deny path violated it.

**How to avoid next time.** Before calling any UX-critical
`navigator.geolocation.getCurrentPosition()` (or any other
permission-gated API where a denied state collapses the call to a
synchronous error), pre-query `navigator.permissions.query({...})`
to detect the `'denied'` state and short-circuit to an explicit,
hover-independent UI state. `homepage/src/components/MapView.tsx`'s
`LocateControl::onClick` does this now; the fix is the canonical
example for the next permission-gated button. Two collateral
gotchas the fix exposed:

- **The async pre-check opens a synchronous-double-click race.**
  Once `onClick` is `async`, the `if (busy) return` guard must claim
  the `busy` flag _before_ the first `await`, not after — otherwise
  two rapid clicks both pass the guard and double-invoke
  `getCurrentPosition`. A `busy` flag set only after the await is
  decoration, not a guard. Caught by senior-review round 3.
- **The browser `title` attribute is not a substitute for a
  visible UI state.** It works for screen readers and on-hover, but
  not for a click-and-move user who never hovers. Permanent-on-deny
  UX (e.g. a small badge / colour shift, or a snackbar) would be
  the next iteration if a future review finds the tooltip
  insufficient.

### Seed values coalesced behind an aggregate `COUNT(...)` are dead — and `??` does not save them (PR #122 iteration-1)

**What happened.** PR #122's first `tests/ui/tests/module-panel-rendering.spec.ts` asserted the seeded `Garten 12` module would render `87` images, lifted directly from `duckdb-service/db/schema.py`'s `INSERT INTO module_configs (..., image_count) VALUES ('000000000002', 'Garten 12', ..., 87)`. The spec failed in CI: the rendered panel showed `0 images`. The seed value never reached the wire.

**Why it shipped.** Two layers stacked.

1. **`duckdb-service/routes/modules.py`'s `get_modules`** computes a `COUNT(i.id) AS real_image_count` over a `LEFT JOIN image_uploads`. The seed only inserts `module_configs` rows; it never inserts matching `image_uploads`. So `COUNT(i.id)` returns `0` — a non-null integer, not null.
2. **`backend/src/database.ts`'s** assembler coalesces `imageCount: m.real_image_count ?? m.image_count ?? 0`. The first `??` short-circuits because `real_image_count` is `0` and `0 ?? X` returns `0` — the nullish coalescing operator short-circuits on `null` / `undefined` only, never on numeric `0`. The seed's `image_count = 87` is unreachable.

The seed value lives in the schema, has a plausible-looking name, and never wins. Reading the schema would lead a contributor to believe `Garten 12.imageCount === 87`; reading the wire response confirms otherwise.

**Lesson.** Seed values for columns that the read path coalesces _behind_ a SQL aggregate (`COUNT(...)`, `SUM(...)`, `COALESCE(..., 0)` — anything that returns a non-null default for an empty join) are dead. The aggregate always returns a non-null number; `??` always short-circuits on it; the seed value never surfaces. This generalises beyond `image_count`: audit every `module_configs` column whose read path traverses a `LEFT JOIN ... GROUP BY` aggregate before treating its seed value as user-visible.

**How to avoid next time.** Two structural rules.

1. **Don't trust the column name; trust the wire.** When writing a fixture-based assertion against a seeded value, hit the actual endpoint that the consumer reads (here: `GET /api/modules/:id`) and check the response body before pinning the value in a spec. The schema's column is necessary but not sufficient.
2. **If a seed value must be user-visible, make the seed populate the join table too.** For `image_count`: insert N matching `image_uploads` rows so `COUNT(i.id) = N`, and the `??` chain becomes irrelevant. The chain only matters at the boundary where data is genuinely missing; if you want the seed to be the boundary, fix the missing-data condition.

**Pinned by.** `tests/ui/tests/module-panel-rendering.spec.ts` now asserts on the leafcutter bee-type summary's total hatches (`22 + 8 + 19 + 15 = 64`), which IS load-bearing: the values come from `daily_progress` rows that the seed _does_ insert, traverse `getModuleById` → `ModulePanel.beeTypeSummaries`, and surface in the rendered DOM.

### A fix that makes a failing network call _succeed_ exposes the now-longer path (longhorn geolocation reboot loop)

**What happened.** The `longhorn` firmware (commit 998bbe1) fixed the geolocation TLS handshake — it had been failing peer-verify ever since Google rotated `www.googleapis.com` from the GTS Root R1 chain to R4, so the firmware now pins an R1+R4 bundle and the handshake verifies again. Within hours of the fleet OTA-ing to `longhorn`, field modules fell into a **~15–30 min reboot loop** and then went silent: the dashboard greyed them out. The previous `mining` firmware had run them stably for hours.

**Why it shipped.** The geolocation `HTTPClient` call (`attemptGeolocation` in `esp_init.cpp`) has **no timeout** — a pre-existing latent defect the code's own breadcrumb comment flagged ("the HTTPClient calls below have NO explicit setTimeout()"). On `mining` it never mattered: the handshake **failed fast** at cert-verify, so the call always returned in well under the 60 s task-WDT budget. `longhorn` made the handshake **succeed**, so for the first time the call actually connects, POSTs, and reads a response over TLS — and a stalled handshake (ESP32 default handshake timeout is **120 s**) or slow read can now block past the 60 s WDT → clean reboot, repeating on the loop's 30-min geolocation deferred-retry cadence. The "fix" didn't introduce a new bug; it _activated_ a dormant one by lengthening the call's runtime.

**How it was diagnosed (server-side only).** No serial access. The duckdb `/heartbeats/<id>` history showed the signature unambiguously: multi-hour `uptime_ms` and clockwork hourly heartbeats on `mining`, then every `longhorn` heartbeat at ~14–21 s `uptime_ms` (= a fresh boot each time). nginx access logs corroborated with repeated `/new_module` re-registrations (sent only from `setup()`). The reboot cadence (~25–30 min) matched `HF_GEOLOCATION_DEFERRED_RETRY_MS` (30 min). Battery readings were useless here — see the scaffolding note below.

**Lesson.** When you fix a network/RPC call that was silently failing, you are not just "making it work" — you are putting the **success path** into production for the first time, often after a long absence. Audit that path for the bounds the failure path never exercised: timeouts (connect, TLS handshake, read), heap/buffer peaks held for the _full_ exchange, watchdog budget. A call that "returns fast because it errors" hides every one of these.

**Fix (`carpenter` / OTA seq 4).** `attemptGeolocation` now bounds every blocking step under the WDT budget — `WiFiClientSecure::setHandshakeTimeout(8)` (vs the 120 s default), `HTTPClient::setConnectTimeout(8000)` and `setTimeout(8000)` — plus defense-in-depth: `WiFi.scanDelete()` before the handshake and a heap preflight that **defers** (keeps the module online) rather than attempting a TLS handshake below a floor. The preflight checks the largest **contiguous** free block (`ESP.getMaxAllocHeap()`), not total free heap — mbedTLS needs large contiguous allocations, and a long-running fragmented heap can show ample total-free while the biggest block is too small; the `[geo] largest free block=… (total free=…)` serial log surfaces both so the floor can be re-tuned. The same three timeouts were applied to `initNewModuleOnServer` (the identical unbounded TLS-capable POST, flagged by its own comment) so the whole boot-path TLS class is covered, not just the one call the telemetry fingerprinted. **Known residual:** the `postImage`/heartbeat handshakes in `client.cpp` still use the 120 s `setHandshakeTimeout` default; they were left untouched because they have run stably on both `mining` and `longhorn`, but they carry the same latent risk — harden them if a similar incident recurs. **Confirm on one bench module via serial (reset reason + the issue-#42 breadcrumb) before the fleet OTA** — the mechanism is strongly evidenced from telemetry but was not reproduced on a device, and the server-side `setup()` ordering attributes the WDT trip to the loop's 30-min deferred retry (`tickGeolocationDeferredRetry`), not boot geolocation. Do **not** roll back to `mining`: `allow_downgrade:false` and seq 4 > 3 mean the fleet moves forward only. Related: "TASK_WDT in `postImage:read_body`" above (same WDT-on-unbounded-network-read family) and "Pinned `GTS Root R1` for geolocation".

### Battery telemetry is scaffolding — `random(1,100)`, not a real reading

**What happened.** During the `longhorn` reboot diagnosis, a module's `battery: 6` heartbeat read as a dying battery and sent the investigation down a hardware path. It was noise: firmware sets `battery_level` to a hardcoded `90` at boot (`esp_init.cpp` `loadConfig`) and to `random(1, 100)` on every image upload (`client.cpp` `postImage`). There is no battery-voltage ADC sensing wired up.

**Lesson.** Placeholder telemetry that looks like a plausible real value (a 0–100 "percentage") is worse than no telemetry — it actively misleads diagnosis and the dashboard. And the "obvious no-data sentinel" depends on the consumer: a constant `0` reads as "n/a" to a human glancing at a scalar, but to a time-series/aggregation layer (here the #110 `measurements` store, which `AVG`s and dense-fills) a `0` is a real sample — it renders as "battery flat at empty," the exact lie a gap should avoid. For a series, "no data" must be literal absence (omit the field / `null`), not a sentinel value; only a scalar current-reading can safely use `0`. This was a round-2 senior-review catch: the first cut emitted `0` everywhere and the heartbeat's `0` would have dual-written a fabricated `battery_pct=0.0` on every ping.

**Fix (`carpenter`).** Split by consumer. The hourly heartbeat (`client.cpp` `sendHeartbeat`) now **omits** the battery field entirely, so the bare `/heartbeat` route's #110 dual-write hits its tested `battery is None` skip-path (`test_heartbeat_without_battery_skips_dual_write`) and the `battery_pct` series stays an honest gap rather than a fabricated 0% stream a read would `AVG` into a flat discharge. The upload multipart (`client.cpp` `postImage`) still sends a `0` sentinel — the image-service `/upload` contract requires a 0–100 battery, and that value feeds only the current-reading scalar `module_configs.battery_level` (updated via `/modules/<id>/heartbeat`, which does **not** write a measurement), never the time-series. `esp_init.cpp` `loadConfig` still seeds `0`. The homepage `BatteryHistoryChart` was already disabled (`ModulePanel.tsx`); its docstring/comment now say current firmware shows null gaps. Re-enable the heartbeat field + dual-write in the same change that lands real ADC sensing (#8a / #8b).

### A default firmware build silently bakes production URLs → "dead body" module on prod (issue #145 / #156)

**What happened.** During the on-hardware verification of #145, a module was flashed from a build with **no** `DEV_SERVER_HOST` set. The firmware silently baked the production URLs, so on first boot the module registered itself to `https://highfive.schutera.com` — there was no captive-portal field to redirect it (ADR-018 made the portal Wi-Fi-only), so it had to be rebuilt and reflashed. Worse, the stray registration left a "dead body" module in the production admin that **reappeared on every boot** until the module was reflashed, and deleting it from `/admin` before the retargeted firmware was running just let the next registration recreate it.

**Lesson.** Two distinct failure modes. (1) "Absence of a dev flag" must not silently default to the _production_ blast radius for a developer action — a dev flash that bakes prod is a footgun that only shows up after a module has already polluted prod. (2) Registration is driven by the firmware's POST to `/new_module` at boot, not by any server-side state, so a misconfigured module is "sticky": you cannot fix it server-side, only at the device, and only the device-side fix (retarget then confirm) makes a subsequent `/admin` delete stick.

**Fix (issue #156).** Three layers. (a) `make flash-dev` sets `HF_DEV_BUILD=1`, which makes `ESP32-CAM/build.sh` and `extra_scripts.py` **hard-fail when `DEV_SERVER_HOST` is unset** (mirroring the `GEO_API_KEY` FATAL gate) — a dev flash can no longer silently bake prod. (b) A developer USB-serial console (`ESP32-CAM/serial_console.cpp`) with a boot window before `initNewModuleOnServer` lets `set-server <host>` retarget _this_ boot's first registration, so a module never has to hit prod first; `reopen-portal` reopens the Wi-Fi setup AP without erasing creds (NVS `configured` flag flip; Wi-Fi lives in SPIFFS). (c) `ESP32-CAM/host.cpp`'s `saveConfig` is now read-modify-write (pure helper in `ESP32-CAM/lib/config_json/`, pinned by `test_native_config_json`) so a Wi-Fi save no longer drops an out-of-band URL override. See [ADR-018 amendment](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md#amendment-issue-156-developer-usb-serial-server-override).

### `saveConfig` rebuilt `/config.json` from scratch — a Wi-Fi save would silently drop an out-of-band URL override (issue #156, R1)

**What happened.** While adding the serial-console server override (#156), the highest-risk interaction was that `host.cpp`'s `saveConfig` built a fresh `StaticJsonDocument` containing only SSID/PASSWORD and wrote it over `/config.json`. The override writer (`esp_init.cpp` `writeServerUrlsToConfig`) writes `NETWORK.INIT_URL`/`UPLOAD_URL` into the **same file** — so any later Wi-Fi reconfigure through the captive portal would have silently erased the override, sending the module back to its baked default on the next boot.

**Lesson.** When two writers share one config file, a "build it fresh" writer is a latent data-loss bug the moment a _second_ writer adds keys it doesn't know about. Make every writer read-modify-write (preserve unknown keys), and factor the mutation into a host-tested pure function so the "preserve a key I don't own" invariant is pinned by a test (`test_wifi_save_preserves_existing_init_url`) rather than living only in a careful author's head. Bonus: computing the new JSON _before_ opening the file for `"w"` also closes the older #19 truncate-then-fail window — an overflow now leaves the existing file byte-for-byte intact instead of stranding an empty one.

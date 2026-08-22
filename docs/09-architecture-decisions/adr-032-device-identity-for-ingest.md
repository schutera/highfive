# ADR-032: Device identity for `/new_module` and `/heartbeat` — interim compiled-in fleet key

## Status

Proposed

## Context

`POST /new_module` and `POST /heartbeat` are the two `duckdb-service`
write routes host-nginx proxies to the internet
([production-deployment.md](../07-deployment-view/production-deployment.md)).
Neither carries any credential — the whole `duckdb-service` API is
"unauthenticated by design, on the assumption that only in-bridge callers
reach them" (`docs/08-crosscutting-concepts/auth.md`), an assumption these
two routes have never actually satisfied in production. The 2026-08 audit
(#229) hardened both handlers' **write semantics** (re-registration no
longer overwrites `name`/`email`, nor `latitude`/`longitude` for a module
that already has a real fix — the location guard gates on the *stored*
row, never the incoming payload, so an anonymous re-POST can no longer
relocate a placed module; a first-pass version of this got the gating
direction backwards and was caught pre-merge, see chapter 11 — an
unregistered MAC's heartbeat is dropped instead of silently accruing
rows, and `battery` is clamped) and **documented, but has not deployed**,
nginx-level rate/body-size bounds
([`deploy/nginx/highfive-ingest.conf`](../../deploy/nginx/highfive-ingest.conf) —
a template an operator applies to the live host, not yet wired into a
running production nginx).
None of that requires a credential — it bounds *what* an anonymous caller
can do, not *who* is allowed to call. This ADR is about the second half:
should these routes require the caller to prove it is a real HiveHive
module at all, and if so, how.

Three options were weighed:

**(a) Interim compiled-in fleet key.** One shared secret, baked into
every firmware build the same way `GEO_API_KEY` is
(`ESP32-CAM/extra_scripts.py` for PlatformIO, `ESP32-CAM/build.sh` for
`arduino-cli`), sent as an `X-Module-Key` header, and checked
server-side with `hmac.compare_digest` — the same pattern already used
for the admin key in `routes/logs.py`. Cheap to build (one macro, one
header check, one env var), but it is a *fleet* credential: every module
in existence shares it, so a single leaked binary (or a
[decompiled `firmware.bin`](https://github.com/schutera/highfive/issues/261)
— firmware.bin is served unauthenticated for OTA) compromises the bound
for the whole fleet at once, not just one device.

**(b) Per-device keys.** Minted at registration, stored per-`module_id`,
rotated independently. Closes the "one leak, whole fleet" blast radius of
(a), but registration is exactly the step that currently has no
credential to bootstrap trust from — a per-device key needs either a
manual provisioning step (defeats the project's zero-touch onboarding
goal) or a still-shared *bootstrap* secret to mint the first per-device
key over, which reduces to (a) at the bootstrap step anyway.

**(c) Both — (a) now, (b) later.** Ship the fleet key first (cheap,
immediate, matches the existing `GEO_API_KEY` mechanism the operator
already understands), and treat per-device keys as a follow-up once
there's a real bootstrap story (device-side keygen at first boot, keyed
off something device-unique like the eFuse MAC + a server-side mint
step).

A hobbyist, single-tenant deployment doesn't need per-device
non-repudiation today — the actual threats this ADR addresses (public-map
defacement, webhook spam, log-ring pollution, disk-fill via an
unauthenticated write loop) are already closed at the handler/nginx
level by #229 regardless of which identity option is chosen. A device
credential adds one more layer: it turns "any anonymous internet client"
into "any client holding the fleet key", which is a real reduction in
who can reach these two routes at all, even though it doesn't fully
close #224's "rate guard is keyed on a client-chosen MAC" gap (a leaked
fleet key still lets an attacker claim any MAC).

## Decision

Adopt **(c)**: ship the interim compiled-in fleet key **(a)** as the next
piece of work (a separate follow-up issue — this ADR does not itself
change any code), and revisit per-device keys **(b)** only once a real
bootstrap mechanism exists. Concretely, when the follow-up lands:

- One `X-Module-Key` value, injected at build time via the **same
  three-tier mechanism** `GEO_API_KEY` uses (env var → a gitignored
  single-line file → empty-string skip) — its own gitignored file (e.g.
  `ESP32-CAM/MODULE_KEY`, a separate name from `GEO_API_KEY`, not a
  second secret stored in the same file). `GEO_API_KEY`'s injection
  mechanism is documented in
  [auth.md → "Third-party API keys: Geolocation"](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation)
  as the pattern to copy — but a fleet device credential is not a
  third-party API key (it authenticates *this* fleet to *this* server,
  not this server to a vendor), so its own documentation belongs in a
  new section of its own (`auth.md → "Fleet device credential"` or
  similar), not filed under Geolocation.
- Checked server-side with `hmac.compare_digest`, mirroring
  `routes/logs.py`'s existing admin-key check — no new comparison
  pattern to review.
- **Rotation ships via firmware OTA**, per
  [firmware-release.md](../07-deployment-view/firmware-release.md): a
  new key requires a `SEQUENCE`-bumped release, same as any other
  firmware change. There is no server-side-only rotation path, because
  the key lives in every device's flash.
- **A mixed-fleet grace window is required.** The server must accept
  *either* the new key *or* the previous one for some deploy window,
  because OTA rollout is not instantaneous (`docs/06-runtime-view/ota-update-flow.md`)
  — modules on the old firmware would otherwise go dark the moment the
  new key ships. The exact mechanism (two accepted keys server-side,
  keyed by an explicit rotation date) is left to the implementing issue.
- **The key is not a secret from a sufficiently motivated attacker.**
  `firmware.bin` is served unauthenticated for OTA (#261), so anyone can
  extract the compiled-in key from a shipped binary. This credential
  raises the bar from "no credential at all" to "must possess or extract
  a firmware image" — it does not create per-device accountability or
  survive a public leak of one firmware build.

## Consequences

- **These two routes stop being callable by an arbitrary internet
  client** once the follow-up lands — a real improvement over today's
  fully-open state, even though the credential is shared, not
  per-device.
- **No change to today's threat model in the meantime.** This ADR
  records a decision; #229's handler/nginx hardening is the part that
  actually shipped in this PR. Until the follow-up issue lands,
  `/new_module` and `/heartbeat` remain credential-free — bounded by the
  write-semantics and rate-limit fixes, not gated.
- **A leaked fleet key is a whole-fleet incident, not a one-device
  incident.** Rotation requires a `SEQUENCE`-bumped OTA release reaching
  every module — slower than revoking a per-device key, and modules that
  never come back online (dead battery, abandoned nest) keep the old key
  forever. Acceptable for the current hobbyist/single-tenant scale;
  revisit before any multi-tenant or commercial deployment.
- **Per-device keys (b) remain future work**, gated on a real bootstrap
  mechanism — not on this ADR being revisited, since the bootstrap
  problem is the actual blocker, not a lack of will to build (b).
- **The code for (a) is explicitly out of scope for the PR that adds
  this ADR.** A follow-up issue implements the header, the build-time
  injection, the server-side check, and the mixed-fleet grace window.

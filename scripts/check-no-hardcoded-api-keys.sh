#!/usr/bin/env bash
# Catch a hardcoded Google API key, Discord webhook URL, or a
# WiFi.begin() call carrying a literal SSID/passphrase — the failure
# modes of issue #18 (the Geolocation key that leaked because it was
# inlined as a string literal in ESP32-CAM/esp_init.cpp), the 2026-07
# audit's Discord webhook default, and issue #227 (a commented-out
# WiFi.begin(...) credential in the same file). Run from `make
# check-no-hardcoded-api-keys` and the husky pre-push hook.
#
# The Wi-Fi pattern matches only this one call shape — it does not
# catch a credential assigned to a variable (e.g. ESP32-CAM/host.cpp's
# `const char *HOST_PASSWORD = "esp-12345";`, the captive portal's
# intentional, documented AP PSK). Adding a guard for one leak's shape
# does not imply coverage of the next one — see chapter 11's "A
# secrets guard scoped to one leak's shape missed the next leak" for
# why that matters here specifically.
#
# Google API keys start with `AIza` followed by 35 chars from the URL-
# safe base64 alphabet (letters, digits, `-`, `_`). The pattern below
# requires at least 20 trailing chars so the match is anchored to a
# realistic key shape and won't false-positive on the prefix alone
# appearing inside a longer English word.
#
# The canonical fix, in all three cases: rotate/revoke the credential
# at its source (Google Cloud console, Discord webhook settings, or
# the affected Wi-Fi router — see each FAIL block below for specifics),
# then remove the literal from the tree. Deleting the line alone never
# mitigates a leak in a public repo: git history keeps it regardless.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root" || exit 1

pattern='AIza[0-9A-Za-z_-]{20,}'

# Allowlist: files that legitimately discuss the pattern without
# actually carrying a live key. Add new entries sparingly — the whole
# point of this gate is to make every match a deliberate decision.
#
# Why each entry is on the list:
#   * scripts/check-no-hardcoded-api-keys.sh — this script itself
#     contains all three regexes above, which would obviously match.
#   * docs/11-risks-and-technical-debt/README.md — the #227 postmortem
#     already quotes the WiFi.begin("...", "...") shape as a placeholder
#     example (matches wifi_pattern today), and the #18 entry may quote
#     a revoked/rotated credential verbatim in future — allowlisted so
#     neither forces a global allowlist edit.
skip_files=(
  'scripts/check-no-hardcoded-api-keys.sh'
  'docs/11-risks-and-technical-debt/README.md'
)

skip_args=()
for f in "${skip_files[@]}"; do
  skip_args+=( ":!$f" )
done

hits=$(git grep -nIE "$pattern" -- . "${skip_args[@]}" 2>/dev/null || true)

if [[ -n "$hits" ]]; then
  echo "check-no-hardcoded-api-keys: FAIL — likely Google API key literal in source:"
  echo ""
  echo "$hits" | sed 's/^/  /'
  echo ""
  echo "  Treat this as a security incident, not a typo:"
  echo "    1. Revoke the key in the issuing console (Google Cloud → APIs & Services → Credentials)."
  echo "    2. Re-issue and route through build-time injection (see"
  echo "       docs/08-crosscutting-concepts/auth.md \"Third-party API keys: Geolocation\"."
  echo "       The ESP32-CAM/extra_scripts.py + ESP32-CAM/build.sh pattern is the template)."
  echo "    3. Remove the literal from the working tree. The git history will still"
  echo "       contain it — revocation is the only real mitigation."
  exit 1
fi

# Second pattern: Discord webhook URLs. A webhook URL is a bearer
# credential (anyone holding it can post to the channel), and one was
# committed as an in-source default in services/discord.py of both
# Python services — found and rotated in the 2026-07 audit (for #201).
# The `[0-9]` anchor means prose mentions of the path shape without an
# actual channel id (docs, this script) don't match.
#
# `discord(app)?\.com` — the legacy `discordapp.com` host still works and is
# still handed out by older integrations, so a webhook pasted from one would
# have slipped past a `discord\.com`-only pattern. Verified by probe: the
# narrower pattern returned OK on a planted discordapp.com literal.
webhook_pattern='discord(app)?\.com/api/webhooks/[0-9]'

webhook_hits=$(git grep -nIE "$webhook_pattern" -- . "${skip_args[@]}" 2>/dev/null || true)

if [[ -n "$webhook_hits" ]]; then
  echo "check-no-hardcoded-api-keys: FAIL — Discord webhook URL literal in source:"
  echo ""
  echo "$webhook_hits" | sed 's/^/  /'
  echo ""
  echo "  Treat this as a security incident, not a typo:"
  echo "    1. Rotate the webhook in Discord (Server Settings → Integrations → Webhooks)."
  echo "    2. Route the value through the DISCORD_WEBHOOK_URL env var"
  echo "       (see docker-compose*.yml and docs/08-crosscutting-concepts/auth.md)."
  echo "    3. Remove the literal from the working tree. The git history will still"
  echo "       contain it — rotation is the only real mitigation."
  exit 1
fi

# Third pattern: WiFi.begin() with a literal SSID and/or a literal
# passphrase — the passphrase is the actual secret, so a literal in
# either argument position counts. Found in the 2026-08 audit as a
# commented-out bench line, both arguments literal, in
# ESP32-CAM/esp_init.cpp (issue #227). The config-driven form
# WiFi.begin(wifi_config->SSID, wifi_config->PASSWORD) and the bare
# WiFi.begin() do not match: neither argument is a double-quoted
# string in either. Scope is deliberately narrow to this one call
# shape — it does NOT cover a credential assigned to a variable (see
# docs/08-crosscutting-concepts/auth.md "Captive-portal credential
# handling" for the concrete gap), WiFiMulti.addAP(...), or an
# Arduino F("...") literal. [[:space:]] (not \s) is used for POSIX
# ERE portability across grep implementations.
wifi_pattern='WiFi\.begin\([[:space:]]*("[^"]*"[[:space:]]*,|[^,]*,[[:space:]]*"[^"]*")'

wifi_hits=$(git grep -nIE "$wifi_pattern" -- . "${skip_args[@]}" 2>/dev/null || true)

if [[ -n "$wifi_hits" ]]; then
  echo "check-no-hardcoded-api-keys: FAIL — literal SSID/passphrase in a WiFi.begin() call:"
  echo ""
  echo "$wifi_hits" | sed 's/^/  /'
  echo ""
  echo "  Treat this as a security incident, not a typo:"
  echo "    1. Rotate the Wi-Fi password on the router that broadcasts that SSID."
  echo "    2. Route credentials through the config-driven WiFi.begin(wifi_config->SSID,"
  echo "       wifi_config->PASSWORD) path (captive-portal / NVS config) — never a literal."
  echo "    3. Remove the literal from the working tree. The git history will still"
  echo "       contain it — rotation is the only real mitigation."
  exit 1
fi

echo "check-no-hardcoded-api-keys: OK — no Google API key, Discord webhook, or WiFi.begin() literal-credential calls found."
exit 0

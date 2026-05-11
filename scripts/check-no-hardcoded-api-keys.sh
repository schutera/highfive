#!/usr/bin/env bash
# Catch a hardcoded Google API key in source — the failure mode of
# issue #18 (the Geolocation key that leaked because it was inlined as
# a string literal in ESP32-CAM/esp_init.cpp). Run from `make
# check-no-hardcoded-api-keys` and the husky pre-push hook.
#
# Google API keys start with `AIza` followed by 35 chars from the URL-
# safe base64 alphabet (letters, digits, `-`, `_`). The pattern below
# requires at least 20 trailing chars so the match is anchored to a
# realistic key shape and won't false-positive on the prefix alone
# appearing inside a longer English word.
#
# The canonical fix when this fires: revoke the key in the issuing
# console, then route the value through the build-time injection
# pattern documented in docs/08-crosscutting-concepts/auth.md
# ("Third-party API keys: Geolocation").

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

pattern='AIza[0-9A-Za-z_-]{20,}'

# Allowlist: files that legitimately discuss the pattern (this script,
# the chapter-11 lessons-learned post-mortem) without actually carrying
# a live key. Add new entries sparingly — the whole point of this gate
# is to make every match a deliberate decision.
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

echo "check-no-hardcoded-api-keys: OK — no Google API key literals found."
exit 0

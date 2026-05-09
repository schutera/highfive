#!/usr/bin/env bash
# Catch user-visible prose telling people to "hold IO0 / the left button
# for N seconds to factory-reset" — the broken pre-#40 procedure that
# was unreachable on AI Thinker ESP32-CAM-MB because GPIO0 is a strap
# pin. This is the mechanical gate the chapter-11 "GPIO0 is a strap
# pin" lesson called for. Wired via `make check-stale-reset-prose` and
# the husky pre-push hook.
#
# Allowlist: the chapter-11 post-mortem itself legitimately quotes the
# broken procedure for didactic purposes.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Patterns that describe the unreachable-on-strap-pin factory-reset:
patterns=(
  'hold.*IO0.*for.*[0-9]+.*second'
  'hold.*[0-9]+.*second.*IO0'
  'hold.*the.*IO0.*button.*for'
  'hold.*left.button.*ESP32-CAM'
  'press.*and.*hold.*left.button'
  'halte.*linken.*Knopf.*[0-9]+.*Sekunden'
  '[0-9]+\s*seconds?\s+(while.*powered.*reset|until.*restart.*reset)'
)

# Allow-list: files that legitimately describe the broken procedure
# for didactic purposes (post-mortem narrative, regression-pin tests).
skip_files=(
  'docs/11-risks-and-technical-debt/README.md'
  'homepage/src/__tests__/i18n.test.ts'
)

skip_args=()
for f in "${skip_files[@]}"; do
  skip_args+=( ":!$f" )
done

# Combine patterns with alternation
combined=$(IFS='|'; echo "${patterns[*]}")

# Per-line historical-marker allowlist: lines that quote the broken
# procedure for didactic purposes ("removed in #40", "legacy", "did
# not work", "unreachable", "lessons learned" pointer) are fine.
historical_markers='removed in #40|legacy|did not work|was unreachable|unreachable on|post-mortem|lessons learned|older revisions|former'

# Search across user-facing surfaces only, then drop lines that mark
# the citation as historical.
hits=$(git grep -niE "$combined" -- \
  'homepage/src/' \
  'docs/' \
  '.claude/skills/' \
  'ESP32-CAM/' \
  "${skip_args[@]}" 2>/dev/null \
  | grep -viE "$historical_markers" \
  || true)

if [[ -n "$hits" ]]; then
  echo "check-stale-reset-prose: FAIL — broken pre-#40 factory-reset prose detected:"
  echo ""
  echo "$hits" | sed 's/^/  /'
  echo ""
  echo "  The 'hold IO0 / left button for N seconds' procedure is unreachable on"
  echo "  AI Thinker ESP32-CAM-MB (GPIO0 is a strap pin). Replace with the"
  echo "  captive-portal procedure: POST /factory_reset on http://192.168.4.1."
  echo "  See docs/11-risks-and-technical-debt/README.md \"GPIO0 is a strap pin\"."
  echo "  The post-mortem file itself is allowlisted."
  exit 1
fi

echo "check-stale-reset-prose: OK — no stale 'hold IO0' prose found."
exit 0

#!/usr/bin/env bash
# Catch the deprecated `displayName ?? name` / `display_name ?? name`
# rule re-emerging in prose or code outside its legitimate uses. The
# operator-visible label resolves via `homepage/src/lib/displayLabel.ts`
# (`.trim() || name`) — `??` only short-circuits on null, missing the
# empty-string and whitespace-only branches the helper exists to
# defend.
#
# See `docs/11-risks-and-technical-debt/README.md`'s
# "`displayName ?? name` lived in seven docs and eight render sites"
# entry for the six-round senior-review chase that motivated this
# trip-wire. The lesson: when you promote a rule to a helper, every
# prose copy of the old rule becomes drift. A grep that runs at
# commit time turns the round-N review ritual into a CI check.
#
# Legitimate `??` survivors (NOT stale rule statements):
#   - `backend/src/database.ts`'s `displayName: m.display_name ?? null`
#     — DuckDB-NULL → TS-null wire conversion, not a render rule.
#   - `homepage/src/components/RenameModuleModal.tsx`'s
#     `useState<string>(module.displayName ?? '')` — input-field
#     pre-fill (empty input when no override, different semantics).
#   - `homepage/src/services/api.ts`'s
#     `body.display_name ?? displayName ?? ''` — error-carrier message
#     constructor; presence chain, not a label rule.
#
# These are individually allow-listed below by exact line match. Add
# new exceptions only when the pattern is a non-label-rule use (and
# document why in this header).

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Allow-list: legitimate `??` uses that are NOT stale label-rule
# restatements. Anchored on the specific file + distinctive substring
# so a future caller that copy-pastes the pattern into a label-render
# site does NOT match (the use-site is what makes it legitimate, not
# the operator).
allow_pattern='^('\
'backend/src/database\.ts:[0-9]+:.*displayName: m\.display_name \?\? null'\
'|homepage/src/components/RenameModuleModal\.tsx:[0-9]+:.*useState<string>\(module\.displayName \?\?'\
'|homepage/src/services/api\.ts:[0-9]+:.*body\.display_name \?\? displayName \?\?'\
')'

# `|| true` because git grep returns 1 on no matches.
hits=$(git grep -nE '(display_name|displayName) \?\?' -- \
        'docs/' 'backend/' 'duckdb-service/' 'contracts/' \
        'image-service/' 'homepage/src/' \
        ':!scripts/check-stale-display-name-rule.sh' \
        ':!docs/11-risks-and-technical-debt/README.md' \
      2>/dev/null || true)

bad=$(echo "$hits" | grep -vE "$allow_pattern" || true)

if [[ -z "$bad" ]]; then
  echo "check-stale-display-name-rule: clean (legitimate ?? uses allow-listed)."
  exit 0
fi

echo "check-stale-display-name-rule: stale rule statement(s) found —"
echo "$bad" | sed 's/^/  /'
echo
echo "The operator-visible label resolves via homepage/src/lib/displayLabel.ts"
echo "(.trim() || name). \`??\` is the wrong operator — it misses the empty-string"
echo "and whitespace-only branches the helper defends against. Either:"
echo "  - update the prose to reference \`displayLabel.ts\`, OR"
echo "  - if this is a legitimate non-label-rule use, allow-list it in"
echo "    scripts/check-stale-display-name-rule.sh (with a comment explaining why)."
exit 1

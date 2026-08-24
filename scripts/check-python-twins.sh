#!/usr/bin/env bash
# check-python-twins.sh — keep hand-duplicated Python modules in sync
# across image-service and duckdb-service (issue #241).
#
# Python has no npm-style workspace mechanism, so five small modules are
# deliberately copy-pasted between the two services rather than factored
# into a shared package (explicitly out of scope for #241 — see
# docs/11-risks-and-technical-debt/README.md). Nothing enforced that the
# copies actually stayed identical: duckdb-service/services/discord.py
# had already drifted from its twin (missing a PEP 8 import-group blank
# line) before this gate existed to catch it. Two of the five pairs
# tolerate a documented docstring difference (each names its own
# counterpart's path) — everything else must be byte-for-byte identical.
#
# Run from `make check-python-twins`, the husky pre-push hook, and (once
# wired) CI.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root" || exit 1

# Pair table: left|right|mode. mode is "strict" (the two files must be
# byte-identical) or "docstring" (byte-identical after each file's
# leading module docstring is stripped). One record per line so a
# rename or a new twin forces this table to be touched, not silently
# skipped.
pairs="
image-service/services/log_ring.py|duckdb-service/services/log_ring.py|strict
image-service/services/prod_guard.py|duckdb-service/services/prod_guard.py|docstring
image-service/services/module_id.py|duckdb-service/models/module_id.py|docstring
image-service/services/discord.py|duckdb-service/services/discord.py|strict
image-service/tests/test_prod_guard.py|duckdb-service/tests/test_prod_guard.py|strict
"

# Strip a leading module docstring — the first """-delimited block that
# appears before any non-comment, non-blank code line — in awk rather
# than python. Issue #270 exists precisely because probing for a Python
# interpreter is unreliable on Windows, and a guard that silently
# no-ops when no interpreter is found is worse than no guard at all.
# Handles both the usual multi-line form and, defensively, a single-line
# """text""" form. Leading blank lines / comments before the docstring
# are preserved as-is; nothing else in the file is touched.
strip_docstring() {
  awk '
    BEGIN { resolved = 0; indoc = 0 }
    {
      line = $0
      if (indoc) {
        if (index(line, "\"\"\"") > 0) { indoc = 0; resolved = 1 }
        next
      }
      if (!resolved) {
        trimmed = line
        sub(/^[ \t]+/, "", trimmed)
        if (trimmed == "" || trimmed ~ /^#/) { print line; next }
        if (trimmed ~ /^"""/) {
          rest = substr(line, index(line, "\"\"\"") + 3)
          if (index(rest, "\"\"\"") > 0) {
            resolved = 1
          } else {
            indoc = 1
          }
          next
        }
        resolved = 1
      }
      print line
    }
  ' "$1"
}

fails=0
count=0

while IFS='|' read -r left right mode; do
  [ -z "$left" ] && continue
  count=$((count + 1))

  missing=0
  if [ ! -f "$left" ]; then
    echo "check-python-twins: FAIL — $left is missing (twin of $right)."
    missing=1
  fi
  if [ ! -f "$right" ]; then
    echo "check-python-twins: FAIL — $right is missing (twin of $left)."
    missing=1
  fi
  if [ "$missing" = "1" ]; then
    echo "  A rename or deletion must update the pair table in"
    echo "  scripts/check-python-twins.sh, not just move the file."
    fails=$((fails + 1))
    continue
  fi

  diff_ok=0
  case "$mode" in
    strict)
      if diff_out=$(diff -u "$left" "$right" 2>&1); then
        diff_ok=1
      fi
      ;;
    docstring)
      left_tmp=$(mktemp)
      right_tmp=$(mktemp)
      strip_docstring "$left" > "$left_tmp"
      strip_docstring "$right" > "$right_tmp"
      if diff_out=$(diff -u "$left_tmp" "$right_tmp" 2>&1); then
        diff_ok=1
      fi
      rm -f "$left_tmp" "$right_tmp"
      ;;
    *)
      echo "check-python-twins: FAIL — unknown mode '$mode' for pair $left <-> $right."
      fails=$((fails + 1))
      continue
      ;;
  esac

  if [ "$diff_ok" = "1" ]; then
    echo "check-python-twins: OK   $left <-> $right ($mode)"
  else
    echo "check-python-twins: FAIL — $left <-> $right ($mode) differ:"
    echo ""
    echo "$diff_out" | sed 's/^/  /'
    echo ""
    echo "  These are deliberately duplicated modules (issue #241) — see"
    echo "  docs/11-risks-and-technical-debt/README.md for the twin-file"
    echo "  relationship this gate enforces. Reconcile the copies so they"
    echo "  match again, or update the pair table above if this rename"
    echo "  is intentional."
    fails=$((fails + 1))
  fi
done <<< "$pairs"

if [ "$fails" -gt 0 ]; then
  echo ""
  echo "check-python-twins: FAILED — $fails/$count pair(s) drifted."
  exit 1
fi

echo "check-python-twins: OK ($count pairs)"
exit 0

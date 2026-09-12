#!/usr/bin/env bash
# =============================================================================
# check-env-var-docs.sh — keep the production env-var matrix honest (#242)
#
# The 2026-07 audit (#201) found its sharpest failure in this exact space: a
# production environment variable that lived in exactly one file, with no
# document mapping which runtime read it from where, so a change landed in
# whichever file the author had open. The env-var matrix in
# docs/07-deployment-view/what-is-live.md is now that map. This gate keeps
# it current: every variable name declared in the three production config
# sources (`.deploy.env.example`, `.env.production.example`,
# `docker-compose.prod.yml`) must appear in the matrix's env-var **table** —
# a `|` row carrying the name in backticks, the shape a real matrix row
# has — or the gate fails with the name and the source it came from.
# (Mentioned in the page's prose alone does not count: a prose mention
# carries no "where set" / "unset means" columns, which is the point.)
#
# One direction only, on purpose: the matrix may document a variable no
# current source sets (e.g. `DUCKDB_PATH`, whose Docker value comes from the
# image's own ENV), but a source may never carry a variable the matrix has
# never heard of.
#
# Pure grep/sed/sort/awk — no docker or python needed, so it runs in
# .husky/pre-push on any contributor machine, like the other guard scripts.
# =============================================================================
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

MATRIX="docs/07-deployment-view/what-is-live.md"

note() { printf '  %s\n' "$*"; }

for src in .deploy.env.example .env.production.example docker-compose.prod.yml; do
  if [ ! -f "$src" ]; then
    echo "check-env-var-docs: FAIL — $src is missing; this gate cannot run."
    exit 1
  fi
done
if [ ! -f "$MATRIX" ]; then
  echo "check-env-var-docs: FAIL — $MATRIX is missing; it is the document this gate checks against."
  exit 1
fi

# Extract "name<TAB>source" pairs from one config source.
#   .example files: active `VAR=` lines and commented-out `# VAR=` template
#   lines — both declare variables an operator is expected to set.
#   compose: both env forms compose allows — list style (`- VAR=value`)
#   and mapping style (`VAR: value`) — plus `build.args` list entries,
#   scoped to `environment:` / `args:` blocks so unrelated YAML can't
#   false-positive.
extract_vars() { # extract_vars <file> <source-label>
  local file="$1" label="$2" pat
  if [ "$label" = "docker-compose.prod.yml" ]; then
    # `|| true`: a source with zero matching lines is a valid state, and
    # pipefail would otherwise turn a non-match exit into a script abort
    # with no output — the failure mode check-duckdb-bind-claims.sh
    # documents for its first version.
    awk -v s="$label" '
      /^[[:space:]]*(environment|args)[[:space:]]*:/ { inenv = 1; next }
      inenv {
        if ($0 ~ /^[[:space:]]*(#|$)/) next      # comment or blank line
        line = $0
        sub(/^[[:space:]]*-[[:space:]]*/, "", line)   # list bullet
        if (line ~ /^[A-Z][A-Z0-9_]*=/) {
          name = line; sub(/=.*/, "", name); print name "\t" s
        } else if (line ~ /^[A-Z][A-Z0-9_]*[[:space:]]*:/) {
          name = line; sub(/[[:space:]]*:.*$/, "", name); print name "\t" s
        } else inenv = 0                          # block ended
      }
    ' "$file" 2>/dev/null || true
  else
    pat='^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*='
    grep -oE "$pat" "$file" 2>/dev/null \
      | sed -E 's/^[^A-Z]*//; s/=$//' \
      | awk -v s="$label" '{print $0 "\t" s}' || true
  fi
  return 0
}

TAB="$(printf '\t')"
pairs="$(
  {
    extract_vars .deploy.env.example '.deploy.env.example'
    extract_vars .env.production.example '.env.production.example'
    extract_vars docker-compose.prod.yml 'docker-compose.prod.yml'
  } | sort -u -t "$TAB" -k1,1 | awk -F "$TAB" '!seen[$1]++'
)"

if [ -z "$pairs" ]; then
  echo "check-env-var-docs: FAIL — no env vars extracted from the three sources."
  echo "  All three files exist, so a zero result means their format changed;"
  echo "  update this gate's extract_vars() deliberately rather than ship blind."
  exit 1
fi

fail=0
total=0
while IFS="$TAB" read -r name source; do
  [ -n "$name" ] || continue
  total=$((total + 1))
  # A `|` row inside the "Environment variable matrix" section must carry
  # the name in backticks — the shape a real matrix row has. Checking the
  # whole file would accept a mention in the page's prose (or in the
  # *runtime* matrix above), which is exactly the "no row, no where-set"
  # state this gate exists to catch. Backtick is 0x60; the %c form keeps
  # this portable across awk flavours.
  if awk -v n="$name" '
      BEGIN { bt = sprintf("%c", 96) }
      /^## / { insec = ($0 == "## Environment variable matrix") }
      insec && /^\|/ && index($0, bt n bt) { found = 1; exit }
      END { exit found ? 0 : 1 }
    ' "$MATRIX" >/dev/null; then
    note "OK   $name"
  else
    note "FAIL $name (declared in $source) has no row in the $MATRIX env-var matrix."
    note "     Add a row — or extend an existing row — for it, including which"
    note "     runtime(s) read it and what leaving it unset means."
    fail=1
  fi
done <<EOF
$pairs
EOF

if [ "$fail" = "1" ]; then
  echo "check-env-var-docs: FAILED — see above."
  exit 1
fi
echo "check-env-var-docs: OK — all $total production env vars are named in $MATRIX."

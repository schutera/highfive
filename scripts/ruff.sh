#!/usr/bin/env bash
# ruff.sh — locate a working ruff and forward "$@" to it.
#
# `ruff` is frequently not on PATH on Windows: `pip install ruff` puts
# ruff.exe in Python's Scripts\ directory, which isn't on PATH by
# default, so a bare `ruff` invocation fails in the pre-commit hook (see
# docs/troubleshooting.md's "ruff: command not found" entry). Wrapping
# the lookup here means `.lintstagedrc.json` never has to assume `ruff`
# resolves on a fresh clone.
#
# Same functional-probe discipline as scripts/check-duckdb-bind-claims.sh
# (#270): never trust `command -v` alone — on Windows it can match a
# zero-byte Python-launcher stub that "exists" but does not run.
# Candidates are accepted only after actually invoking them and checking
# the exit code.

set -uo pipefail

# Deliberately does NOT cd to the repo root: lint-staged passes absolute
# paths, but a human running `bash ../scripts/ruff.sh check app.py` from a
# service directory passes a relative one, and a cd would break it. Ruff
# resolves the root ruff.toml by walking up from each file it is given, so
# the working directory does not matter for config discovery.

# 1) A real `ruff` binary on PATH.
if command -v ruff >/dev/null 2>&1 && ruff --version >/dev/null 2>&1; then
  exec ruff "$@"
fi

# 2) Fall back to `<interpreter> -m ruff`, trying each candidate
#    interpreter in turn and accepting only one that can actually run
#    the ruff module.
#    The interpreter list itself lives in scripts/lib/python.sh (#273) so all
#    three probing scripts agree; the extra requirement here is that the
#    interpreter can also import ruff, so each candidate is tried against
#    `-m ruff` rather than reusing resolve_python's plain import check.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/python.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"

for cand in "${PYTHON_CANDIDATES[@]}"; do
  read -ra try <<<"$cand"
  if "${try[@]}" -m ruff --version >/dev/null 2>&1; then
    exec "${try[@]}" -m ruff "$@"
  fi
done

echo "ruff.sh: FAIL — no working ruff found (checked: ruff on PATH, then" >&2
echo "  -m ruff under each of: $(python_candidates_tried))." >&2
echo "  Install the pinned version: pip install -r duckdb-service/requirements-dev.txt" >&2
exit 1

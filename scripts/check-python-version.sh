#!/usr/bin/env bash
# Enforce a single authoritative Python version across the repo — the
# root-cause fix for #197 (the runtime was named three disagreeing ways:
# container 3.12, deploy-docs 3.11, prod host 3.10) and the incident
# behind it (#180, a 3.11-only `datetime.UTC` that crashed both Python
# services because CI/containers ran a different version than the host).
# Run from `make check-python-version`, the husky pre-push hook, and the
# `python-version-consistency` CI job.
#
# The single source of truth is /.python-version (the floor, e.g. 3.10).
# This guard asserts every MACHINE-READABLE surface that, if it drifts,
# actually ships or breaks:
#   * image-service/Dockerfile.dev  FROM line  → python:<floor>-slim
#   * duckdb-service/Dockerfile.dev FROM line  → python:<floor>-slim
#   * image-service/pyproject.toml  ruff target-version → py<floor>
#   * .github/workflows tests.yml   each pytest matrix floor → '<floor>'
#
# Out of scope by design: prose docs and the *historical* mentions of
# 3.11/3.12 in ADR-029 and chapter 11 (which legitimately narrate the
# past drift) are review-gated, not grep-gated — a literal-version grep
# would false-positive on the very lessons that explain the fix.
#
# Rationale + the floor's wheel-resolution constraints: ADR-029. To raise
# the floor, bump /.python-version and reconcile the surfaces this script
# names — it will tell you exactly which ones disagree.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

version_file=".python-version"
if [[ ! -f "$version_file" ]]; then
  echo "check-python-version: FAIL — $version_file is missing (the single source of truth)."
  exit 1
fi

floor="$(tr -d '[:space:]' < "$version_file")"
if [[ ! "$floor" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "check-python-version: FAIL — $version_file must contain a bare X.Y version, got: '$floor'."
  exit 1
fi
ruff_target="py${floor//./}"   # 3.10 → py310

fails=()

# --- Dockerfiles: FROM python:<floor>-slim ---------------------------------
for df in image-service/Dockerfile.dev duckdb-service/Dockerfile.dev; do
  if [[ ! -f "$df" ]]; then
    fails+=("$df: missing (expected a Python service Dockerfile)")
    continue
  fi
  from_line="$(grep -m1 -E '^FROM[[:space:]]+python:' "$df" || true)"
  expected="FROM python:${floor}-slim"
  if [[ "$from_line" != "$expected" ]]; then
    fails+=("$df: FROM line is '${from_line:-<none>}', expected '$expected'")
  fi
done

# --- image-service ruff target-version: py<floor> --------------------------
pyproject="image-service/pyproject.toml"
if [[ ! -f "$pyproject" ]]; then
  fails+=("$pyproject: missing (expected the image-service ruff config)")
elif ! grep -qE "^[[:space:]]*target-version[[:space:]]*=[[:space:]]*\"${ruff_target}\"" "$pyproject"; then
  got="$(grep -E '^[[:space:]]*target-version[[:space:]]*=' "$pyproject" || echo '<none>')"
  fails+=("$pyproject: ruff target-version is '${got}', expected 'target-version = \"${ruff_target}\"'")
fi

# --- CI matrices: each pytest matrix floor (first/lowest entry) == floor ----
workflow=".github/workflows/tests.yml"
if [[ ! -f "$workflow" ]]; then
  fails+=("$workflow: missing (expected the CI workflow with the pytest matrix)")
else
  # The floor is the LOWEST version in each matrix, found with a version-
  # aware sort (sort -V) rather than by trusting the array to be authored
  # low→high — a reordered-but-equivalent matrix must not false-trip, and a
  # matrix whose true minimum dropped below the floor must not pass. min ==
  # floor also guarantees the floor is actually an element of the matrix.
  mapfile -t matrix_lines < <(grep -nE 'python-version:[[:space:]]*\[' "$workflow")
  if [[ ${#matrix_lines[@]} -eq 0 ]]; then
    fails+=("$workflow: no 'python-version: [ ... ]' matrix found (expected duckdb-unit + image-unit)")
  else
    for entry in "${matrix_lines[@]}"; do
      lineno="${entry%%:*}"
      # Anchor to the bracketed list so a trailing same-line comment that
      # mentions a version (e.g. `[...]  # was 3.9`) can't skew the floor.
      list="$(echo "$entry" | grep -oE '\[[^]]*\]')"
      min="$(echo "$list" | grep -oE '[0-9]+\.[0-9]+' | sort -V | head -1)"
      if [[ "$min" != "$floor" ]]; then
        fails+=("$workflow:$lineno: matrix floor (lowest version) is '${min:-<none>}', expected '$floor'")
      fi
    done
  fi
fi

if [[ ${#fails[@]} -gt 0 ]]; then
  echo "check-python-version: FAIL — surfaces disagree with $version_file ($floor):"
  echo ""
  for f in "${fails[@]}"; do
    echo "  - $f"
  done
  echo ""
  echo "  /.python-version is the single source of truth (#197, ADR-029)."
  echo "  Reconcile each surface above to $floor (ruff: $ruff_target), or — if you"
  echo "  intend to move the floor — bump /.python-version and update them together."
  exit 1
fi

echo "check-python-version: OK — Dockerfiles, ruff floor, and CI matrices all match $version_file ($floor)."
exit 0

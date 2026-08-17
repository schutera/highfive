#!/usr/bin/env bash
# =============================================================================
# check-duckdb-bind-claims.sh — keep docs honest about the duckdb-service bind
#
# The dev and prod stacks bind duckdb-service's host port DIFFERENTLY, on
# purpose:
#   * prod (docker-compose.prod.yml) → 127.0.0.1:8002, because host-Nginx
#     proxies the only two paths the fleet needs (/new_module, /heartbeat).
#   * dev  (docker-compose.yml)      → 8002 on all interfaces, because there
#     is no Nginx in dev and the LAN-dev firmware posts straight at
#     http://<DEV_SERVER_HOST>:8002 (baked by ESP32-CAM/extra_scripts.py).
#
# The 2026-07 audit (#203) matched dev to prod, which broke ESP registration
# and heartbeat on every bench, and shipped docs asserting the ESP never talks
# to duckdb-service directly. The revert then missed a contradicting sentence
# in auth.md, costing a second review round. `make check-citations` proves a
# citation RESOLVES; nothing proved a sentence was still TRUE.
#
# This gate is narrow on purpose: it asserts the two compose files still say
# what the docs describe, so the next person to "harden" the dev bind has to
# confront the firmware dependency instead of discovering it from a silent
# fleet.
# =============================================================================
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

fail=0
note() { printf '  %s\n' "$*"; }

# --- 1. prod MUST stay loopback-bound ---------------------------------------
if grep -qE "^\s*-\s*'127\.0\.0\.1:8002:8000'" docker-compose.prod.yml; then
  note "OK   docker-compose.prod.yml binds duckdb-service to 127.0.0.1:8002"
else
  note "FAIL docker-compose.prod.yml no longer binds duckdb-service to 127.0.0.1:8002."
  note "     Production relies on this + the host-Nginx proxy for /new_module"
  note "     and /heartbeat. If this is intentional, update"
  note "     docs/07-deployment-view/production-deployment.md and"
  note "     docs/08-crosscutting-concepts/auth.md in the same change."
  fail=1
fi

# --- 2. dev MUST NOT be loopback-bound --------------------------------------
if grep -qE "^\s*-\s*'127\.0\.0\.1:8002:8000'" docker-compose.yml; then
  note "FAIL docker-compose.yml binds duckdb-service to 127.0.0.1 — this breaks"
  note "     ESP32-CAM registration and heartbeat on every dev bench."
  note "     ESP32-CAM/extra_scripts.py bakes"
  note "     HF_INIT_URL_DEFAULT=http://<DEV_SERVER_HOST>:8002/new_module into"
  note "     every LAN-dev build, and client.cpp reuses it for /heartbeat."
  note "     Dev has no Nginx to proxy those paths the way prod does."
  note "     See docs/11-risks-and-technical-debt/ 'Hardening dev to match prod'."
  fail=1
else
  note "OK   docker-compose.yml keeps duckdb-service LAN-reachable for the fleet"
fi

# --- 3. no doc may claim BOTH files are loopback-bound ----------------------
# Catches the exact stale sentence that survived the revert.
if matches="$(grep -rniE "both compose files.{0,60}127\.0\.0\.1:8002|dev matched to prod" docs/ 2>/dev/null)"; then
  note "FAIL a doc still claims dev and prod share the loopback bind:"
  printf '%s\n' "$matches" | sed 's/^/       /'
  fail=1
else
  note "OK   no doc claims both compose files bind loopback"
fi

if [ "$fail" = "1" ]; then
  echo "check-duckdb-bind-claims: FAILED — see above."
  exit 1
fi
echo "check-duckdb-bind-claims: OK — dev/prod binds and their docs agree."

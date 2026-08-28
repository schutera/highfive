#!/usr/bin/env bash
# =============================================================================
# check-duckdb-bind-claims.sh — keep the duckdb-service host bind honest
#
# The dev and prod stacks bind duckdb-service's host port DIFFERENTLY, on
# purpose:
#   * prod (docker-compose.prod.yml) → 127.0.0.1:8002, because host-Nginx
#     proxies the only two paths the fleet needs (/new_module, /heartbeat).
#   * dev  (docker-compose.yml)      → 8002 on ALL interfaces, because there
#     is no Nginx in dev and the LAN-dev firmware posts straight at
#     http://<DEV_SERVER_HOST>:8002 (baked by ESP32-CAM/extra_scripts.py's
#     HF_INIT_URL_DEFAULT, and reused for /heartbeat by client.cpp).
#
# The 2026-07 audit (#203) matched dev to prod, which silently broke ESP
# registration and heartbeat on every bench. See
# docs/11-risks-and-technical-debt/ "Hardening dev to match prod".
#
# WHY `docker compose config` AND NOT grep: the first cut of this gate matched
# the literal single-quoted `'127.0.0.1:8002:8000'`. Review defeated it in one
# keystroke — switching dev to DOUBLE quotes reintroduced the exact regression
# and the gate still said OK, while a quote-style change in prod made it fail
# on an unchanged bind. Deleting the mapping outright also passed. Asking
# compose to resolve the file removes quoting, short-vs-long syntax, and
# variable interpolation from the picture entirely: we assert on the parsed
# `host_ip`, which is the thing that actually decides who can reach the port.
# =============================================================================
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 1

if ! docker compose version >/dev/null 2>&1; then
  echo "check-duckdb-bind-claims: SKIP — docker compose not available here."
  echo "  This gate resolves the compose files rather than grepping them, so it"
  echo "  needs the CLI. CI (ubuntu-latest) always has it."
  exit 0
fi

# Interpreter probe: one candidate list and one functional check for the whole
# repo, in scripts/lib/python.sh (#273). Both rules that matter -- probe by
# executing rather than by `command -v`, and try `py -3` first -- are explained
# there rather than restated here, so they cannot drift apart again.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/python.sh
. "$repo_root/scripts/lib/python.sh"

if ! resolve_python; then
  echo "check-duckdb-bind-claims: SKIP — no working python interpreter found."
  echo "  Tried: $(python_candidates_tried). Each was absent or failed to run"
  echo "  (on Windows, python3.exe is often the Store alias stub — see"
  echo "  docs/troubleshooting.md)."
  exit 0
fi

# `published` for the 8002 mapping, printed as "<host_ip>" or "MISSING".
# HIGHFIVE_API_KEY is a dummy: docker-compose.prod.yml uses `:?` interpolation
# that would otherwise abort `config` on a machine without .env.production.
bind_host_ip() { # bind_host_ip <compose-file>
  local rendered
  # `|| true` so a compose validation error surfaces as PARSE-ERROR below
  # rather than killing the script via `set -e` + pipefail with no output at
  # all — which is what the first version did, reporting nothing and exiting 0.
  rendered="$(
    HIGHFIVE_API_KEY="${HIGHFIVE_API_KEY:-dummy-for-config-parse}" \
    docker compose -f "$1" config --format json 2>/dev/null || true
  )"
  if [ -z "$rendered" ]; then
    printf 'PARSE-ERROR'
    return 0
  fi
  printf '%s' "$rendered" | "${PYTHON[@]}" -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    print("PARSE-ERROR"); raise SystemExit(0)
svc = (doc.get("services") or {}).get("duckdb-service") or {}
for p in svc.get("ports") or []:
    if str(p.get("published")) == "8002":
        # An absent host_ip means "all interfaces" — compose reports 0.0.0.0.
        print(p.get("host_ip") or "0.0.0.0")
        break
else:
    print("MISSING")
'
}

fail=0
note() { printf '  %s\n' "$*"; }

# docker-compose.yml declares `env_file: - .env`, and compose refuses to render
# a file whose env_file is missing. `.env` is gitignored, so it exists on a
# developer box and NOT on a CI runner — which is exactly how this gate passed
# locally and failed on its first CI run. Provide a throwaway one, and remove
# only what we created so a real `.env` is never touched.
CREATED_ENV=0
# `return 0` is load-bearing: an EXIT trap whose last command fails sets the
# script's exit status, so the bare `[ … ] && rm` form here made the gate exit
# 1 whenever there was nothing to clean up — i.e. on every developer machine
# that HAS a .env. It passed when run interactively and failed under the
# pre-push hook, which is a maddening way to spend ten minutes.
cleanup() {
  if [ "$CREATED_ENV" = "1" ]; then rm -f "$repo_root/.env"; fi
  return 0
}
trap cleanup EXIT
if [ ! -f "$repo_root/.env" ]; then
  : > "$repo_root/.env"
  CREATED_ENV=1
fi

prod_ip="$(bind_host_ip docker-compose.prod.yml)"
dev_ip="$(bind_host_ip docker-compose.yml)"

case "$prod_ip" in
  127.0.0.1)
    note "OK   prod binds duckdb-service to 127.0.0.1:8002" ;;
  PARSE-ERROR)
    note "FAIL could not parse docker-compose.prod.yml — fix the file or this gate."
    fail=1 ;;
  MISSING)
    note "FAIL docker-compose.prod.yml no longer publishes 8002 at all."
    note "     host-Nginx proxies /new_module and /heartbeat to 127.0.0.1:8002;"
    note "     removing the mapping breaks the fleet in production."
    fail=1 ;;
  *)
    note "FAIL prod publishes 8002 on '$prod_ip', not 127.0.0.1."
    note "     duckdb-service is the sole DB writer with unauthenticated"
    note "     internal routes (DELETE /modules/:id …). Production must not"
    note "     expose it beyond loopback — see ADR-001 and auth.md."
    fail=1 ;;
esac

case "$dev_ip" in
  0.0.0.0)
    note "OK   dev keeps duckdb-service LAN-reachable for the fleet" ;;
  PARSE-ERROR)
    note "FAIL could not parse docker-compose.yml — fix the file or this gate."
    fail=1 ;;
  MISSING)
    note "FAIL docker-compose.yml does not publish 8002."
    note "     Dropping the mapping is a legitimate choice on an untrusted"
    note "     network, but it means NO ESP can register or heartbeat against"
    note "     this stack — the LAN-dev firmware has no other route in. If that"
    note "     is intended, say so in docs/07-deployment-view/docker-compose.md"
    note "     and relax this gate deliberately rather than by accident."
    fail=1 ;;
  127.0.0.1)
    note "FAIL dev binds duckdb-service to 127.0.0.1 — this breaks ESP32-CAM"
    note "     registration and heartbeat on every dev bench."
    note "     ESP32-CAM/extra_scripts.py bakes"
    note "     HF_INIT_URL_DEFAULT=http://<DEV_SERVER_HOST>:8002/new_module into"
    note "     every LAN-dev build, and client.cpp reuses it for /heartbeat."
    note "     Dev has no Nginx to proxy those paths the way prod does."
    note "     See docs/11-risks-and-technical-debt/ 'Hardening dev to match prod'."
    fail=1 ;;
  *)
    note "FAIL dev publishes 8002 on unexpected host_ip '$dev_ip'."
    fail=1 ;;
esac

if [ "$fail" = "1" ]; then
  echo "check-duckdb-bind-claims: FAILED — see above."
  exit 1
fi
echo "check-duckdb-bind-claims: OK — dev is LAN-reachable, prod is loopback-only."

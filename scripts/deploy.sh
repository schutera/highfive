#!/usr/bin/env bash
# =============================================================================
# scripts/deploy.sh — HiveHive auto-deploy driver
#
# Run by the highfive-deploy.timer systemd unit (every 2 min). Pulls
# origin/production (the gated release branch — see BRANCH below and #152),
# rebuilds ONLY what changed, reloads the affected pm2 services, health-checks,
# and rolls back to the previous version on any failure. For firmware-source
# changes it auto-bumps SEQUENCE + codename and publishes the OTA (test-gated:
# native unit tests + cross-compile must pass first, or the fleet keeps its
# current firmware). Sends a Discord notification on every real deploy.
#
# Design notes:
#   * Idempotent + timer-safe: flock-guarded, exits SILENTLY when production
#     is unchanged (the 99% case — no Discord spam).
#   * "Fail gracefully": services are built BEFORE anything live is touched and
#     only reloaded after a green build; a post-reload health failure rolls the
#     working tree + build artifacts back to PREV_SHA and reloads again, so the
#     OLD version keeps running.
#   * Firmware is published LAST — only after the services are live and healthy,
#     because it is the one irreversible step. A broken/failing build never
#     reaches the field (old manifest stays served). Once a *good* manifest is
#     published the fleet pulls it: forward-only OTA has NO field rollback.
#   * Never force-pushes; never bypasses hooks. `git reset --hard` only ever
#     targets PREV_SHA (our own pre-deploy snapshot), never a remote rewrite.
#
# Config: /var/www/highfive/.deploy.env (gitignored, chmod 600). See
#   .deploy.env.example. DISCORD_WEBHOOK_URL unset => notifications log locally
#   only (the deploy still runs).
# =============================================================================
set -euo pipefail

REPO="/var/www/highfive"
ENV_FILE="$REPO/.deploy.env"
LOCK="/tmp/highfive-deploy.lock"
LOGDIR="$REPO/logs"
AUTOLOG="$LOGDIR/auto-deploy.log"
DEPLOYLOG="$LOGDIR/deploy.log"
# Services + firmware deploy from the gated `production` branch (#152). `main` is
# the integration line; a release is `git push origin <sha>:production` (a
# fast-forward), which this timer then deploys. Firmware OTA bumps + prod-* tags
# ride this branch too — see docs/07-deployment-view/firmware-release.md.
BRANCH="production"

DUCKDB_BASE="http://127.0.0.1:8000"
IMAGE_BASE="http://127.0.0.1:4444"
HEALTH_BACKEND="http://127.0.0.1:3001/api/health"
HEALTH_DUCKDB="$DUCKDB_BASE/health"
HEALTH_IMAGE="$IMAGE_BASE/health"
HEALTH_HOMEPAGE="https://highfive.schutera.com/"

# Firmware codename pool (bee common-names). pick_codename() skips any already
# used as a firmware VERSION (git history), a prod-* tag, or a live fw_version
# in duckdb. Keep these distinct from past codenames.
CODENAME_POOL=(ivy polyester alkali resin pantaloon fairy orchid shaggy furrow \
  sharptail mourning vernal nomad bloodbee reedbee maskedbee plumed teddybear \
  bluebanded neoncuckoo sugarbag oilbee dwarfbee giantbee violetbee hairyfooted \
  flatback goldenbee silverbee ashybee)

# ---------------------------------------------------------------------------
# Logging + notification
# ---------------------------------------------------------------------------
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$AUTOLOG" >&2; }

# notify <status: success|fail|firmware> <title> <body>
notify() {
  local status="$1" title="$2" body="$3" color
  case "$status" in
    success)  color=3066993 ;;   # green
    fail)     color=15158332 ;;  # red
    firmware) color=15844367 ;;  # orange (fleet OTA — irreversible)
    *)        color=9807270 ;;
  esac
  log "NOTIFY[$status] $title :: ${body//$'\n'/ | }"
  [ -z "${DISCORD_WEBHOOK_URL:-}" ] && return 0
  python3 - "$DISCORD_WEBHOOK_URL" "$title" "$body" "$color" <<'PY' || log "WARN: Discord POST failed"
import json, sys, urllib.request
url, title, body, color = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
payload = {"embeds": [{"title": title[:256], "description": body[:4000],
           "color": color, "footer": {"text": "highfive auto-deploy"}}]}
req = urllib.request.Request(url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=15).read()
PY
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
changed_match() { printf '%s\n' "$CHANGED" | grep -qE "$1"; }

health_ok() { # health_ok <url> ; retries up to ~20s
  local url="$1" i
  for i in $(seq 1 10); do
    curl -fsS --max-time 5 "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

manifest_field() { # manifest_field <dir> <key> ; reads <dir>/firmware.json
  python3 -c "import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2],''))
except Exception: print('')" "$REPO/$1/firmware.json" "$2"
}
served_field() { manifest_field homepage/dist "$1"; }   # what's live now
built_field()  { manifest_field homepage/public "$1"; }  # what build.sh just made

reload_services() { local p; for p in $1; do [ -n "$p" ] && pm2 reload "$p" --update-env >/dev/null 2>&1 || true; done; }

# ---------------------------------------------------------------------------
# Rollback: restore the pre-deploy snapshot so the OLD version keeps running.
# (Only reachable before firmware publish — firmware is the last, irreversible step.)
# ---------------------------------------------------------------------------
rollback() {
  local reason="$1"
  log "ROLLBACK: $reason — restoring $PREV_SHA"
  [ -d "$REPO/backend/dist.bak" ] && { rm -rf "$REPO/backend/dist"; mv "$REPO/backend/dist.bak" "$REPO/backend/dist"; }
  [ -d "$REPO/homepage/dist.old" ] && { rm -rf "$REPO/homepage/dist"; mv "$REPO/homepage/dist.old" "$REPO/homepage/dist"; }
  git reset --hard "$PREV_SHA" >/dev/null 2>&1 || true
  reload_services "$RELOADED"
  if health_ok "$HEALTH_BACKEND"; then
    notify fail "Deploy FAILED — rolled back" "$reason"$'\n'"Restored $PREV_SHA; old version is running and healthy."
  else
    notify fail "Deploy FAILED — rollback health ALSO failing" "$reason"$'\n'"Restored $PREV_SHA but $HEALTH_BACKEND is not 200 — NEEDS A HUMAN."
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# Firmware: pick a non-colliding codename
# ---------------------------------------------------------------------------
pick_codename() {
  local used cand
  used="$(
    { git log --all --pretty=%H -- ESP32-CAM/VERSION 2>/dev/null | while read -r s; do git show "$s:ESP32-CAM/VERSION" 2>/dev/null; done
      git tag -l 'prod-*' | sed 's/^prod-//'
      curl -fsS --max-time 8 "$DUCKDB_BASE/heartbeats_summary" 2>/dev/null | python3 -c "import json,sys
try:
  d=json.load(sys.stdin).get('summary',{})
  print('\n'.join({(m.get('fw_version') or '') for m in d.values()}))
except Exception: pass"
    } | tr -d '[:space:]' | sort -u
  )"
  for cand in "${CODENAME_POOL[@]}"; do
    printf '%s\n' "$used" | grep -qxF "$cand" || { echo "$cand"; return 0; }
  done
  return 1  # pool exhausted
}

# publish_firmware <served_seq> : bump VERSION/SEQUENCE, build, validate, publish
# into the LIVE dist (manifest last), commit+push the bump, tag. Echoes a status
# note on stdout; returns non-zero on failure (caller keeps the old manifest).
publish_firmware() {
  local served_seq="$1" tree_seq new_seq new_ver served_ver cur_ver m_ver m_seq m_size
  tree_seq="$(tr -d '[:space:]' < ESP32-CAM/SEQUENCE)"
  served_ver="$(served_field version)"
  new_seq="$tree_seq"; [ "$(( served_seq + 1 ))" -gt "$new_seq" ] && new_seq="$(( served_seq + 1 ))"
  cur_ver="$(tr -d '[:space:]' < ESP32-CAM/VERSION)"
  if [ -n "$cur_ver" ] && [ "$cur_ver" != "$served_ver" ]; then
    new_ver="$cur_ver"                       # respect a human-supplied codename
  else
    new_ver="$(pick_codename)" || { log "ERR: codename pool exhausted"; return 1; }
  fi
  log "firmware: publishing $new_ver/seq$new_seq (was $served_ver/$served_seq)"
  printf '%s' "$new_ver" > ESP32-CAM/VERSION
  printf '%s' "$new_seq" > ESP32-CAM/SEQUENCE
  if ! bash ESP32-CAM/build.sh >/dev/null 2>&1; then
    log "ERR: build.sh failed"; git checkout -- ESP32-CAM/VERSION ESP32-CAM/SEQUENCE; return 1
  fi
  m_ver="$(built_field version)"; m_seq="$(built_field sequence)"; m_size="$(built_field app_size)"
  if [ "$m_ver" != "$new_ver" ] || [ "$m_seq" != "$new_seq" ] || ! [ "${m_size:-0}" -gt 0 ] 2>/dev/null; then
    log "ERR: built manifest invalid ($m_ver/$m_seq/$m_size)"; git checkout -- ESP32-CAM/VERSION ESP32-CAM/SEQUENCE; return 1
  fi
  # atomic publish into the live dist: payload first, manifest LAST
  cp -a homepage/public/firmware.bin homepage/public/firmware.app.bin homepage/dist/
  cp -a homepage/public/firmware.json homepage/dist/
  git add ESP32-CAM/VERSION ESP32-CAM/SEQUENCE
  git commit -q -m "chore(esp): auto-bump firmware to $new_ver / sequence $new_seq" \
    -m "Published by scripts/deploy.sh (test-gated). app_md5 $(built_field app_md5)." \
    -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  PREV_SHA="$(git rev-parse HEAD)"   # a later step must never git-reset away a live OTA
  if git push --quiet origin "$BRANCH" && git tag -a "prod-$new_ver" -m "auto OTA $new_ver/seq$new_seq" && git push --quiet origin "prod-$new_ver"; then
    notify firmware "FLEET OTA PUBLISHED: $new_ver / seq$new_seq" "Forward-only, NO field rollback. app_size $m_size. Devices flip on next daily reboot. Tag prod-$new_ver. NOTE: bump committed to $BRANCH only — MERGE it back to main now (git checkout main; git merge origin/$BRANCH; git push origin main) or the next promotion won't fast-forward. See ADR-028 (a cherry-pick will NOT work)."
  else
    notify firmware "FLEET OTA PUBLISHED (bump push FAILED)" "$new_ver/seq$new_seq is LIVE in the manifest, but pushing the bump to $BRANCH failed — $BRANCH is out of sync, reconcile by hand (and merge the bump back to main)."
  fi
  echo "published $new_ver/seq$new_seq"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  mkdir -p "$LOGDIR"
  cd "$REPO"
  # shellcheck disable=SC1090
  if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

  local cur_branch; cur_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$cur_branch" != "$BRANCH" ]; then log "skip: on '$cur_branch', not '$BRANCH'"; exit 0; fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    notify fail "Deploy BLOCKED — dirty working tree" "Uncommitted tracked changes in $REPO; auto-deploy won't touch them. Resolve by hand."
    exit 1
  fi

  git fetch --quiet origin "$BRANCH"
  PREV_SHA="$(git rev-parse HEAD)"
  local REMOTE_SHA; REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
  [ "$PREV_SHA" = "$REMOTE_SHA" ] && exit 0   # silent no-op (the common tick)

  local started; started="$(date -u +%s)"
  log "new commits $PREV_SHA..$REMOTE_SHA — deploying"
  local author subjects
  subjects="$(git log --pretty='%h %s' "$PREV_SHA..$REMOTE_SHA")"
  author="$(git log -1 --pretty='%an' "$REMOTE_SHA")"

  if ! git pull --ff-only --quiet origin "$BRANCH"; then
    notify fail "Deploy BLOCKED — $BRANCH not fast-forwardable" "origin/$BRANCH diverged from local. A release must be a fast-forward of production onto a main commit; reconcile by hand."
    exit 1
  fi
  CHANGED="$(git diff --name-only "$PREV_SHA..HEAD")"
  RELOADED=""

  # snapshot for rollback
  rm -rf "$REPO/backend/dist.bak" "$REPO/homepage/dist.old" "$REPO/homepage/dist.new"
  [ -d "$REPO/backend/dist" ] && cp -a "$REPO/backend/dist" "$REPO/backend/dist.bak"

  local actions="" HOMEPAGE_REBUILT=0

  # ---- build phase (no live mutation) ---------------------------------------
  if changed_match '^backend/|^contracts/'; then
    log "building backend"
    changed_match '^backend/package-lock\.json$' && npm --prefix backend ci >/dev/null 2>&1
    npm --prefix backend run build >/dev/null 2>&1 || rollback "backend build (tsc) failed"
    actions+="backend "; RELOADED+="highfive-api "
  fi
  if changed_match '^homepage/|^contracts/'; then
    log "building homepage -> dist.new"
    changed_match '^homepage/package-lock\.json$' && npm --prefix homepage ci >/dev/null 2>&1
    ( cd homepage && npx tsc && npx vite build --outDir dist.new ) >/dev/null 2>&1 || rollback "homepage build failed"
    [ -f "$REPO/homepage/dist.new/index.html" ] || rollback "homepage dist.new missing index.html"
    HOMEPAGE_REBUILT=1; actions+="homepage "
  fi
  changed_match '^duckdb-service/' && { RELOADED+="duckdb-service "; actions+="duckdb-service "; }
  changed_match '^image-service/'  && { RELOADED+="image-service ";  actions+="image-service "; }

  # ---- reload + health (live mutation begins; firmware NOT yet touched) ------
  if [ "$HOMEPAGE_REBUILT" = "1" ]; then
    mv "$REPO/homepage/dist" "$REPO/homepage/dist.old"
    mv "$REPO/homepage/dist.new" "$REPO/homepage/dist"
  fi
  reload_services "$RELOADED"
  sleep 3
  changed_match '^backend/|^contracts/' && { health_ok "$HEALTH_BACKEND" || rollback "backend health failed after reload"; }
  changed_match '^duckdb-service/'      && { health_ok "$HEALTH_DUCKDB"  || rollback "duckdb-service health failed after reload"; }
  changed_match '^image-service/'       && { health_ok "$HEALTH_IMAGE"   || rollback "image-service health failed after reload"; }
  [ "$HOMEPAGE_REBUILT" = "1" ] && { health_ok "$HEALTH_HOMEPAGE" || rollback "homepage health (https) failed after swap"; }

  # ---- firmware phase (LAST — irreversible; only after services are healthy) -
  local fw_action="none" fw_note=""
  if [ "${FIRMWARE_AUTO_OTA:-0}" = "1" ]; then
    local tree_seq served_seq fw_src=0
    tree_seq="$(tr -d '[:space:]' < ESP32-CAM/SEQUENCE)"
    served_seq="$(served_field sequence)"; served_seq="${served_seq:-0}"
    changed_match '^ESP32-CAM/(src|lib|include|partitions|sdkconfig)|^ESP32-CAM/[^/]*\.ino$|^ESP32-CAM/platformio\.ini$|^ESP32-CAM/build\.sh$' && fw_src=1
    if [ "$fw_src" = "1" ] || { [ "$tree_seq" -gt "$served_seq" ]; } 2>/dev/null; then
      log "firmware change detected — native test gate (pio test -e native)"
      if ! ( cd ESP32-CAM && pio test -e native ) >/dev/null 2>&1; then
        fw_action="skipped"; fw_note="native tests FAILED — OTA NOT published; fleet stays on $(served_field version)/$served_seq"
        notify fail "Firmware tests FAILED — OTA skipped" "$fw_note"
      elif fw_note="$(publish_firmware "$served_seq")"; then
        fw_action="published"
      else
        fw_action="skipped"; fw_note="build/publish failed — fleet stays on $(served_field version)/$served_seq"
      fi
    fi
  fi

  # ---- success: bookkeeping + notify ----------------------------------------
  rm -rf "$REPO/backend/dist.bak" "$REPO/homepage/dist.old"
  local new_sha dur; new_sha="$(git rev-parse HEAD)"; dur=$(( $(date -u +%s) - started ))
  [ -z "$actions" ] && actions="(no service rebuild — docs/firmware/other)"
  printf '%s deployed auto (%s) -- %s; firmware=%s %s; %ds\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$new_sha" "$actions" "$fw_action" "$fw_note" "$dur" >> "$DEPLOYLOG"
  notify success "Deploy OK (${dur}s)" "Range $PREV_SHA..$new_sha by $author"$'\n'"Rebuilt: $actions"$'\n'"Firmware: $fw_action $fw_note"$'\n\n'"$subjects"
  log "deploy complete in ${dur}s"
}

# flock so a long build never overlaps the next timer tick; main() wrapped so a
# mid-run git pull of this file can't corrupt the executing logic.
exec 9>"$LOCK"
flock -n 9 || exit 0
main "$@"

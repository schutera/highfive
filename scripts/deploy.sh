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
#   * "Fail gracefully": services are built before being reloaded, and a
#     post-reload health failure rolls the working tree + build artifacts back
#     to PREV_SHA and reloads again, so the OLD version keeps running.
#     CAVEAT: dependency installs are not artifact-swappable. `npm ci` wipes and
#     reinstalls node_modules in place (rollback() reinstalls the previous
#     lockfile), and `pip install` mutates the shared system site-packages and
#     is NOT reverted on rollback — pip upgrades are forward-only.
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
# Records the SHA of a deploy that failed, so the 2-minute timer does not
# retry a known-broken commit (and re-wipe node_modules) forever.
FAILED_MARKER="$LOGDIR/last-failed-sha"
# One-shot marker so the wrong-branch alert fires once per wrong branch, not
# once every two minutes. Cleared as soon as the checkout matches BRANCH.
BRANCH_MARKER="$LOGDIR/branch-mismatch-notified"
# Services + firmware deploy from the gated `production` branch (#152). `main` is
# the integration line; a release is `git push origin <sha>:production` (a
# fast-forward), which this timer then deploys. Firmware OTA bumps + prod-* tags
# ride this branch too — see docs/07-deployment-view/firmware-release.md.
#
# NOTE the host-side precondition below: main() exits early when the checkout is
# not ON this branch, so until the prod host runs `git checkout production` this
# script no-ops on every tick.
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
  local url="$1"
  for _ in $(seq 1 10); do
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

reload_services() {
  local p
  for p in $1; do
    [ -z "$p" ] && continue
    # A failed reload is logged, not swallowed: "process or namespace not
    # found" is a real state on this host (the runbook's ecosystem template
    # registers only highfive-api), and silently succeeding on it is how a
    # deploy reports green while a service was never restarted.
    pm2 reload "$p" --update-env >/dev/null 2>&1 || log "WARN: pm2 reload '$p' failed (not registered?)"
  done
}

# Append to RELOADED without duplicating — several gates can select the same
# pm2 app (a backend change AND a dependency change both need highfive-api).
add_reload() { case " $RELOADED " in *" $1 "*) ;; *) RELOADED+="$1 " ;; esac; }

# ---------------------------------------------------------------------------
# Rollback: restore the pre-deploy snapshot so the OLD version keeps running.
# (Only reachable before firmware publish — firmware is the last, irreversible step.)
# ---------------------------------------------------------------------------
# Health endpoints matching what was actually rolled back. Probing only the
# backend and then reporting "old version is running and healthy" is the same
# report-green-without-checking mistake this script exists to avoid: rollback()
# is reachable from duckdb, image and homepage health failures, in which case
# the backend was very likely never touched and passes trivially.
rollback_health_targets() {
  local p out=""
  for p in $RELOADED; do
    case "$p" in
      highfive-api)   out+="$HEALTH_BACKEND " ;;
      duckdb-service) out+="$HEALTH_DUCKDB " ;;
      image-service)  out+="$HEALTH_IMAGE " ;;
    esac
  done
  [ "${HOMEPAGE_RESTORED:-0}" = "1" ] && out+="$HEALTH_HOMEPAGE "
  # Nothing was reloaded (e.g. a lockfile-only tick): the backend is still the
  # meaningful liveness signal, so don't return an empty list and call it green.
  [ -z "$out" ] && out="$HEALTH_BACKEND "
  printf '%s' "$out"
}

rollback() {
  local reason="$1"
  log "ROLLBACK: $reason — restoring $PREV_SHA"
  # Mark the target SHA as failed so main() does not retry it on the next tick.
  # REMOTE_SHA is `local` to main(), which is dynamically scoped here.
  if [ -n "${REMOTE_SHA:-}" ]; then
    printf '%s' "$REMOTE_SHA" > "$FAILED_MARKER" 2>/dev/null || true
  fi
  [ -d "$REPO/backend/dist.bak" ] && { rm -rf "$REPO/backend/dist"; mv "$REPO/backend/dist.bak" "$REPO/backend/dist"; }
  HOMEPAGE_RESTORED=0
  [ -d "$REPO/homepage/dist.old" ] && { rm -rf "$REPO/homepage/dist"; mv "$REPO/homepage/dist.old" "$REPO/homepage/dist"; HOMEPAGE_RESTORED=1; }
  git reset --hard "$PREV_SHA" >/dev/null 2>&1 || true
  # `npm ci` DELETES node_modules before installing, and nothing else here puts
  # it back. If the install is what failed, the tree above is restored but the
  # dependencies are wiped or half-written — and the running cluster keeps
  # answering from modules already resident in RAM, so the health check below
  # PASSES and we would report "old version is running and healthy" while the
  # host is armed to die on its next `pm2 restart` (which the documented
  # ecosystem.config.js schedules on its own via max_memory_restart).
  # Reinstall against the now-restored lockfile; if that fails too, this is not
  # a clean rollback and must not be reported as one.
  # Reinstall unconditionally when the forward install ran — BOTH failure
  # shapes need it, and an earlier "is the tree intact?" heuristic got the more
  # common one backwards:
  #   * `npm ci` itself failed  -> node_modules is wiped or partial.
  #   * `npm ci` SUCCEEDED and a later step failed -> node_modules is synced to
  #     the NEW lockfile while the tree above was just reset to PREV_SHA, so the
  #     old code would run against the new dependency set and be announced as a
  #     clean restore.
  # A redundant `npm ci` during an already-failing deploy is cheap insurance;
  # the tree/lockfile mismatch it prevents is not hypothetical.
  if [ "${NPM_CI_RAN:-0}" = "1" ]; then
    log "rollback: reinstalling node_modules against $PREV_SHA's lockfile"
    if ! ( cd "$REPO" && HUSKY=0 npm ci ) >>"$AUTOLOG" 2>&1; then
      # Reload first: the restored artifacts are on disk but not loaded, and
      # escalating without reloading would leave the failed build running while
      # telling the operator otherwise.
      reload_services "$RELOADED"
      notify fail "Deploy FAILED — rollback INCOMPLETE" "$reason"$'\n'"Tree restored to $PREV_SHA and services reloaded, but 'npm ci' also failed during rollback, so node_modules is wiped or partial. Node services will fail on their next (re)start even if they answer now. NEEDS A HUMAN — see $AUTOLOG."
      exit 1
    fi
  fi
  reload_services "$RELOADED"
  local url failed=""
  for url in $(rollback_health_targets); do
    health_ok "$url" || failed+="$url "
  done
  if [ -z "$failed" ]; then
    notify fail "Deploy FAILED — rolled back" "$reason"$'\n'"Restored $PREV_SHA; verified healthy: $(rollback_health_targets)"
  else
    notify fail "Deploy FAILED — rollback health ALSO failing" "$reason"$'\n'"Restored $PREV_SHA but these are not 200: $failed"$'\n'"NEEDS A HUMAN."
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
    notify firmware "FLEET OTA PUBLISHED: $new_ver / seq$new_seq" "Forward-only, NO field rollback. app_size $m_size. Devices flip on next daily reboot. Tag prod-$new_ver. NOTE: bump committed to $BRANCH only — MERGE it back to main -- FROM A MAINTAINER CLONE, NOT THIS HOST (git checkout main on the host would trip the branch-mismatch guard and pause every deploy): git fetch origin; git checkout main; git merge origin/$BRANCH; git push origin main. Otherwise the next promotion will not fast-forward. A cherry-pick will NOT work -- see ADR-030 and issue #225."
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
  if [ "$cur_branch" != "$BRANCH" ]; then
    # Notify ONCE, then stay quiet. Before #152 this was a bare `log` + exit 0,
    # which is fine when it never happens — but flipping BRANCH from `main` to
    # `production` makes it happen on every tick until someone runs
    # `git checkout production` on the host. A silent stop is the worst
    # possible failure here: deploys simply cease, nothing alerts, and `main`
    # keeps accumulating commits nobody notices are unshipped. The marker file
    # keeps it to one Discord message rather than one every two minutes.
    if [ ! -f "$BRANCH_MARKER" ] || [ "$(cat "$BRANCH_MARKER" 2>/dev/null)" != "$cur_branch" ]; then
      # Marker BEFORE notify: notify can fail (unwritable log + failing webhook)
      # and under `set -e` that would kill main() before the marker lands,
      # producing this alert every two minutes — exactly what it prevents.
      printf '%s' "$cur_branch" > "$BRANCH_MARKER" 2>/dev/null || true
      notify fail "Auto-deploy PAUSED — wrong branch checked out" \
        "$REPO is on '$cur_branch' but this deploy driver tracks '$BRANCH'. No deploys will run until the host is switched."$'\n\n'"ORDER MATTERS — verify the promotion FIRST, or you roll production backwards:"$'\n'"  1) git fetch origin && git show origin/$BRANCH:scripts/deploy.sh | grep '^BRANCH='"$'\n'"     -> must print BRANCH=\"$BRANCH\". If it prints \"main\", promote first:"$'\n'"        git push origin <main-sha>:$BRANCH"$'\n'"  2) cd $REPO && git fetch origin && git checkout $BRANCH && git reset --hard origin/$BRANCH"$'\n\n'"Doing (2) before (1) reverts the live services AND deletes this alert."$'\n'"See docs/07-deployment-view/production-deployment.md -> One-time cutover."
    fi
    log "skip: on '$cur_branch', not '$BRANCH'"
    exit 0
  fi
  rm -f "$BRANCH_MARKER" 2>/dev/null || true
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    notify fail "Deploy BLOCKED — dirty working tree" "Uncommitted tracked changes in $REPO; auto-deploy won't touch them. Resolve by hand."
    exit 1
  fi

  git fetch --quiet origin "$BRANCH"
  PREV_SHA="$(git rev-parse HEAD)"
  local REMOTE_SHA; REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
  [ "$PREV_SHA" = "$REMOTE_SHA" ] && exit 0   # silent no-op (the common tick)

  # Don't re-attempt a SHA that already failed. rollback() resets the tree and
  # exits, so without this the next tick two minutes later retries the identical
  # commit — forever, re-posting "NEEDS A HUMAN" each time. That was merely
  # noisy before; now that a deploy can wipe and reinstall node_modules, the
  # retry loop repeatedly tears down production's dependency tree on a host
  # that is already known-broken. Clear the marker (or push a fix) to resume.
  if [ -f "$FAILED_MARKER" ] && [ "$(cat "$FAILED_MARKER" 2>/dev/null)" = "$REMOTE_SHA" ]; then
    log "skip: $REMOTE_SHA already failed a deploy — rm $FAILED_MARKER to retry"
    exit 0
  fi

  # A new SHA is being attempted — clear any stale failure marker.
  rm -f "$FAILED_MARKER" 2>/dev/null || true
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

  # NPM_CI_RAN / PIP_FAILED are read by rollback() and the final notification.
  local actions="" HOMEPAGE_REBUILT=0
  NPM_CI_RAN=0
  PIP_FAILED=""

  # ---- build phase -----------------------------------------------------------
  # NOTE: not entirely free of live mutation any more — `npm ci` below wipes and
  # reinstalls node_modules underneath the running cluster. It is still ordered
  # before the builds and before any reload, and `rollback()` reinstalls, but
  # the old "nothing live is touched until reload" invariant no longer holds
  # here. See the header design note.
  #
  # Workspaces monorepo (contracts/backend/homepage share ONE root lockfile): a
  # new backend/homepage dependency changes the ROOT `package-lock.json`, not
  # `<pkg>/package-lock.json`, so reinstall from the root — BEFORE the builds, or
  # `tsc`/`vite` compile against missing deps and roll back (hit this with
  # rotating-file-stream, #178). `npm ci` at root installs every workspace. The
  # root `package.json` is in the gate because it declares the workspace list.
  #
  # HUSKY=0: a root `npm ci` runs the root `prepare` script, which is `husky`.
  # Installing hooks on the deploy host would point `core.hooksPath` at .husky,
  # and this script's own `git commit` in publish_firmware would then fire
  # pre-commit (lint-staged) — an unguarded call, so a hook failure kills the
  # script via errexit after firmware.json is already live, leaving a dirty
  # tree that bricks every subsequent tick on the dirty-tree check. Deploy
  # hosts do not want developer hooks.
  local NPM_DEPS_CHANGED=0
  if changed_match '^package(-lock)?\.json$|^(backend|homepage|contracts)/package\.json$'; then
    NPM_DEPS_CHANGED=1
    log "npm deps changed — root npm ci (workspaces)"
    NPM_CI_RAN=1
    actions+="npm-deps "
    # Select highfive-api for reload/health BEFORE running the install, for two
    # reasons that both bit earlier revisions of this file:
    #   1. If `npm ci` fails and calls rollback(), RELOADED would otherwise
    #      still be empty — so rollback's reload would iterate over nothing and
    #      its health probe would fall back to a backend it never restarted,
    #      reporting "verified healthy" about a process answering from RAM.
    #   2. New modules on disk do nothing for a Node process that is still
    #      holding the old module graph. Without a reload the deps never go
    #      live, and a post-install health check cannot fail.
    add_reload highfive-api
    # Output to the log, not /dev/null: this failure is FATAL and rolls back
    # production, so "root npm ci failed" without the reason is the one message
    # an operator cannot act on.
    HUSKY=0 npm ci >>"$AUTOLOG" 2>&1 || rollback "root npm ci failed (see npm output in $AUTOLOG)"
  fi
  if changed_match '^backend/|^contracts/'; then
    log "building backend"
    npm --prefix backend run build >/dev/null 2>&1 || rollback "backend build (tsc) failed"
    actions+="backend "; add_reload highfive-api
  fi
  # Rebuild the bundle when dependencies changed, not only when homepage/ did:
  # a bumped homepage dependency lands in node_modules and would otherwise stay
  # unbundled — absent from the shipped site until some unrelated homepage file
  # happens to change, while the deploy reports OK.
  if changed_match '^homepage/|^contracts/' || [ "$NPM_DEPS_CHANGED" = "1" ]; then
    log "building homepage -> dist.new"
    ( cd homepage && npx tsc && npx vite build --outDir dist.new ) >/dev/null 2>&1 || rollback "homepage build failed"
    [ -f "$REPO/homepage/dist.new/index.html" ] || rollback "homepage dist.new missing index.html"
    # The bundle inlines VITE_API_URL at build time. If the host is missing
    # homepage/.env.production the fallback in src/services/api.ts bakes in
    # http://localhost:3002/api and ships a site that cannot reach the API —
    # and the homepage health check only verifies the HTML loads, so it would
    # pass. Documented in production-runbook.md; this is the guard.
    if grep -rq "localhost:3002" "$REPO/homepage/dist.new/assets" 2>/dev/null; then
      rollback "homepage bundle points at localhost:3002 — VITE_API_URL not set on this host (see homepage/.env.production)"
    fi
    HOMEPAGE_REBUILT=1; actions+="homepage "
  fi
  # Python services run under pm2 on the system `python3` (no venv) — install new
  # deps into it BEFORE reload.
  #
  # NON-FATAL, but NOT health-gated. A genuinely-required missing module crashes
  # the reload → health fails → rollback, so that half is covered. The half that
  # is NOT: image-service imports cv2/numpy/onnxruntime under a try/except
  # (`services/hole_detection.py`'s `_RUNTIME_AVAILABLE`) and `/health` is a pure
  # liveness probe that never touches them. So a missing OPTIONAL wheel — the
  # exact case this non-fatal design exists for — leaves health green while hole
  # detection is silently dead. The health check therefore cannot be the gate;
  # instead the failure is recorded and surfaced in the final notification, so a
  # degraded deploy can never report a clean "Deploy OK".
  #
  # pip output goes to the deploy log rather than /dev/null: the failure this
  # anticipates is "no matching distribution" for a wheel that doesn't exist on
  # this interpreter, and that reason exists only in pip's stderr.
  pip_install_service() {
    local svc="$1"
    # Log which interpreter we are actually installing into. The whole step
    # assumes `python3` is the same interpreter pm2 launches the services with
    # — unverifiable from this repo. If it is not, pip SUCCEEDS, installs into
    # a site-packages nobody imports, and the fix is a silent no-op. Recording
    # it turns that assumption into something an operator can check.
    log "$svc deps changed — pip install into $(python3 -c 'import sys; print(sys.executable)' 2>/dev/null || echo 'python3 (unresolved)')"
    if ! python3 -m pip install -r "$svc/requirements.txt" >>"$AUTOLOG" 2>&1; then
      log "WARN: $svc pip install had failures (see pip output in $AUTOLOG)"
      PIP_FAILED+="$svc "
    fi
  }
  if changed_match '^duckdb-service/requirements\.txt$'; then pip_install_service duckdb-service; fi
  if changed_match '^image-service/requirements\.txt$'; then pip_install_service image-service; fi
  changed_match '^duckdb-service/' && { add_reload duckdb-service; actions+="duckdb-service "; }
  changed_match '^image-service/'  && { add_reload image-service;  actions+="image-service "; }

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
  # A lockfile-only tick replaces every dependency on disk under the running
  # cluster but matches none of the service gates above. highfive-api is added
  # to RELOADED by the npm branch, so it HAS been restarted against the new
  # modules by now and this probe is meaningful rather than a formality against
  # a process still holding the old module graph.
  if [ "$NPM_CI_RAN" = "1" ] && ! changed_match '^backend/|^contracts/'; then
    health_ok "$HEALTH_BACKEND" || rollback "backend health failed after a dependency-only npm ci"
  fi

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
  # A pip failure is non-fatal but must NOT be reported as a clean deploy: the
  # health checks cannot see a missing optional dependency (see pip_install_service),
  # so this notification is the only place it surfaces.
  if [ -n "$PIP_FAILED" ]; then
    notify fail "Deploy DEGRADED (${dur}s)" \
      "Range $PREV_SHA..$new_sha by $author"$'\n'"Built/installed: $actions"$'\n'"Firmware: $fw_action $fw_note"$'\n\n'"pip install FAILED for: $PIP_FAILED"$'\n'"Services are up and health-checked, but an optional dependency may be missing — for image-service that means hole detection is silently disabled. Health cannot detect this; read $AUTOLOG."$'\n\n'"$subjects"
    log "deploy complete in ${dur}s — DEGRADED (pip: $PIP_FAILED)"
    exit 0
  fi
  notify success "Deploy OK (${dur}s)" "Range $PREV_SHA..$new_sha by $author"$'\n'"Built/installed: $actions"$'\n'"Firmware: $fw_action $fw_note"$'\n\n'"$subjects"
  log "deploy complete in ${dur}s"
}

# flock so a long build never overlaps the next timer tick; main() wrapped so a
# mid-run git pull of this file can't corrupt the executing logic.
exec 9>"$LOCK"
flock -n 9 || exit 0
main "$@"

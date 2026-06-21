from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.connection import lock, get_conn
from db.repository import write_transaction
from models.geo import coarsen_coord
from models.module_id import ModuleId

heartbeats_bp = Blueprint("heartbeats", __name__)


def _to_int(value, default=None):
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _to_float(value, default=None):
    """Parse a possibly-missing float field from a form-encoded body.

    Mirrors `_to_int` for the heartbeat-side geolocation recovery path
    (PR II / issue #89). Empty strings / missing keys / un-parseable
    values all return `default` rather than raising — the heartbeat
    endpoint must never 500 because a single optional field is
    malformed, since the firmware fails-quiet on a non-2xx response
    and a 500 would mean the operator has to wait for the next daily
    reboot's `initNewModuleOnServer` UPSERT instead of the next
    deferred-retry's heartbeat-side patch.
    """
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _is_plausible_fix(lat, lng, acc):
    """Mirror the firmware's `hf::isPlausibleFix` rule.

    Same rule, server side: reject Null Island (0,0), reject NaN,
    reject out-of-range, reject zero/negative accuracy. The firmware
    only attaches lat/lng to a heartbeat once its own
    `hf::isPlausibleFix` has cleared the value, so this check is
    defence-in-depth against a stray manual `curl` or a future
    firmware regression. None on any field → False (missing field is
    not a fix).
    """
    if lat is None or lng is None or acc is None:
        return False
    if lat != lat or lng != lng or acc != acc:  # NaN
        return False
    if acc <= 0.0:
        return False
    if lat == 0.0 and lng == 0.0:
        return False
    if lat > 90.0 or lat < -90.0:
        return False
    if lng > 180.0 or lng < -180.0:
        return False
    return True


@heartbeats_bp.post("/heartbeat")
def post_heartbeat():
    """Tiny liveness ping from the ESP — fired hourly. Stores a row in
    module_heartbeats; the dashboard derives lastSeenAt from this table
    so a module that hasn't uploaded an image since noon still shows
    online if it's been heartbeating.

    PR II / issue #89: heartbeats may optionally carry
    `latitude`/`longitude`/`accuracy`. If the values are plausible
    AND the existing `module_configs` row for this module sits at the
    (0,0) sentinel, we UPDATE the row with the fresh fix. The
    conservative "only patch from (0,0)" rule means a deliberately-
    placed module is never clobbered by a stale firmware reading.
    """
    if request.is_json:
        data = request.get_json(silent=True) or {}
    else:
        data = request.form.to_dict()

    raw_mac = (data.get("mac") or data.get("esp_id") or "").strip()
    if not raw_mac:
        return jsonify({"error": "missing mac"}), 400
    try:
        mac = ModuleId.model_validate(raw_mac).root
    except ValidationError:
        return jsonify({"error": "invalid mac format"}), 400

    battery = _to_int(data.get("battery"))
    rssi = _to_int(data.get("rssi"))
    uptime_ms = _to_int(data.get("uptime_ms"))
    free_heap = _to_int(data.get("free_heap"))
    fw_version = (data.get("fw_version") or "")[:40] or None

    # Diagnostic fields (issue #148). Older firmware omits all three →
    # None → stored NULL, so a mixed fleet during an OTA rollout is fine.
    # `reset_reason` is the device's `resetReasonStr(esp_reset_reason())`
    # ("POWERON"/"BROWNOUT"/"TASK_WDT"/…); capped to the column width.
    # `boot_count` is the NVS-backed monotonic reboot counter.
    reset_reason = (data.get("reset_reason") or "")[:16] or None
    min_free_heap = _to_int(data.get("min_free_heap"))
    boot_count = _to_int(data.get("boot_count"))

    # Steady-state heartbeat-failure diagnostics (issue #172). The hourly
    # heartbeats fail *between* boots and never reach us (no 2xx), so the
    # fields above only ever describe the boot call. The firmware accumulates a
    # failure streak across a session and attaches it to the next 2xx heartbeat
    # — typically the boot heartbeat after a `livenessReboot`. A non-zero count
    # on an otherwise-online module is the #170 reboot-loop signature made
    # remotely visible. Older firmware omits both → None → stored NULL.
    last_hb_fail_code = _to_int(data.get("last_hb_fail_code"))
    last_hb_fail_count = _to_int(data.get("last_hb_fail_count"))

    # Stage breadcrumb on the heartbeat (issue #172, option 2). The device's
    # RTC_NOINIT breadcrumb recovered at boot, naming which long-running stage
    # was active when the previous run died. Carried on the boot heartbeat so it
    # reaches us immediately rather than waiting for the next noon image's
    # telemetry sidecar. Sent densely ("" when no breadcrumb survived) so the
    # summary ARG_MAX fold reflects the latest heartbeat; older firmware omits
    # it → None → NULL (distinct from a dense "").
    last_stage_before_reboot = (data.get("last_stage_before_reboot") or "")[:64]
    if last_stage_before_reboot == "" and "last_stage_before_reboot" not in data:
        last_stage_before_reboot = None

    # Optional geolocation-recovery fields. Absent → None → not
    # written. Present-but-implausible → silently dropped (logged
    # below for observability).
    lat = _to_float(data.get("latitude"))
    lng = _to_float(data.get("longitude"))
    acc = _to_float(data.get("accuracy"))

    print(
        f"[heartbeat] mac={mac} battery={battery} rssi={rssi} "
        f"uptime_ms={uptime_ms} free_heap={free_heap} fw={fw_version} "
        f"reset_reason={reset_reason} min_free_heap={min_free_heap} "
        f"boot_count={boot_count} "
        f"last_hb_fail_code={last_hb_fail_code} "
        f"last_hb_fail_count={last_hb_fail_count} "
        f"last_stage_before_reboot={last_stage_before_reboot}"
        + (
            f" lat={lat} lng={lng} acc={acc}"
            if (lat is not None or lng is not None)
            else ""
        )
    )

    # Stamp `received_at` explicitly in UTC so the row this writer
    # emits and the `measurements` dual-write below share the exact
    # same timestamp. Falling back to the column's
    # `DEFAULT CURRENT_TIMESTAMP` would leave the two rows millisecond-
    # apart AND latently depend on the container's local TZ (see
    # chapter 11 "`image_uploads.uploaded_at` stamped in container-local
    # time" for the analogous incident in `record_image`).
    received_at = datetime.now(timezone.utc).replace(tzinfo=None)

    # All writes in this handler share one explicit BEGIN/COMMIT via
    # `write_transaction()` (db/repository.py). That's load-bearing for
    # the dual-write to `measurements`: DuckDB autocommits each
    # `con.execute` outside a transaction, so without this the
    # `module_heartbeats` row would land even if the `measurements`
    # INSERT raised, and the cross-table joins the canonical store
    # is supposed to support would silently develop drift between the
    # two tables. PR B's senior-reviewer caught the same shape in
    # `set_display_name`'s dance — see the `write_transaction`
    # docstring for the receipts.
    with write_transaction() as con:
        con.execute(
            """
            INSERT INTO module_heartbeats
              (module_id, received_at, battery, rssi, uptime_ms, free_heap,
               fw_version, reset_reason, min_free_heap, boot_count,
               last_hb_fail_code, last_hb_fail_count, last_stage_before_reboot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                mac,
                received_at,
                battery,
                rssi,
                uptime_ms,
                free_heap,
                fw_version,
                reset_reason,
                min_free_heap,
                boot_count,
                last_hb_fail_code,
                last_hb_fail_count,
                last_stage_before_reboot,
            ],
        )

        # Dual-write into the per-module measurements store (issue
        # #110). The `measurements` table is the canonical home for
        # per-module time-series data; downstream consumers
        # (anomaly detection #116, hatching prediction #117, baseline
        # #115) read from it rather than from each producer's home
        # table. We tag `source='esp-heartbeat'` so analytics can
        # tell live samples from the one-time backfill
        # (`esp-heartbeat-backfill` in `db/schema.py`'s init block).
        #
        # Producer note: `carpenter`+ firmware OMITS the battery field
        # from the heartbeat (no ADC sensing yet), so `battery is None`
        # and this dual-write is skipped — the #110 series stays a true
        # gap, not a fabricated `random(1,100)`/0% stream that an
        # averaging read would render as a real discharge. (Older
        # firmware still sends a value and lands here.) When real sensing
        # arrives (#8a / #8b) the firmware emits genuine percentages
        # (then millivolts under a new metric) and this path resumes
        # recording them.
        if battery is not None:
            con.execute(
                """
                INSERT INTO measurements
                  (module_mac, ts, metric, value, source)
                VALUES (?, ?, 'battery_pct', ?, 'esp-heartbeat')
                """,
                [mac, received_at, float(battery)],
            )

        # Heartbeat-side geolocation patch (PR II / issue #89). Guarded
        # by:
        #  1) all three fields present + plausible (the firmware
        #     gates this; the server re-checks for safety),
        #  2) an existing module_configs row sits at the (0,0)
        #     sentinel — we never overwrite a placed module.
        # Tested via `tests/test_heartbeats_endpoint.py`. Post-#97 split:
        # we bump `updated_at` (row-metadata: the row was touched) but
        # NOT `last_seen_at` — the heartbeat itself is already recorded
        # in the dedicated `module_heartbeats` table (line 117-124
        # above), which the backend folds into `Module.lastSeenAt`
        # separately. Bumping `last_seen_at` here would double-count
        # the same liveness event.
        if _is_plausible_fix(lat, lng, acc):
            # Column names in `module_configs` are `lat`/`lng` (not
            # `latitude`/`longitude`); the contracts-layer rename to
            # `location.lat/lng` happens in the dto in
            # `backend/src/database.ts`, not in the DB.
            row = con.execute(
                "SELECT lat, lng FROM module_configs WHERE id = ?",
                [mac],
            ).fetchone()
            if row is not None:
                existing_lat = float(row[0]) if row[0] is not None else 0.0
                existing_lng = float(row[1]) if row[1] is not None else 0.0
                if existing_lat == 0.0 and existing_lng == 0.0:
                    # Generalize to ~1 km before persisting (issue #145,
                    # ADR-020). This write path does not go through the
                    # `ModuleData` model, so it must coarsen explicitly — the
                    # server is the enforcement boundary and cannot trust the
                    # firmware to have already rounded (old firmware, spoofed
                    # heartbeat). See `models/geo.py`.
                    lat = coarsen_coord(lat)
                    lng = coarsen_coord(lng)
                    con.execute(
                        "UPDATE module_configs SET lat = ?, lng = ?, "
                        "updated_at = NOW() WHERE id = ?",
                        [lat, lng, mac],
                    )
                    print(
                        f"[heartbeat] patched module_configs lat/lng for {mac} "
                        f"from (0,0) -> ({lat},{lng}) acc={acc}"
                    )

    return jsonify({"ok": True}), 200


@heartbeats_bp.get("/heartbeats/<module_id>")
def get_heartbeats(module_id):
    """Return the latest N heartbeats for a module, newest first."""
    limit = _to_int(request.args.get("limit"), default=50) or 50
    limit = max(1, min(limit, 500))

    with lock:
        con = get_conn()
        rows = con.execute(
            """
            SELECT received_at, battery, rssi, uptime_ms, free_heap, fw_version,
                   reset_reason, min_free_heap, boot_count,
                   last_hb_fail_code, last_hb_fail_count,
                   last_stage_before_reboot
              FROM module_heartbeats
             WHERE module_id = ?
             ORDER BY received_at DESC
             LIMIT ?
            """,
            [module_id, limit],
        ).fetchall()

    return jsonify(
        {
            "heartbeats": [
                {
                    "received_at": r[0].isoformat() if r[0] else None,
                    "battery": r[1],
                    "rssi": r[2],
                    "uptime_ms": r[3],
                    "free_heap": r[4],
                    "fw_version": r[5],
                    "reset_reason": r[6],
                    "min_free_heap": r[7],
                    "boot_count": r[8],
                    "last_hb_fail_code": r[9],
                    "last_hb_fail_count": r[10],
                    "last_stage_before_reboot": r[11],
                }
                for r in rows
            ]
        }
    )


# Heartbeat-gap threshold (issue #172, option 3). The steady-state heartbeat
# fires hourly, so a healthy module's consecutive `received_at` rows sit ~1 h
# apart. A gap wider than this means heartbeats stopped reaching the server —
# the device was power-/WiFi-down, hung before the send, or the call timed out
# (none of which the firmware can self-report, since a failed heartbeat never
# round-trips). 90 min = one missed hourly ping plus margin, and stays well
# under the 2 h liveness watchdog so a reboot loop's silent window surfaces as a
# gap rather than being masked by the recovery reboot.
_GAP_THRESHOLD_S = 90 * 60


@heartbeats_bp.get("/heartbeats/<module_id>/gaps")
def get_heartbeat_gaps(module_id):
    """Derived, read-only heartbeat-gap timeline for a module (issue #172,
    option 3). Computes intervals between consecutive `received_at` rows in
    `module_heartbeats` and returns those wider than `_GAP_THRESHOLD_S` — the
    server-side complement to the device-reported `last_hb_fail_*` streak: it
    surfaces the silent windows the device could NOT report (power loss, hang,
    timeout) because the heartbeat never reached us.

    Read-only: no schema, no new writer (ADR-005 keeps `module_configs`
    single-writer; this derives from the already-persisted timeline so it can
    never drift). Newest gap first.
    """
    limit = _to_int(request.args.get("limit"), default=50) or 50
    limit = max(1, min(limit, 500))

    with lock:
        con = get_conn()
        rows = con.execute(
            """
            WITH ordered AS (
                SELECT received_at,
                       LAG(received_at) OVER (ORDER BY received_at) AS prev_at
                  FROM module_heartbeats
                 WHERE module_id = ?
            )
            SELECT prev_at AS gap_start,
                   received_at AS gap_end,
                   EPOCH(received_at) - EPOCH(prev_at) AS gap_seconds
              FROM ordered
             WHERE prev_at IS NOT NULL
               AND EPOCH(received_at) - EPOCH(prev_at) > ?
             ORDER BY received_at DESC
             LIMIT ?
            """,
            [module_id, _GAP_THRESHOLD_S, limit],
        ).fetchall()

    return jsonify(
        {
            "module_id": module_id,
            "gaps": [
                {
                    "gap_start": r[0].isoformat() if r[0] else None,
                    "gap_end": r[1].isoformat() if r[1] else None,
                    "gap_seconds": int(r[2]),
                }
                for r in rows
            ],
        }
    )


@heartbeats_bp.get("/heartbeats_summary")
def get_heartbeats_summary():
    """Latest heartbeat per module — used to compute lastSeenAt on the
    /modules list endpoint without N+1 queries."""
    with lock:
        con = get_conn()
        rows = con.execute(
            """
            SELECT module_id,
                   MAX(received_at) AS last_seen,
                   ARG_MAX(battery, received_at) AS battery,
                   ARG_MAX(rssi, received_at) AS rssi,
                   ARG_MAX(uptime_ms, received_at) AS uptime_ms,
                   ARG_MAX(free_heap, received_at) AS free_heap,
                   ARG_MAX(fw_version, received_at) AS fw_version,
                   ARG_MAX(reset_reason, received_at) AS reset_reason,
                   ARG_MAX(min_free_heap, received_at) AS min_free_heap,
                   ARG_MAX(boot_count, received_at) AS boot_count,
                   ARG_MAX(last_hb_fail_code, received_at) AS last_hb_fail_code,
                   ARG_MAX(last_hb_fail_count, received_at) AS last_hb_fail_count,
                   ARG_MAX(last_stage_before_reboot, received_at)
                       AS last_stage_before_reboot
              FROM module_heartbeats
          GROUP BY module_id
            """
        ).fetchall()

    return jsonify(
        {
            "summary": {
                r[0]: {
                    "last_seen": r[1].isoformat() if r[1] else None,
                    "battery": r[2],
                    "rssi": r[3],
                    "uptime_ms": r[4],
                    "free_heap": r[5],
                    "fw_version": r[6],
                    "reset_reason": r[7],
                    "min_free_heap": r[8],
                    "boot_count": r[9],
                    "last_hb_fail_code": r[10],
                    "last_hb_fail_count": r[11],
                    "last_stage_before_reboot": r[12],
                }
                for r in rows
            }
        }
    )

from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.connection import lock, get_conn
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

    # Optional geolocation-recovery fields. Absent → None → not
    # written. Present-but-implausible → silently dropped (logged
    # below for observability).
    lat = _to_float(data.get("latitude"))
    lng = _to_float(data.get("longitude"))
    acc = _to_float(data.get("accuracy"))

    print(
        f"[heartbeat] mac={mac} battery={battery} rssi={rssi} "
        f"uptime_ms={uptime_ms} free_heap={free_heap} fw={fw_version}"
        + (
            f" lat={lat} lng={lng} acc={acc}"
            if (lat is not None or lng is not None)
            else ""
        )
    )

    with lock:
        con = get_conn()
        con.execute(
            """
            INSERT INTO module_heartbeats
              (module_id, battery, rssi, uptime_ms, free_heap, fw_version)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [mac, battery, rssi, uptime_ms, free_heap, fw_version],
        )

        # Heartbeat-side geolocation patch (PR II / issue #89). Guarded
        # by:
        #  1) all three fields present + plausible (the firmware
        #     gates this; the server re-checks for safety),
        #  2) an existing module_configs row sits at the (0,0)
        #     sentinel — we never overwrite a placed module.
        # Tested via `tests/test_heartbeats_endpoint.py`. Note that we
        # deliberately do NOT touch `module_configs.updated_at` —
        # that column has dual semantics (row metadata vs liveness),
        # see chapter-11 "updated_at semantic overload" / issue #97.
        if _is_plausible_fix(lat, lng, acc):
            # Column names in `module_configs` are `lat`/`lng` (not
            # `latitude`/`longitude`); the contracts-layer rename to
            # `location.lat/lng` happens in the dto in
            # `backend/src/database.ts`, not in the DB. Don't touch
            # `updated_at` here — it's a liveness signal (issue #97).
            row = con.execute(
                "SELECT lat, lng FROM module_configs WHERE id = ?",
                [mac],
            ).fetchone()
            if row is not None:
                existing_lat = float(row[0]) if row[0] is not None else 0.0
                existing_lng = float(row[1]) if row[1] is not None else 0.0
                if existing_lat == 0.0 and existing_lng == 0.0:
                    con.execute(
                        "UPDATE module_configs SET lat = ?, lng = ? WHERE id = ?",
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
            SELECT received_at, battery, rssi, uptime_ms, free_heap, fw_version
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
                }
                for r in rows
            ]
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
                   ARG_MAX(fw_version, received_at) AS fw_version
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
                }
                for r in rows
            }
        }
    )

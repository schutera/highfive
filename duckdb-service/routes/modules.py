from datetime import datetime, timedelta, timezone
from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.connection import lock, get_conn
from db.repository import query_all, query_scalar, query_one, write_transaction
from models.module import ModuleData
from models.module_id import ModuleId
from services.discord import send_discord_message


def _canonicalize_or_400(raw: str):
    """Normalise an inbound module-id URL param via ``ModuleId``.

    Returns the canonical 12-hex string on success, or a Flask ``(json,
    status)`` tuple on failure that the route can return verbatim.

    Pydantic v2 ``ValidationError.errors()`` includes a ``ctx`` field
    containing the underlying ``ValueError`` instance, which is not JSON
    serialisable. We strip that out before returning.
    """
    try:
        return ModuleId.model_validate(raw).root, None
    except ValidationError as e:
        cleaned = [
            {
                "msg": err.get("msg"),
                "type": err.get("type"),
                "loc": list(err.get("loc", [])),
            }
            for err in e.errors()
        ]
        return None, (
            jsonify({"error": "invalid module id", "detail": cleaned}),
            400,
        )


modules_bp = Blueprint("modules", __name__)


@modules_bp.post("/new_module")
def add_module():
    json_data = request.get_json()
    print(f"[new_module] Received: {json_data}")
    try:
        data = ModuleData(**json_data)
    except ValidationError as e:
        print(f"[new_module] Validation failed: {e}")
        # Strip Pydantic v2's ``ctx`` (which can hold an un-serialisable
        # ValueError) before returning the error list.
        cleaned = [
            {
                "msg": err.get("msg"),
                "type": err.get("type"),
                "loc": list(err.get("loc", [])),
            }
            for err in e.errors()
        ]
        return jsonify({"error": cleaned}), 400
    except Exception as e:
        print(f"[new_module] Unexpected error: {e}")
        return jsonify({"error": str(e)}), 400

    # ``data.mac`` is a ``ModuleId`` root model; unwrap to the canonical str
    # for DB writes, the Discord message, and the response body.
    mac_str = data.mac.root
    stored_name = data.module_name
    try:
        with write_transaction() as con:
            # Same-batch ESP32 firmware can generate identical default
            # names (issue #92 fixed the entropy, but operator-chosen
            # names and legacy batches can still collide). Auto-suffix
            # the firmware-reported `name` so two distinct modules never
            # show up under the same label even before an operator sets
            # `display_name`. We only suffix when the conflicting row
            # has a *different* id — re-registrations of the same
            # module keep their existing name unchanged.
            #
            # Cap at -99 so a pathological collision rate cannot run
            # away; raising at the cap surfaces the situation rather
            # than silently storing a 100th lookalike.
            stored_name = _resolve_unique_firmware_name(con, mac_str, data.module_name)
            now = datetime.now().strftime("%Y-%m-%d")
            # PR II / issue #89 follow-up: the firmware calls
            # `initNewModuleOnServer` on EVERY boot, registering at the
            # (0,0) sentinel when boot-time getGeolocation fails. The
            # original UPSERT clobbered lat/lng with EXCLUDED unconditionally,
            # which would erase a heartbeat-side-recovered location on
            # the next daily reboot whose boot fix failed. The CASE
            # below preserves the existing lat/lng iff:
            #   - the incoming row is at (0,0) (no fix this boot), AND
            #   - the existing row is NOT at (0,0) (real fix landed
            #     previously via heartbeat-side recovery OR earlier
            #     successful boot).
            # Symmetric with `routes/heartbeats.py::post_heartbeat`'s
            # "only patch from (0,0)" rule — both writers respect the
            # same invariant: a deliberately-placed module is never
            # clobbered, and a (0,0) row is patched up to a real fix
            # from either side. Pinned by
            # `test_new_module_re_registration_does_not_clobber_recovered_location`
            # in `tests/test_modules.py`.
            # `add_module` is the ONLY writer that bumps `last_seen_at` —
            # that column is the device-liveness signal the backend's
            # `fetchAndAssemble` folds into `Module.lastSeenAt` for the
            # 2 h status window (issue #97 / PR B). Every other UPDATE on
            # `module_configs` (display_name rename, heartbeat row-patch,
            # heartbeat-side geo-patch) is row-metadata and bumps only
            # `updated_at`. Re-registration is a "device was heard from"
            # event, so the UPSERT path bumps both.
            con.execute(
                """
                INSERT INTO module_configs
                    (id, name, lat, lng, first_online, battery_level, email,
                     updated_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    lat = CASE
                        WHEN EXCLUDED.lat = 0 AND EXCLUDED.lng = 0
                             AND NOT (module_configs.lat = 0 AND module_configs.lng = 0)
                        THEN module_configs.lat
                        ELSE EXCLUDED.lat
                    END,
                    lng = CASE
                        WHEN EXCLUDED.lat = 0 AND EXCLUDED.lng = 0
                             AND NOT (module_configs.lat = 0 AND module_configs.lng = 0)
                        THEN module_configs.lng
                        ELSE EXCLUDED.lng
                    END,
                    battery_level = EXCLUDED.battery_level,
                    email = EXCLUDED.email,
                    updated_at = NOW(),
                    last_seen_at = NOW()
                """,
                (
                    mac_str,
                    stored_name,
                    float(data.latitude),
                    float(data.longitude),
                    now,
                    data.battery,
                    data.email,
                ),
            )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    send_discord_message(
        f"🐝 **New Hive Module registered!**\n"
        f"**Name:** {stored_name}\n"
        f"**ID:** {mac_str}\n"
        f"**Location:** {data.latitude}, {data.longitude}\n"
        f"**Battery:** {data.battery}%"
    )
    # Echo the actually-stored name so the firmware / operator sees the
    # disambiguation when an auto-suffix fired. Pre-PR-I callers ignored
    # extra fields, so this is backward-compatible.
    return jsonify(
        {"message": "Module added successfully", "id": mac_str, "name": stored_name}
    )


def _resolve_unique_firmware_name(con, mac_str: str, requested: str) -> str:
    """Return a name that doesn't collide with another module's `name`.

    If `requested` already belongs to this `mac_str` (re-registration) or
    no other module is using it, returns `requested` unchanged. Otherwise
    appends ``-2``, ``-3``, …, ``-99`` until a free slot is found.
    Raises if the cap is reached — a collision rate this high is a bug
    worth surfacing, not silently swallowing.
    """
    existing = con.execute(
        "SELECT id FROM module_configs WHERE name = ? AND id != ?",
        (requested, mac_str),
    ).fetchone()
    if existing is None:
        return requested
    # The 100-char cap is enforced at the front door by
    # `ModuleData.module_name`'s `max_length=100` Pydantic constraint
    # (see `models/module.py`). Truncate to leave room for a `-99`
    # suffix so the resulting candidate stays within the same envelope
    # — `requested` is already ≤ 100 chars at this point.
    max_base_len = 100 - len("-99")
    base = requested[:max_base_len]
    for n in range(2, 100):
        candidate = f"{base}-{n}"
        clash = con.execute(
            "SELECT id FROM module_configs WHERE name = ? AND id != ?",
            (candidate, mac_str),
        ).fetchone()
        if clash is None:
            return candidate
    raise RuntimeError(
        f"could not find a unique name suffix for {requested!r} after 98 attempts; "
        "operator intervention required (set distinct display_name overrides)."
    )


@modules_bp.patch("/modules/<module_id>/display_name")
def set_display_name(module_id):
    """Set or clear the admin-settable display-name override.

    Body: ``{"display_name": "Garden bee #3"}`` to set, or
    ``{"display_name": null}`` to clear. Unique across `module_configs`
    (enforced by the column constraint); collisions return HTTP 409
    with the conflicting name in the response body so the caller can
    surface a useful error inline.

    No firmware-facing auth is required at this layer — the backend
    proxy gates the public-facing route with `X-Admin-Key`. duckdb-service
    routes are network-internal only (see CLAUDE.md service-map).
    """
    canonical, err = _canonicalize_or_400(module_id)
    if err is not None:
        return err

    data = request.get_json(silent=True) or {}
    if "display_name" not in data:
        return (
            jsonify({"error": "request body must include 'display_name' key"}),
            400,
        )

    raw = data["display_name"]
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        # Empty / null clears the override. Coalesce sends `null` rather
        # than empty string so SQL UNIQUE doesn't treat two cleared
        # rows as a collision (DuckDB treats NULL as distinct under
        # UNIQUE — verified manually before relying on it).
        new_value = None
    elif isinstance(raw, str):
        new_value = raw.strip()
        if len(new_value) > 100:
            return (
                jsonify({"error": "display_name exceeds 100 char limit"}),
                400,
            )
    else:
        return (
            jsonify({"error": "display_name must be a string or null"}),
            400,
        )

    # Why this route bypasses `write_transaction`. The helper issues an
    # explicit `BEGIN` to give multi-statement callers real atomicity
    # (see db/repository.py / test_write_transaction_rolls_back_partial_writes).
    # Inside an explicit transaction, DuckDB 1.4.4 (and 1.5.2, verified
    # at PR B execution) trips the FK over-enforcement on
    # `UPDATE module_configs SET display_name = ?` because the
    # transaction snapshot still "sees" the `nest_data` references —
    # even after we DELETE them in the same transaction. So the
    # only DuckDB-supported workaround for #105's bug (the temp-table
    # dance) is incompatible with the helper's BEGIN.
    #
    # The dance therefore runs in autocommit mode — each DELETE /
    # UPDATE / INSERT commits individually, which lets DuckDB's FK
    # enforcement see each statement's effect immediately and lets the
    # UPDATE proceed past the now-unreferenced parent row. Atomicity
    # is provided at the Python layer instead: on any failure we
    # restore the child rows from the in-memory snapshot before
    # re-raising. The global `lock` is held for the duration so no
    # concurrent writer can race with the half-deleted state.
    #
    # The compensating-restore approach trades full transactional
    # atomicity for a recovery semantics that's "best-effort and
    # observable": if the DELETE phase succeeds and the UPDATE then
    # fails, we re-insert the children before the operator sees the
    # error. The remaining failure-window is "DELETE succeeded,
    # UPDATE succeeded, re-insert raised partway" — recovery does a
    # DELETE-any-partial + re-insert-full-snapshot to converge.
    # Operator-visible behaviour: success returns 200; any failure
    # returns 500 AND leaves the row in its pre-dance state. See
    # chapter 11 "Admin rename failed silently on seeded modules"
    # for the full workaround discovery path.
    #
    # The DuckDB workarounds the issue's reporter suggested don't
    # exist in DuckDB:
    #   - `PRAGMA foreign_keys = OFF` is a SQLite pragma, not a
    #     DuckDB one (DuckDB returns "Catalog Error: unrecognized
    #     configuration parameter").
    #   - `ALTER TABLE nest_data DROP CONSTRAINT ...` raises
    #     `NotImplementedException: No support for that ALTER
    #     TABLE option yet`.
    #   - `INSERT INTO module_configs ... ON CONFLICT (id) DO UPDATE`
    #     hits the SAME FK over-enforcement when the SET clause
    #     touches a UNIQUE-constrained column (which `display_name`
    #     is). Verified empirically; chapter 11 has the receipts.
    #
    # Safe because:
    #   - `display_name` is a non-FK, non-PK column. The end state
    #     preserves every `nest_data.module_id → module_configs.id`
    #     reference (children re-inserted with identical `module_id`).
    #   - duckdb-service serialises writes via a global `lock` (see
    #     db/connection.py); we hold it for the whole dance, so no
    #     concurrent reader/writer sees the half-deleted state.
    #   - Bounded blast radius: only this module's children move
    #     (the `WHERE module_id = ?` filter pins it). Typical modules
    #     carry <20 nests and <200 progress rows over their lifetime.
    with lock:
        con = get_conn()
        try:
            existing = con.execute(
                "SELECT id FROM module_configs WHERE id = ?", (canonical,)
            ).fetchone()
            if not existing:
                return jsonify({"error": "Module not found"}), 404

            # Skip the UPDATE if a *different* module already holds
            # this display_name. Catching the UNIQUE-constraint
            # exception works in principle but DuckDB surfaces it
            # through a generic ConstraintException whose message
            # format isn't stable; an explicit pre-check gives a
            # clean 409 with the actual conflicting MAC.
            if new_value is not None:
                clash = con.execute(
                    "SELECT id FROM module_configs WHERE display_name = ? AND id != ?",
                    (new_value, canonical),
                ).fetchone()
                if clash is not None:
                    return (
                        jsonify(
                            {
                                "error": "display_name already in use",
                                "display_name": new_value,
                                "conflicting_module_id": clash[0],
                            }
                        ),
                        409,
                    )

            # Snapshot in dependency order so restoration can replay it.
            progress_rows = con.execute(
                """
                SELECT dp.progress_id, dp.nest_id, dp.date,
                       dp.empty, dp.sealed, dp.hatched
                  FROM daily_progress dp
                  JOIN nest_data n ON n.nest_id = dp.nest_id
                 WHERE n.module_id = ?
                """,
                (canonical,),
            ).fetchall()
            nest_rows = con.execute(
                "SELECT nest_id, module_id, beeType FROM nest_data WHERE module_id = ?",
                (canonical,),
            ).fetchall()

            def _delete_children() -> None:
                """DELETE in reverse-FK order so each statement is
                FK-clean in isolation (DuckDB checks per-statement
                in autocommit)."""
                con.execute(
                    "DELETE FROM daily_progress WHERE nest_id IN "
                    "(SELECT nest_id FROM nest_data WHERE module_id = ?)",
                    (canonical,),
                )
                con.execute(
                    "DELETE FROM nest_data WHERE module_id = ?",
                    (canonical,),
                )

            def _insert_children() -> None:
                """INSERT the snapshotted children in forward-FK
                order (nest_data before daily_progress that
                references it)."""
                for nest in nest_rows:
                    con.execute(
                        "INSERT INTO nest_data (nest_id, module_id, beeType) "
                        "VALUES (?, ?, ?)",
                        nest,
                    )
                for prog in progress_rows:
                    con.execute(
                        "INSERT INTO daily_progress "
                        "(progress_id, nest_id, date, empty, sealed, hatched) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        prog,
                    )

            def _restore_children() -> None:
                """Compensating-restore: DELETE any partial state
                from a half-finished dance, then re-INSERT the full
                snapshot. Idempotent across any intermediate state."""
                _delete_children()
                _insert_children()

            try:
                # Phase 1: DELETE children in reverse-FK order.
                _delete_children()
                # Phase 2: UPDATE the now-unreferenced parent. Bump
                # `updated_at` (row-metadata: the row was touched).
                # Do NOT bump `last_seen_at` — that column is the
                # device-liveness signal the backend's
                # `fetchAndAssemble` folds into `Module.lastSeenAt`
                # (max of last_image_at / last_seen_at /
                # latestHeartbeat.receivedAt) for the 2 h status
                # window. An admin edit of the label is not a
                # heartbeat-equivalent event; bumping `last_seen_at`
                # here would flip any renamed offline module to
                # "online" for two hours regardless of telemetry.
                # See chapter 11 "updated_at semantic overload" and
                # issue #97 for the split rationale; PR B carries
                # the fix.
                con.execute(
                    "UPDATE module_configs SET display_name = ?, "
                    "updated_at = NOW() WHERE id = ?",
                    (new_value, canonical),
                )
                # Phase 3: re-insert children.
                _insert_children()
            except Exception as dance_err:
                # Compensating action: re-establish the children
                # snapshot. The parent UPDATE may or may not have
                # landed; we leave it as-is and let the 500 surface
                # so the operator can retry. The KEY invariant we
                # restore is "no orphan or missing children".
                #
                # If the restore itself raises, the operator needs to
                # know they've lost data and should restore from
                # backup — set a flag we'll surface in the response
                # body. The 500 still fires either way; the body
                # marker is the difference between "retry the rename"
                # and "data lost; restore from backup".
                restore_failed = False
                restore_err: Exception | None = None
                try:
                    _restore_children()
                except Exception as e:
                    restore_failed = True
                    restore_err = e
                    print(
                        f"[set_display_name] CRITICAL: restore failed for "
                        f"{canonical}: {type(e).__name__}: {e}. Original "
                        f"dance error: {type(dance_err).__name__}: "
                        f"{dance_err}. nest_data + daily_progress rows "
                        f"for this module may be lost; restore from "
                        f"backup.",
                        flush=True,
                    )
                if restore_failed:
                    return (
                        jsonify(
                            {
                                "error": str(dance_err),
                                "restore_failed": True,
                                "restore_error": str(restore_err)
                                if restore_err is not None
                                else None,
                                "module_id": canonical,
                                "message": (
                                    "Rename failed AND the compensating "
                                    "restore of nest_data/daily_progress "
                                    "raised. Module child rows may be "
                                    "missing; restore from backup before "
                                    "retrying."
                                ),
                            }
                        ),
                        500,
                    )
                raise
            return (
                jsonify(
                    {
                        "id": canonical,
                        "display_name": new_value,
                        "message": "display_name updated",
                    }
                ),
                200,
            )
        except Exception as e:
            print(f"[set_display_name] {type(e).__name__}: {e}", flush=True)
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


@modules_bp.delete("/modules/<module_id>")
def delete_module(module_id):
    """Delete a module and all its related data (nests, progress, images)."""
    with lock:
        con = get_conn()
        try:
            # Check module exists
            existing = con.execute(
                "SELECT id FROM module_configs WHERE id = ?", (module_id,)
            ).fetchone()
            if not existing:
                return jsonify({"error": "Module not found"}), 404

            # Delete in order: progress -> nests -> images -> module
            con.execute(
                "DELETE FROM daily_progress WHERE nest_id IN (SELECT nest_id FROM nest_data WHERE module_id = ?)",
                (module_id,),
            )
            con.execute("DELETE FROM nest_data WHERE module_id = ?", (module_id,))
            con.execute("DELETE FROM image_uploads WHERE module_id = ?", (module_id,))
            con.execute("DELETE FROM module_configs WHERE id = ?", (module_id,))
            con.commit()
            return jsonify({"message": f"Module {module_id} deleted"}), 200
        except Exception as e:
            con.rollback()
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


@modules_bp.post("/record_image")
def record_image():
    data = request.get_json(silent=True) or {}
    raw_module_id = data.get("module_id")
    filename = data.get("filename")
    if not raw_module_id or not filename:
        return jsonify({"error": "module_id and filename required"}), 400
    canonical, err = _canonicalize_or_400(raw_module_id)
    if err is not None:
        return err
    try:
        with write_transaction() as con:
            # UTC, NOT naive-local. The `activity_timeseries` reader
            # computes its window against `datetime.now(timezone.utc)`;
            # if the writer stamps in container-local time (which is
            # what `datetime.now()` does — UTC today only because the
            # python:3.x-slim image happens to default to UTC), setting
            # `TZ=Europe/Berlin` on the container in prod would put
            # writes 1-2 hours past the reader's window upper bound.
            # The schema's `DEFAULT CURRENT_TIMESTAMP` carries the same
            # naive-local risk; chapter-11 entry to follow.
            now_utc = (
                datetime.now(timezone.utc)
                .replace(tzinfo=None)
                .strftime("%Y-%m-%d %H:%M:%S")
            )
            con.execute(
                "INSERT INTO image_uploads (module_id, filename, uploaded_at) VALUES (?, ?, ?)",
                (canonical, filename, now_utc),
            )
        return jsonify({"message": "Image recorded"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@modules_bp.delete("/image_uploads/<filename>")
def delete_image_upload(filename):
    with lock:
        con = get_conn()
        try:
            existing = con.execute(
                "SELECT filename FROM image_uploads WHERE filename = ?", (filename,)
            ).fetchone()
            if not existing:
                return jsonify({"error": "Image not found"}), 404
            con.execute("DELETE FROM image_uploads WHERE filename = ?", (filename,))
            con.commit()
            return jsonify({"message": "Image record deleted"}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


@modules_bp.get("/image_uploads")
def list_image_uploads():
    module_id = request.args.get("module_id")
    with lock:
        con = get_conn()
        try:
            if module_id:
                rows = con.execute(
                    "SELECT module_id, filename, uploaded_at FROM image_uploads WHERE module_id = ? ORDER BY uploaded_at DESC",
                    (module_id,),
                ).fetchall()
            else:
                rows = con.execute(
                    "SELECT module_id, filename, uploaded_at FROM image_uploads ORDER BY uploaded_at DESC"
                ).fetchall()
            images = [
                {"module_id": r[0], "filename": r[1], "uploaded_at": str(r[2])}
                for r in rows
            ]
            return jsonify(images=images), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


@modules_bp.get("/modules")
def get_modules():
    try:
        # Explicit column list (no `SELECT m.*`) so adding a column to
        # `module_configs` cannot silently leak through to the wire
        # shape without a deliberate edit here. The backend's
        # `ApiModule` TS interface mirrors this list. The client
        # (homepage) resolves the operator-visible label via
        # `homepage/src/lib/displayLabel.ts` — we deliberately do not
        # collapse `display_name`/`name` server-side so the admin UI
        # can show both.
        modules = query_all(
            """
            SELECT m.id, m.name, m.display_name, m.lat, m.lng, m.first_online,
                   m.battery_level, m.image_count, m.email,
                   m.updated_at, m.last_seen_at,
                   m.last_silence_alert_at,
                   COUNT(i.id) AS real_image_count,
                   MAX(i.uploaded_at) AS last_image_at
            FROM module_configs m
            LEFT JOIN image_uploads i ON m.id = i.module_id
            GROUP BY m.id, m.name, m.display_name, m.lat, m.lng, m.first_online,
                     m.battery_level, m.image_count, m.email,
                     m.updated_at, m.last_seen_at,
                     m.last_silence_alert_at
            """
        )
        return jsonify(modules=modules), 200
    except Exception as e:
        # Without this wrapper Flask serves the default HTML 500 page,
        # which the backend then JSON.parses and throws on, masking the
        # underlying DB error as a generic upstream 502 (#32). The body
        # is the error only — no `modules: []` fallback. The backend's
        # fetchAndAssemble checks `r.ok` first, so it never reads this
        # body; any other consumer that ignores the status would TypeError
        # on `data.modules.map`, which is more honest than a silent
        # empty fleet.
        print(f"[get_modules] {type(e).__name__}: {e}", flush=True)
        return jsonify(error=str(e)), 500


@modules_bp.get("/modules/<module_id>/progress_count")
def progress_count(module_id):
    canonical, err = _canonicalize_or_400(module_id)
    if err is not None:
        return err
    count = query_scalar(
        """
        SELECT COUNT(*) FROM daily_progress dp
        JOIN nest_data nd ON dp.nest_id = nd.nest_id
        WHERE nd.module_id = ?
        """,
        (canonical,),
    )
    return jsonify(count=int(count) if count is not None else 0), 200


# Bucket sizes for the activity-timeseries endpoint. Kept as a
# constant so the gap-fill loop below and the SQL `date_trunc` stay
# in sync — adding a third granularity (e.g. `weekly`) means a new
# entry here AND a matching `date_trunc` argument, both wired by
# the same `interval` query-param.
_ACTIVITY_INTERVAL_STEP = {
    "hourly": timedelta(hours=1),
    "daily": timedelta(days=1),
}


def _floor_to_interval(ts: datetime, interval: str) -> datetime:
    """Truncate ``ts`` to the start of its hour/day in UTC.

    Mirrors DuckDB's ``date_trunc('hour'|'day', ...)`` semantics so
    the gap-fill loop emits the exact same bucket-start instants the
    SQL aggregate produces. Without this, a window starting at
    12:34:56 would produce a first gap-bucket at 12:34:56 and the
    chart would see "two buckets at the same hour, one zero".
    """
    if interval == "hourly":
        return ts.replace(minute=0, second=0, microsecond=0)
    # daily
    return ts.replace(hour=0, minute=0, second=0, microsecond=0)


@modules_bp.get("/modules/<module_id>/activity_timeseries")
def activity_timeseries(module_id):
    """Bucketed image-upload counts for the dashboard weather chart.

    Query params:
      * ``interval`` — ``hourly`` (default) or ``daily``.
      * ``days``     — window size, default 7, max 90.

    Empty buckets are filled with ``count: 0`` server-side so the
    chart renders a continuous timeline instead of "stitching" across
    silent periods (which would visually misrepresent a quiet hive as
    a sudden activity spike on either side of the gap).
    """
    canonical, err = _canonicalize_or_400(module_id)
    if err is not None:
        return err

    interval = request.args.get("interval", "hourly")
    if interval not in _ACTIVITY_INTERVAL_STEP:
        return (
            jsonify(
                {
                    "error": "invalid interval",
                    "detail": "must be 'hourly' or 'daily'",
                }
            ),
            400,
        )

    days_raw = request.args.get("days", "7")
    try:
        days = int(days_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "days must be an integer"}), 400
    if days < 1 or days > 90:
        return jsonify({"error": "days must be in [1, 90]"}), 400

    if query_one("SELECT 1 FROM module_configs WHERE id = ?", (canonical,)) is None:
        return jsonify({"error": "Module not found"}), 404

    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    end = _floor_to_interval(now_utc, interval) + _ACTIVITY_INTERVAL_STEP[interval]
    start = end - timedelta(days=days)

    # `date_trunc`'s first arg cannot be a bind parameter in DuckDB
    # (it's a SQL keyword-positional, not a value). Branch in Python
    # instead — `interval` is whitelisted above so this is not a SQL
    # injection vector.
    trunc_unit = "hour" if interval == "hourly" else "day"
    # ::TIMESTAMP cast is load-bearing: `date_trunc('day', ts)` returns a
    # DATE in DuckDB (no time component), which the Python driver hands
    # back as a `datetime.date`. The dense-fill cursor below emits keys
    # like "2026-05-20T00:00:00" — `date.isoformat()` produces
    # "2026-05-20" without the `T00:00:00`, so every daily-mode lookup
    # would miss and all buckets would silently render `count: 0`.
    # date_trunc('hour', ts) already returns TIMESTAMP so the cast is a
    # no-op there; pinning both for consistency.
    rows = query_all(
        f"""
        SELECT date_trunc('{trunc_unit}', uploaded_at)::TIMESTAMP AS bucket,
               COUNT(*) AS count
        FROM image_uploads
        WHERE module_id = ? AND uploaded_at >= ? AND uploaded_at < ?
        GROUP BY bucket
        ORDER BY bucket
        """,
        (canonical, start, end),
    )

    # With the ::TIMESTAMP cast above, `bucket` is always a `datetime`
    # — but keep the defensive branch in case a future migration drops
    # the cast. `str()` of a datetime.date is "YYYY-MM-DD" which would
    # not match the dense-fill cursor's ISO keys.
    counts_by_bucket: dict[str, int] = {}
    for row in rows:
        bucket = row["bucket"]
        if isinstance(bucket, datetime):
            key = bucket.replace(tzinfo=None).isoformat()
        else:
            key = str(bucket)
        counts_by_bucket[key] = int(row["count"])

    step = _ACTIVITY_INTERVAL_STEP[interval]
    buckets: list[dict] = []
    cursor = start
    while cursor < end:
        key = cursor.isoformat()
        buckets.append({"timestamp": key, "count": counts_by_bucket.get(key, 0)})
        cursor = cursor + step

    return (
        jsonify(
            {
                "module_id": canonical,
                "interval": interval,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "buckets": buckets,
            }
        ),
        200,
    )


@modules_bp.post("/modules/<module_id>/heartbeat")
def heartbeat(module_id):
    canonical, err = _canonicalize_or_400(module_id)
    if err is not None:
        return err

    json_data = request.get_json(silent=True) or {}
    battery = json_data.get("battery")

    if (
        not isinstance(battery, int)
        or isinstance(battery, bool)
        or not (0 <= battery <= 100)
    ):
        return jsonify({"error": "battery must be an int in [0, 100]"}), 400

    if query_one("SELECT 1 FROM module_configs WHERE id = ?", (canonical,)) is None:
        return jsonify({"error": "Module not found"}), 404

    now = datetime.now().strftime("%Y-%m-%d")
    with write_transaction() as con:
        # COALESCE-guarded so the heartbeat fills `first_online` only
        # on the first NULL — `add_module` is the real writer (on
        # INSERT). The schema declares `NOT NULL`, so this branch is
        # unreachable in production but defensive against legacy /
        # manually-inserted rows. Background: issue #75.
        #
        # `updated_at` is bumped (row was touched). `last_seen_at` is
        # NOT bumped here — the legacy /modules/<id>/heartbeat route
        # records battery + image_count metadata; the new heartbeat
        # path (`heartbeats.py::post_heartbeat`) writes to the dedicated
        # `module_heartbeats` table, which the backend folds into
        # liveness separately. See issue #97 / PR B split.
        con.execute(
            """
            UPDATE module_configs
            SET battery_level = ?,
                first_online = COALESCE(first_online, ?),
                image_count = image_count + 1,
                updated_at = NOW()
            WHERE id = ?
            """,
            (battery, now, canonical),
        )
    return jsonify({"ok": True}), 200

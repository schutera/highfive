from datetime import datetime
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
    try:
        with write_transaction() as con:
            now = datetime.now().strftime("%Y-%m-%d")
            con.execute(
                """
                INSERT INTO module_configs
                    (id, name, lat, lng, first_online, battery_level, email, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    lat = EXCLUDED.lat,
                    lng = EXCLUDED.lng,
                    battery_level = EXCLUDED.battery_level,
                    email = EXCLUDED.email,
                    updated_at = NOW()
                """,
                (
                    mac_str,
                    data.module_name,
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
        f"**Name:** {data.module_name}\n"
        f"**ID:** {mac_str}\n"
        f"**Location:** {data.latitude}, {data.longitude}\n"
        f"**Battery:** {data.battery}%"
    )
    return jsonify({"message": "Module added successfully", "id": mac_str})


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
            con.execute(
                "INSERT INTO image_uploads (module_id, filename, uploaded_at) VALUES (?, ?, ?)",
                (canonical, filename, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
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
        modules = query_all(
            """
            SELECT m.*,
                   COUNT(i.id) AS real_image_count,
                   MAX(i.uploaded_at) AS last_image_at
            FROM module_configs m
            LEFT JOIN image_uploads i ON m.id = i.module_id
            GROUP BY m.id, m.name, m.lat, m.lng, m.first_online,
                     m.battery_level, m.image_count, m.email, m.updated_at,
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
        con.execute(
            """
            UPDATE module_configs
            SET battery_level = ?,
                first_online = ?,
                image_count = image_count + 1
            WHERE id = ?
            """,
            (battery, now, canonical),
        )
    return jsonify({"ok": True}), 200

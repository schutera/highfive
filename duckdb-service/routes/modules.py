from datetime import datetime
from flask import Blueprint, jsonify, request
from pydantic import ValidationError

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
                INSERT OR REPLACE INTO module_configs
                    (id, name, lat, lng, status, first_online, battery_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mac_str,
                    data.module_name,
                    float(data.latitude),
                    float(data.longitude),
                    "online",
                    now,
                    data.battery,
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


@modules_bp.get("/modules")
def get_modules():
    modules = query_all("SELECT * FROM module_configs")
    return jsonify(modules=modules), 200


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

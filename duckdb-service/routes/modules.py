from datetime import datetime
from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.repository import query_all, query_scalar, query_one, write_transaction
from models.module import ModuleData
from services.discord import send_discord_message

modules_bp = Blueprint("modules", __name__)


@modules_bp.post("/new_module")
def add_module():
    json_data = request.get_json()
    print(f"[new_module] Received: {json_data}")
    try:
        data = ModuleData(**json_data)
    except ValidationError as e:
        print(f"[new_module] Validation failed: {e}")
        return jsonify({"error": e.errors()}), 400
    except Exception as e:
        print(f"[new_module] Unexpected error: {e}")
        return jsonify({"error": str(e)}), 400

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
                    data.mac,
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
        f"**ID:** {data.mac}\n"
        f"**Location:** {data.latitude}, {data.longitude}\n"
        f"**Battery:** {data.battery}%"
    )
    return jsonify({"message": "Module added successfully", "id": data.mac})


@modules_bp.get("/modules")
def get_modules():
    modules = query_all("SELECT * FROM module_configs")
    return jsonify(modules=modules), 200


@modules_bp.get("/modules/<module_id>/progress_count")
def progress_count(module_id):
    count = query_scalar(
        """
        SELECT COUNT(*) FROM daily_progress dp
        JOIN nest_data nd ON dp.nest_id = nd.nest_id
        WHERE nd.module_id = ?
        """,
        (module_id,),
    )
    return jsonify(count=int(count) if count is not None else 0), 200


@modules_bp.post("/modules/<module_id>/heartbeat")
def heartbeat(module_id):
    json_data = request.get_json(silent=True) or {}
    battery = json_data.get("battery")

    if (
        not isinstance(battery, int)
        or isinstance(battery, bool)
        or not (0 <= battery <= 100)
    ):
        return jsonify({"error": "battery must be an int in [0, 100]"}), 400

    if query_one("SELECT 1 FROM module_configs WHERE id = ?", (module_id,)) is None:
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
            (battery, now, module_id),
        )
    return jsonify({"ok": True}), 200

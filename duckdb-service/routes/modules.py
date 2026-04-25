from datetime import datetime
from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.connection import lock, get_conn
from models.module import ModuleData
from services.discord import send_discord_message

modules_bp = Blueprint("modules", __name__)


@modules_bp.get("/initial_insert")
def initial_insert():
    try:
        with lock:
            con = get_conn()
            con.execute(
                """
                INSERT INTO module_configs (id, name, lat, lng, status, first_online) VALUES
                ('hive-001', 'Elias123',    47.8086, 9.6433, 'online',  '2023-04-15'),
                ('hive-002', 'Garten 12',   47.8100, 9.6450, 'offline', '2023-05-20'),
                ('hive-003', 'Waldrand',    47.7819, 9.6107, 'online',  '2024-03-10'),
                ('hive-004', 'Schussental', 47.7850, 9.6200, 'online',  '2024-06-01'),
                ('hive-005', 'Bergblick',   47.8050, 9.6350, 'online',  '2025-02-14');

                INSERT INTO nest_data (nest_id, module_id, beeType) VALUES
                ('nest-001', 'hive-001', 'blackmasked'),
                ('nest-002', 'hive-001', 'resin'),
                ('nest-003', 'hive-002', 'leafcutter'),
                ('nest-004', 'hive-003', 'orchard'),
                ('nest-005', 'hive-004', 'blackmasked'),
                ('nest-006', 'hive-001', 'blackmasked');

                INSERT INTO daily_progress (progress_id, nest_id, date, empty, sealed, hatched) VALUES
                ('prog-001', 'nest-001', '2024-06-01', 5, 10, 15),
                ('prog-002', 'nest-002', '2024-06-01', 3, 7, 12),
                ('prog-003', 'nest-003', '2024-06-01', 8, 5, 20),
                ('prog-004', 'nest-004', '2024-06-01', 2, 12, 18),
                ('prog-005', 'nest-005', '2024-06-01', 6, 9, 14),
                ('prog-006', 'nest-001', '2024-06-02', 4, 11, 16),
                ('prog-007', 'nest-006', '2024-06-02', 2, 8, 13);
                """
            )
            con.close()
        return jsonify(success=True), 200
    except Exception as e:
        return jsonify(error=str(e)), 400


@modules_bp.post("/test_insert")
def test_insert():
    try:
        with lock:
            con = get_conn()
            con.execute(
                """
                INSERT OR IGNORE INTO module_configs (id, name, lat, lng, status, first_online) VALUES
                ('hive-091', 'Hirrlingen', 47.8086, 9.6433, 'online', '2023-04-15');
                """
            )
            con.close()
        return jsonify(success=True), 200
    except Exception as e:
        return jsonify(error=str(e)), 400


@modules_bp.post("/remove_test")
def remove_test_insert():
    try:
        with lock:
            con = get_conn()
            con.execute("DELETE FROM module_configs WHERE id = 'hive-091';")
            con.close()
        return jsonify(success=True), 200
    except Exception as e:
        return jsonify(error=str(e)), 400


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

    with lock:
        con = get_conn()
        try:
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
            con.commit()
            send_discord_message(
                f"🐝 **New Hive Module registered!**\n"
                f"**Name:** {data.module_name}\n"
                f"**ID:** {data.mac}\n"
                f"**Location:** {data.latitude}, {data.longitude}\n"
                f"**Battery:** {data.battery}%"
            )
            return jsonify({"message": "Module added successfully", "id": data.mac})
        except Exception as e:
            con.rollback()
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


@modules_bp.get("/modules")
def get_modules():
    with lock:
        con = get_conn()
        cur = con.execute("SELECT * FROM module_configs")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        con.close()

    modules = [dict(zip(cols, row)) for row in rows]
    return jsonify(modules=modules), 200


@modules_bp.get("/modules/<module_id>/progress_count")
def progress_count(module_id):
    with lock:
        con = get_conn()
        try:
            row = con.execute(
                """
                SELECT COUNT(*) FROM daily_progress dp
                JOIN nest_data nd ON dp.nest_id = nd.nest_id
                WHERE nd.module_id = ?
                """,
                (module_id,),
            ).fetchone()
            count = int(row[0]) if row and row[0] is not None else 0
        finally:
            con.close()

    return jsonify(count=count), 200


@modules_bp.post("/modules/<module_id>/heartbeat")
def heartbeat(module_id):
    json_data = request.get_json(silent=True) or {}
    battery = json_data.get("battery")

    if (not isinstance(battery, int) or isinstance(battery, bool)
            or not (0 <= battery <= 100)):
        return jsonify({"error": "battery must be an int in [0, 100]"}), 400

    with lock:
        con = get_conn()
        try:
            existing = con.execute(
                "SELECT 1 FROM module_configs WHERE id = ?",
                (module_id,),
            ).fetchone()
            if existing is None:
                return jsonify({"error": "Module not found"}), 404

            now = datetime.now().strftime("%Y-%m-%d")
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
            con.commit()
            return jsonify({"ok": True}), 200
        finally:
            con.close()

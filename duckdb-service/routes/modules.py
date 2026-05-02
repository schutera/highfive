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
                INSERT INTO module_configs
                    (id, name, lat, lng, status, first_online, battery_level, email, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    lat = EXCLUDED.lat,
                    lng = EXCLUDED.lng,
                    status = EXCLUDED.status,
                    battery_level = EXCLUDED.battery_level,
                    email = EXCLUDED.email,
                    updated_at = NOW()
                """,
                (
                    data.mac,
                    data.module_name,
                    float(data.latitude),
                    float(data.longitude),
                    "online",
                    now,
                    data.battery,
                    data.email,
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
    data = request.get_json()
    module_id = data.get("module_id")
    filename = data.get("filename")
    if not module_id or not filename:
        return jsonify({"error": "module_id and filename required"}), 400
    with lock:
        con = get_conn()
        try:
            con.execute(
                "INSERT INTO image_uploads (module_id, filename, uploaded_at) VALUES (?, ?, ?)",
                (module_id, filename, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            )
            con.commit()
            return jsonify({"message": "Image recorded"}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


@modules_bp.post("/update_module_status")
def update_module_upload():
    data = request.get_json()
    module_id = data.get("module_id")
    battery = data.get("battery")
    if not module_id or battery is None:
        return jsonify({"error": "module_id and battery required"}), 400
    with lock:
        con = get_conn()
        try:
            con.execute(
                """
                UPDATE module_configs
                SET battery_level = ?,
                    image_count = image_count + 1
                WHERE id = ?
                """,
                (int(battery), module_id),
            )
            con.commit()
            return jsonify({"message": "Module updated"}), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


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
            images = [{"module_id": r[0], "filename": r[1], "uploaded_at": str(r[2])} for r in rows]
            return jsonify(images=images), 200
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            con.close()


@modules_bp.get("/modules")
def get_modules():
    with lock:
        con = get_conn()
        cur = con.execute(
            """
            SELECT m.*,
                   COUNT(i.id) AS real_image_count,
                   MAX(i.uploaded_at) AS last_image_at
            FROM module_configs m
            LEFT JOIN image_uploads i ON m.id = i.module_id
            GROUP BY m.id, m.name, m.lat, m.lng, m.status, m.first_online,
                     m.battery_level, m.image_count, m.email, m.updated_at,
                     m.last_silence_alert_at
            """
        )
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        con.close()

    modules = [dict(zip(cols, row)) for row in rows]
    return jsonify(modules=modules), 200

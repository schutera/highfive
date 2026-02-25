import os
import threading
import duckdb
from flask import Flask, jsonify, request
from flask import request, jsonify
from pydantic import BaseModel, ValidationError
from datetime import datetime, date

from typing import Dict
from pydantic import BaseModel
from uuid import uuid4

app = Flask(__name__)

DB_PATH = os.getenv("DUCKDB_PATH", "./data/app.duckdb")
if not os.path.exists(os.path.dirname(DB_PATH)):
    os.makedirs(os.path.dirname(DB_PATH))
lock = threading.Lock()


def get_conn():
    return duckdb.connect(DB_PATH)


# --- DB INIT (läuft beim Start einmal) ---
def init_db():
    with lock:
        con = get_conn()
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS module_configs (
            id VARCHAR(20) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            lat DECIMAL(9,6) NOT NULL,
            lng DECIMAL(9,6) NOT NULL,
            status VARCHAR(10) NOT NULL CHECK (status IN ('online', 'offline')),
            first_online DATE NOT NULL,
            battery_level INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nest_data(
        nest_id VARCHAR(20) NOT NULL PRIMARY KEY,
        module_id VARCHAR(20) NOT NULL REFERENCES module_configs(id),
        beeType VARCHAR(20) CHECK (beeType IN ('blackmasked', 'resin', 'leafcutter', 'orchard'))
        );

        CREATE TABLE IF NOT EXISTS daily_progress (
        progress_id VARCHAR(20) PRIMARY KEY,
        nest_id VARCHAR(20) NOT NULL REFERENCES nest_data(nest_id),
        date DATE NOT NULL,
        empty INTEGER NOT NULL,
        sealed INTEGER NOT NULL,
        hatched INTEGER NOT NULL
        );
        """
        )
        con.close()


init_db()
# -----------------------------------------


@app.get("/health")
def health():
    return jsonify(ok=True, db=DB_PATH), 200


# Hier noch Logik
# @app.post("/query")
# def query():
#     payload = request.get_json(silent=True) or {}
#     sql = payload.get("sql")

#     if not sql:
#         return jsonify(error="Missing sql"), 400

#     try:
#         with lock:
#             con = get_conn()
#             cur = con.execute(sql)
#             cols = [d[0] for d in cur.description] if cur.description else []
#             rows = cur.fetchall() if cur.description else []
#             con.close()

#         return jsonify(columns=cols, rows=rows), 200

# except Exception as e:
#     return jsonify(error=str(e)), 400

# INSERT INTO module_configs (id, name, lat, lng, status, first_online) VALUES
# ('hive-001', 'Elias123', 47.8086, 9.6433, 'online',  '2023-04-15'),
# ('hive-002', 'Garten 12',   47.8100, 9.6450, 'offline', '2023-05-20'),
# ('hive-003', 'Waldrand',      47.7819, 9.6107, 'online',  '2024-03-10'),
# ('hive-004', 'Schussental',   47.7850, 9.6200, 'online',  '2024-06-01'),
# ('hive-005', 'Bergblick',     47.8050, 9.6350, 'online',  '2025-02-14');


@app.get("/initial_insert")
def initial_insert():
    try:
        with lock:
            con = get_conn()
            con.execute(
                """
                INSERT INTO module_configs (id, name, lat, lng, status, first_online) VALUES
                ('hive-001', 'Elias123', 47.8086, 9.6433, 'online',  '2023-04-15'),
                ('hive-002', 'Garten 12',   47.8100, 9.6450, 'offline', '2023-05-20'),
                ('hive-003', 'Waldrand',      47.7819, 9.6107, 'online',  '2024-03-10'),
                ('hive-004', 'Schussental',   47.7850, 9.6200, 'online',  '2024-06-01'),
                ('hive-005', 'Bergblick',     47.8050, 9.6350, 'online',  '2025-02-14');

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
                ('prog-007', 'nest-006', '2024-06-02', 2, 8, 13),

                """
            )
            con.close()
        return jsonify(success=True), 200
    except Exception as e:
        return jsonify(error=str(e)), 400


@app.post("/test_insert")
def test_insert():
    try:
        with lock:
            con = get_conn()
            con.execute(
                """
                INSERT or IGNORE INTO module_configs (id, name, lat, lng, status, first_online) VALUES
                ('hive-091', 'Hirrlingen', 47.8086, 9.6433, 'online',  '2023-04-15');
                """
            )
            con.close()
        return jsonify(success=True), 200
    except Exception as e:
        return jsonify(error=str(e)), 400


@app.post("/remove_test")
def remove_test_insert():
    try:
        with lock:
            con = get_conn()
            con.execute(
                """
                DELETE FROM module_configs WHERE id = 'hive-091';
                """
            )
            con.close()
        return jsonify(success=True), 200
    except Exception as e:
        return jsonify(error=str(e)), 400



class ModuleData(BaseModel):
    esp_id: str
    module_name: str
    latitude: float
    longitude: float
    battery_level: int

from flask import request, jsonify
from datetime import datetime
from pydantic import ValidationError
from threading import Lock

lock = Lock()

@app.post("/new_module")
def add_module():
    try:
        json_data = request.get_json()
        data = ModuleData(**json_data)
    except ValidationError as e:
        return jsonify({"error": e.errors()}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    with lock:
        con = None
        try:
            con = get_conn()
            cur = con.cursor()

            now = datetime.now().isoformat()

            # Delete any existing row with same id (upsert behavior)
            cur.execute("DELETE FROM module_configs WHERE id = ?", (data.esp_id,))

            # Insert new row
            cur.execute("""
                INSERT INTO module_configs (id, name, lat, lng, status, first_online, battery_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                data.esp_id,
                data.module_name,
                data.latitude,
                data.longitude,
                "online",
                now,
                data.battery_level
            ))

            con.commit()
            return jsonify({
                "message": "Module added successfully",
                "id": data.esp_id
            })
        except Exception as e:
            if con:
                con.rollback()
            return jsonify({"error": str(e)}), 500

        except duckdb.Error as e:
            return jsonify({"error": str(e)}), 500

        finally:
            if con:
                con.close()

@app.get("/modules")
def get_modules():
    with lock:
        con = get_conn()
        cur = con.execute("SELECT * FROM module_configs")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        con.close()

    modules = [dict(zip(cols, row)) for row in rows]
    return jsonify(modules=modules), 200


@app.get("/nests")
def get_nests():
    with lock:
        con = get_conn()
        cur = con.execute("SELECT * FROM nest_data")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        con.close()

    nests = [dict(zip(cols, row)) for row in rows]
    return jsonify(nests=nests), 200


@app.get("/progress")
def get_progress():
    with lock:
        con = get_conn()
        cur = con.execute("SELECT * FROM daily_progress")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        con.close()

    progress = [dict(zip(cols, row)) for row in rows]
    return jsonify(progress=progress), 200


class ClassificationOutput(BaseModel):
    modul_id: str
    classification: Dict[str, Dict[int, int]]


# Mapping Payload -> DB BeeType
beeType_map = {
    "black_masked_bee": "blackmasked",
    "leafcutter_bee": "leafcutter",
    "orchard_bee": "orchard",
    "resin_bee": "resin",
}

# Ziel: 3 Nester pro BeeType, 12 Nester pro Modul
TARGET_NESTS_PER_TYPE = 3


@app.post("/add_progress_for_module")
def add_progress_for_module():
    json_data = request.get_json()
    payload = ClassificationOutput(**json_data)
    modul_id = payload.modul_id

    with lock:
        con = get_conn()
        today = date.today().isoformat()

        try:
            for bee_type_payload, sealed_values in payload.classification.items():
                db_bee_type = beeType_map.get(bee_type_payload)
                if db_bee_type is None:
                    continue

                # Vorhandene Nester für Modul + BeeType
                existing_nests = con.execute(
                    "SELECT nest_id FROM nest_data WHERE module_id = ? AND beeType = ? ORDER BY nest_id",
                    (modul_id, db_bee_type),
                ).fetchall()
                existing_nest_ids = [row[0] for row in existing_nests]

                # Fehlende Nester erstellen
                while len(existing_nest_ids) < TARGET_NESTS_PER_TYPE:
                    # Neue nest_id generieren (z.B. nest-007, nest-008...)
                    max_id_row = con.execute(
                        "SELECT MAX(CAST(SUBSTR(nest_id, 6) AS INTEGER)) FROM nest_data"
                    ).fetchone()
                    next_id = (max_id_row[0] or 0) + 1
                    new_nest_id = f"nest-{str(next_id).zfill(3)}"

                    con.execute(
                        "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
                        (new_nest_id, modul_id, db_bee_type),
                    )
                    existing_nest_ids.append(new_nest_id)

                # Progress eintragen
                # Payload gibt sealed-Werte für die Nester an; falls weniger als TARGET_NESTS_PER_TYPE, wiederhole letzte
                sealed_list = list(sealed_values.values())
                while len(sealed_list) < TARGET_NESTS_PER_TYPE:
                    sealed_list.append(sealed_list[-1])  # letzte wiederholen

                for nest_id, sealed in zip(existing_nest_ids, sealed_list):
                    empty = 0
                    sealed_val = int(sealed * 100)
                    hatched = 0
                    con.execute(
                        """
                        INSERT INTO daily_progress
                        (progress_id, nest_id, date, empty, sealed, hatched)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (str(uuid4()), nest_id, today, empty, sealed_val, hatched),
                    )

            con.commit()
            return {"success": True}

        finally:
            con.close()


if __name__ == "__main__":
    debug = os.getenv("DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=8000, debug=debug)

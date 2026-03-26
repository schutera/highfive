from datetime import date
from uuid import uuid4
from flask import Blueprint, jsonify, request

from db.connection import lock, get_conn
from models.progress import ClassificationOutput, BEE_TYPE_MAP, TARGET_NESTS_PER_TYPE

progress_bp = Blueprint("progress", __name__)


@progress_bp.get("/progress")
def get_progress():
    with lock:
        con = get_conn()
        cur = con.execute("SELECT * FROM daily_progress")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        con.close()

    progress = [dict(zip(cols, row)) for row in rows]
    return jsonify(progress=progress), 200


@progress_bp.post("/add_progress_for_module")
def add_progress_for_module():
    json_data = request.get_json()
    payload = ClassificationOutput(**json_data)
    modul_id = payload.modul_id

    with lock:
        con = get_conn()
        today = date.today().isoformat()

        try:
            for bee_type_payload, sealed_values in payload.classification.items():
                db_bee_type = BEE_TYPE_MAP.get(bee_type_payload)
                if db_bee_type is None:
                    continue

                # Get existing nests for this module + bee type
                existing_nests = con.execute(
                    "SELECT nest_id FROM nest_data WHERE module_id = ? AND beeType = ? ORDER BY nest_id",
                    (modul_id, db_bee_type),
                ).fetchall()
                existing_nest_ids = [row[0] for row in existing_nests]

                # Create missing nests up to target count
                while len(existing_nest_ids) < TARGET_NESTS_PER_TYPE:
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

                # Insert progress entries
                sealed_list = list(sealed_values.values())
                while len(sealed_list) < TARGET_NESTS_PER_TYPE:
                    sealed_list.append(sealed_list[-1])

                for nest_id, sealed in zip(existing_nest_ids, sealed_list):
                    sealed_val = int(sealed * 100)
                    con.execute(
                        """
                        INSERT INTO daily_progress
                            (progress_id, nest_id, date, empty, sealed, hatched)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (str(uuid4()), nest_id, today, 0, sealed_val, 0),
                    )

            con.commit()
            return {"success": True}

        finally:
            con.close()

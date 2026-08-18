from datetime import date, datetime
from uuid import uuid4
from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.repository import query_all, write_transaction
from models.module_id import ModuleId
from models.progress import ClassificationOutput, BEE_TYPE_MAP, TARGET_NESTS_PER_TYPE

progress_bp = Blueprint("progress", __name__)

# Safety valve, not pagination: callers pass `limit` to bound a worst-case
# response; the query keeps the MOST RECENT rows and the response stays
# date-ascending (see the ordering note below). 2026-07 audit, for #205.
_LIMIT_CAP = 100_000


def _parse_iso_date(raw: str, field: str):
    """Parse `YYYY-MM-DD` identically on every Python in the CI matrix.

    (Zero-padding is not enforced — `2026-7-9` is accepted — but it is
    accepted the same way on 3.10 and on 3.14, which is the point.)

    Deliberately `strptime` and not `date.fromisoformat`: fromisoformat
    widened in 3.11 to accept the basic form (`20260719`) and ISO week dates
    (`2026-W29-1`). This repo's CI matrix spans 3.10-3.14 (ADR-029), so the
    same query string would 400 on 3.10 and 200 on 3.12 — a behaviour
    difference that depends on the interpreter, not the request, and that no
    test would catch unless it happened to run on both. strptime's grammar is
    identical across all five.
    """
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date(), None
    except ValueError:
        return None, (
            jsonify({"error": f"'{field}' is not a valid ISO date (YYYY-MM-DD)"}),
            400,
        )


@progress_bp.get("/progress")
def get_progress():
    """List daily_progress rows, optionally filtered (for #205).

    Query params (all optional; unfiltered call = legacy full table):
      * ``module_id`` — canonical or legacy MAC form; filters via nest_data.
      * ``since`` / ``until`` — inclusive ISO date bounds on ``date``.
      * ``limit`` — keep only the most recent N rows (capped).

    Ordering contract: rows are returned **date-ascending** (ties broken
    by nest_id). This is load-bearing — `backend/src/database.ts`'s
    `totalHatches` roll-up reads each nest's LAST array element as the
    latest row, so `limit` trims the oldest rows, never the newest.
    """
    where, params = [], []

    module_raw = request.args.get("module_id")
    if module_raw is not None:
        try:
            module_id = ModuleId.model_validate(module_raw).root
        except ValidationError:
            return jsonify({"error": "invalid module_id format"}), 400
        where.append("nest_id IN (SELECT nest_id FROM nest_data WHERE module_id = ?)")
        params.append(module_id)

    for field, op in (("since", ">="), ("until", "<=")):
        raw = request.args.get(field)
        if raw is not None:
            parsed, err = _parse_iso_date(raw, field)
            if err:
                return err
            where.append(f"date {op} ?")
            params.append(parsed.isoformat())

    limit_raw = request.args.get("limit")
    limit = None
    if limit_raw is not None:
        # try/except, not isdigit(): str.isdigit() accepts Unicode
        # superscripts ("³") that int() then rejects — which would be
        # exactly the malformed-input 500 this route change eliminates.
        try:
            limit = int(limit_raw)
        except ValueError:
            return jsonify({"error": "'limit' must be a positive integer"}), 400
        if limit < 1:
            return jsonify({"error": "'limit' must be a positive integer"}), 400
        limit = min(limit, _LIMIT_CAP)

    clause = f" WHERE {' AND '.join(where)}" if where else ""
    if limit is None:
        sql = f"SELECT * FROM daily_progress{clause} ORDER BY date ASC, nest_id"
    else:
        # Keep the most recent rows, then restore ascending order.
        sql = (
            "SELECT * FROM ("
            f"SELECT * FROM daily_progress{clause} "
            "ORDER BY date DESC, nest_id LIMIT ?"
            ") ORDER BY date ASC, nest_id"
        )
        params.append(limit)

    progress = query_all(sql, tuple(params))
    return jsonify(progress=progress), 200


@progress_bp.post("/add_progress_for_module")
def add_progress_for_module():
    # Clean 400s on malformed input (for #205) — this route predated the
    # validation idiom its siblings use (see routes/measurements.py); a
    # non-JSON or schema-violating body used to raise straight to a 500.
    json_data = request.get_json(silent=True)
    if not isinstance(json_data, dict):
        return jsonify({"error": "request body must be a JSON object"}), 400
    try:
        payload = ClassificationOutput(**json_data)
    except ValidationError:
        return jsonify({"error": "invalid classification payload"}), 400
    # Pydantic ``RootModel`` exposes the underlying str via ``.root``.
    module_id = payload.module_id.root
    today = date.today().isoformat()

    with write_transaction() as con:
        for bee_type_payload, sealed_values in payload.classification.items():
            db_bee_type = BEE_TYPE_MAP.get(bee_type_payload)
            if db_bee_type is None:
                continue

            # Get existing nests for this module + bee type
            existing_nests = con.execute(
                "SELECT nest_id FROM nest_data WHERE module_id = ? AND beeType = ? ORDER BY nest_id",
                (module_id, db_bee_type),
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
                    (new_nest_id, module_id, db_bee_type),
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

    return {"success": True}

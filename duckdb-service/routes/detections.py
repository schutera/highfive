"""Per-nest hole-detection + snip persistence routes (#165).

`duckdb-service` is the sole writer (ADR-001), so the image-service posts its
detected snips here rather than opening the DB itself. Two routes:

* ``POST /record_detections`` — append one capture's per-hole detections.
* ``GET  /detections`` — read a module's *latest snip per nest* for the public
  dashboard 4x4 grid (full history is retained; this read folds to the newest).
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.repository import query_all, write_transaction
from models.module_id import ModuleId

detections_bp = Blueprint("detections", __name__)

# Valid empty/sealed states. Kept tiny and explicit so a producer typo lands as
# a 400 here rather than as a silently-unrenderable badge on the dashboard.
_VALID_STATES = {"empty", "sealed"}


def _canonicalize_or_400(raw: str):
    """Normalise an inbound module id via ``ModuleId`` (mirrors routes/modules)."""
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
        return None, (jsonify({"error": "invalid module id", "detail": cleaned}), 400)


def _bbox4(bbox) -> tuple[float, float, float, float]:
    """Coerce an inbound bbox ([x, y, w, h] or missing) to four floats."""
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        try:
            return tuple(float(v) for v in bbox)  # type: ignore[return-value]
        except (TypeError, ValueError):
            pass
    return (0.0, 0.0, 0.0, 0.0)


@detections_bp.post("/record_detections")
def record_detections():
    """Append nest-detection rows for one capture.

    Body: ``{"module_id", "filename", "detections": [{bee_type, nest_index,
    bbox:[x,y,w,h], state, confidence, snip_filename}, ...]}``. Rows with an
    invalid ``state`` are skipped (not fatal) so one bad item can't reject the
    whole capture.
    """
    data = request.get_json(silent=True) or {}
    raw_module_id = data.get("module_id")
    filename = data.get("filename")
    detections = data.get("detections")
    if not raw_module_id or not filename or not isinstance(detections, list):
        return jsonify({"error": "module_id, filename and detections[] required"}), 400
    canonical, err = _canonicalize_or_400(raw_module_id)
    if err is not None:
        return err

    now_utc = (
        datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
    )
    inserted = 0
    try:
        with write_transaction() as con:
            for det in detections:
                if not isinstance(det, dict):
                    continue
                state = det.get("state")
                snip_filename = det.get("snip_filename")
                if state not in _VALID_STATES or not snip_filename:
                    continue
                bx, by, bw, bh = _bbox4(det.get("bbox"))
                con.execute(
                    """
                    INSERT INTO nest_detections
                        (module_id, filename, bee_type, nest_index,
                         bbox_x, bbox_y, bbox_w, bbox_h,
                         state, confidence, snip_filename, detected_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        canonical,
                        filename,
                        str(det.get("bee_type", "")),
                        int(det.get("nest_index", 0) or 0),
                        bx,
                        by,
                        bw,
                        bh,
                        state,
                        float(det.get("confidence", 0.0) or 0.0),
                        str(snip_filename),
                        now_utc,
                    ),
                )
                inserted += 1
        return jsonify({"message": "Detections recorded", "inserted": inserted}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@detections_bp.get("/detections")
def list_detections():
    """Return a module's latest snip per (bee_type, nest_index).

    Full history is retained in the table; this read folds to the newest row per
    nest (``ROW_NUMBER() ... ORDER BY detected_at DESC``) so the public 4x4
    snip grid shows current state. ``id DESC`` is the stable tiebreaker for
    same-second rows, mirroring ``list_image_uploads``.

    Wire shape: ``{"detections": [{module_id, filename, bee_type, nest_index,
    bbox:[x,y,w,h], state, confidence, snip_filename, detected_at}, ...]}``.
    """
    raw_module_id = request.args.get("module_id")
    if not raw_module_id:
        return jsonify({"error": "module_id required"}), 400
    canonical, err = _canonicalize_or_400(raw_module_id)
    if err is not None:
        return err

    rows = query_all(
        """
        SELECT module_id, filename, bee_type, nest_index,
               bbox_x, bbox_y, bbox_w, bbox_h,
               state, confidence, snip_filename, detected_at
        FROM (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY bee_type, nest_index
                ORDER BY detected_at DESC, id DESC
            ) AS rn
            FROM nest_detections
            WHERE module_id = ?
        ) t
        WHERE rn = 1
        ORDER BY bee_type, nest_index
        """,
        (canonical,),
    )
    detections = [
        {
            "module_id": r["module_id"],
            "filename": r["filename"],
            "bee_type": r["bee_type"],
            "nest_index": r["nest_index"],
            "bbox": [r["bbox_x"], r["bbox_y"], r["bbox_w"], r["bbox_h"]],
            "state": r["state"],
            "confidence": r["confidence"],
            "snip_filename": r["snip_filename"],
            "detected_at": str(r["detected_at"]),
        }
        for r in rows
    ]
    return jsonify(detections=detections), 200

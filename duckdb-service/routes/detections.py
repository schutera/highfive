"""Per-nest hole-detection + snip persistence routes (#165).

`duckdb-service` is the sole writer (ADR-001), so the image-service posts its
detected snips here rather than opening the DB itself. Two routes:

* ``POST /record_detections`` — append one capture's per-hole detections.
* ``GET  /detections`` — read the per-nest snips of a module's *most recent
  capture* for the public dashboard grid (full history is retained; this read
  scopes to the latest capture and dedups to one row per nest — the real blocks
  are irregular 7/5/5/4 or 4x4, not a fixed 4x4).
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.repository import query_all, write_transaction
from models.module_id import ModuleId

detections_bp = Blueprint("detections", __name__)

# Valid snip states. Kept tiny and explicit so a producer typo lands as a skipped
# row here rather than as a silently-unrenderable badge on the dashboard.
# `undetermined` is the learned detector's localize-only state (ADR-027): the
# model finds the hole but defers the empty-vs-sealed call. Mirror the
# `NestSnip.state` union (contracts) and the backend `SNIP_STATES` guard.
_VALID_STATES = {"empty", "sealed", "undetermined"}


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
    """Return the per-nest snips from a module's **most recent capture**.

    Full history is retained in the table; this read folds in two steps so it is
    correct on *both* axes the learned detector exposes:

    1. **Latest-capture scope** — restrict to the single newest capture
       (``WITH latest`` = max ``detected_at``, ``id DESC`` tiebreaker, matched by
       ``(filename, detected_at)``). The grid reflects the *current* block: a nest
       not detected in the latest capture is simply absent, not latched to a stale
       crop from an older one. This matters because the detector's per-row hole
       count can vary by ±1 frame-to-frame — a per-(bee_type, nest_index) "latest
       snip across all captures" fold would serve a days-old crop for a nest that
       dropped out this frame.
    2. **Per-nest dedup** — ``ROW_NUMBER() ... PARTITION BY bee_type, nest_index
       ORDER BY id DESC`` keeps one row per nest. ``record_detections`` is
       append-only (no DELETE), so a re-upload of the same capture (a network
       retry) re-records its rows; without this an idempotency-breaking same-second
       retry would return two rows per nest → duplicate grid cells + React key
       collisions. Step 1 alone scopes to the capture; step 2 makes it idempotent.

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
        WITH latest AS (
            SELECT filename, detected_at
            FROM nest_detections
            WHERE module_id = ?
            ORDER BY detected_at DESC, id DESC
            LIMIT 1
        )
        SELECT module_id, filename, bee_type, nest_index,
               bbox_x, bbox_y, bbox_w, bbox_h,
               state, confidence, snip_filename, detected_at
        FROM (
            SELECT n.*, ROW_NUMBER() OVER (
                PARTITION BY n.bee_type, n.nest_index
                ORDER BY n.id DESC
            ) AS rn
            FROM nest_detections n, latest
            WHERE n.module_id = ?
              AND n.filename = latest.filename
              AND n.detected_at = latest.detected_at
        ) t
        WHERE rn = 1
        ORDER BY bee_type, nest_index
        """,
        (canonical, canonical),
    )
    detections = [_row_to_dict(r) for r in rows]
    return jsonify(detections=detections), 200


def _row_to_dict(r) -> dict:
    """Map a ``nest_detections`` row to the wire shape (shared by both reads)."""
    return {
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


@detections_bp.get("/detections/timeline")
def list_detection_timeline():
    """Return the full capture history of a **single nest**, oldest first (#166).

    Where ``GET /detections`` folds to one row per nest from the module's *latest*
    capture (the dashboard grid), the phase-3 time-lapse needs the inverse: every
    capture for *one* ``(module_id, bee_type, nest_index)``, chronological, so the
    UI can scrub that same hole across days and watch it get sealed.

    ``record_detections`` is append-only, so a re-uploaded capture (a network
    retry) records its rows twice for the same ``filename``. Dedup to one frame
    per capture — ``ROW_NUMBER() ... PARTITION BY filename ORDER BY id DESC`` keeps
    the newest write of each capture — then order by ``detected_at ASC`` (``id``
    tiebreaker) so the slider walks forward in time.

    Query: ``?module_id=&bee_type=&nest_index=``. Wire shape mirrors
    ``GET /detections``: ``{"detections": [{...}, ...]}``.
    """
    raw_module_id = request.args.get("module_id")
    bee_type = request.args.get("bee_type")
    nest_index = request.args.get("nest_index")
    if not raw_module_id or not bee_type or nest_index is None:
        return (
            jsonify({"error": "module_id, bee_type and nest_index required"}),
            400,
        )
    try:
        nest_index_int = int(nest_index)
    except (TypeError, ValueError):
        return jsonify({"error": "nest_index must be an integer"}), 400
    canonical, err = _canonicalize_or_400(raw_module_id)
    if err is not None:
        return err

    rows = query_all(
        """
        SELECT module_id, filename, bee_type, nest_index,
               bbox_x, bbox_y, bbox_w, bbox_h,
               state, confidence, snip_filename, detected_at
        FROM (
            SELECT n.*, ROW_NUMBER() OVER (
                PARTITION BY n.filename
                ORDER BY n.id DESC
            ) AS rn
            FROM nest_detections n
            WHERE n.module_id = ?
              AND n.bee_type = ?
              AND n.nest_index = ?
        ) t
        WHERE rn = 1
        ORDER BY detected_at ASC, id ASC
        """,
        (canonical, bee_type, nest_index_int),
    )
    detections = [_row_to_dict(r) for r in rows]
    return jsonify(detections=detections), 200

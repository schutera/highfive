"""Per-module time-series measurements endpoints (issue #110).

Two routes:

* ``POST /measurements`` — append one or more measurement rows. Used by
  in-cluster producers (the heartbeat dual-write in
  ``routes/heartbeats.py``, the future weather worker for #111, the
  classifier output for #112). Internal only; the backend gates the
  public-facing proxy with ``X-Admin-Key``.

* ``GET /modules/<id>/measurements`` — bucketed read with dense-fill,
  returning one bucket per interval step over the requested window.
  Empty buckets emit ``value: null`` (and ``sample_count: 0``) rather
  than being omitted — a missing sensor reading is NOT zero, and
  collapsing the gap to 0 would visually claim "battery dropped to
  empty" when in reality the device was simply silent.

Pattern copied from ``routes/modules.py``'s ``activity_timeseries`` so
the two endpoints share window math, ``date_trunc`` cast, and dense-fill
shape. Differences:

* aggregate is ``AVG(value)`` not ``COUNT(*)`` — counts coalesce to 0
  honestly, averages do not;
* the response distinguishes "no samples in this bucket" (``null``) from
  "bucket value happens to be zero" (``0.0``) via a separate
  ``sample_count`` field;
* ``metric`` is a required query parameter — the same module carries
  many concurrent metric streams and the chart needs to pick one.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from flask import Blueprint, jsonify, request
from pydantic import ValidationError

from db.repository import query_all, query_one, write_transaction
from models.module_id import ModuleId
from routes._bucketing import INTERVAL_STEP, floor_to_interval


measurements_bp = Blueprint("measurements", __name__)


# Metric / source name guards — the columns are VARCHAR(40); enforce in
# Python too so bad inputs return 400 instead of being silently truncated
# by DuckDB. The 40-char ceiling is generous (`temperature_c_2m_anemom`
# fits) but a typo'd 200-char string is almost certainly a bug worth
# surfacing.
_MAX_NAME_LEN = 40


def _validate_name(value: Any, field: str) -> tuple[str | None, tuple | None]:
    # Whitespace-only strings (` `, `\t`, etc.) `bool()` to True, so the
    # bare `not value` guard would let them through and DuckDB would
    # happily store ` ` as a metric. Strip first; reject the empty-
    # after-strip case so a buggy producer can't sneak a single space
    # into a column the next reader would have to grep for.
    if not isinstance(value, str) or not value.strip():
        return None, (
            jsonify({"error": f"'{field}' must be a non-empty string"}),
            400,
        )
    if len(value) > _MAX_NAME_LEN:
        return None, (
            jsonify(
                {
                    "error": f"'{field}' exceeds {_MAX_NAME_LEN} char limit",
                    "got_length": len(value),
                }
            ),
            400,
        )
    return value, None


def _parse_ts(raw: Any) -> tuple[datetime | None, tuple | None]:
    """Parse an inbound ``ts`` field to a naive-UTC ``datetime``.

    Accepts ISO 8601 with or without trailing ``Z`` (which Python's
    ``fromisoformat`` did not understand before 3.11 — guard explicitly
    so the field accepts the shape the JavaScript client emits via
    ``Date.toISOString()``).
    """
    if not isinstance(raw, str) or not raw:
        return None, (jsonify({"error": "'ts' must be a non-empty ISO 8601 string"}), 400)
    try:
        text = raw[:-1] if raw.endswith("Z") else raw
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None, (jsonify({"error": "'ts' is not a valid ISO 8601 timestamp"}), 400)
    # Normalise to naive-UTC; the writers in this service stamp without
    # tzinfo and DuckDB's TIMESTAMP column is naive.
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed, None


def _coerce_one(payload: dict) -> tuple[tuple | None, tuple | None]:
    """Coerce one measurement dict into a 5-tuple ready for DB insert.

    Returns ``(row, None)`` on success or ``(None, error_response)`` on
    failure. ``error_response`` is the Flask ``(json, status)`` tuple
    the route returns verbatim.
    """
    raw_mac = payload.get("module_mac") or payload.get("module_id")
    if raw_mac is None:
        return None, (jsonify({"error": "missing 'module_mac'"}), 400)
    try:
        mac = ModuleId.model_validate(raw_mac).root
    except ValidationError:
        return None, (jsonify({"error": "invalid module_mac format"}), 400)

    metric, err = _validate_name(payload.get("metric"), "metric")
    if err is not None:
        return None, err
    source, err = _validate_name(payload.get("source"), "source")
    if err is not None:
        return None, err

    value = payload.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, (jsonify({"error": "'value' must be a number"}), 400)
    # Reject NaN / Infinity — DuckDB stores them but downstream charts
    # render them as gaps that disagree with our dense-fill semantics.
    if value != value or value in (float("inf"), float("-inf")):
        return None, (jsonify({"error": "'value' must be finite"}), 400)

    ts, err = _parse_ts(payload.get("ts"))
    if err is not None:
        return None, err

    return (mac, ts, metric, float(value), source), None


@measurements_bp.post("/measurements")
def post_measurements():
    """Append one measurement or a batch.

    Body shape — single:
        {"module_mac": "...", "ts": "...", "metric": "...",
         "value": 1.23, "source": "..."}

    Body shape — batch:
        {"measurements": [{...}, {...}, ...]}

    Returns ``200 {"inserted": N}`` on success. Validation failure on
    any item rejects the entire batch with a 400 — partial writes are
    a smell when the caller expected atomicity.

    No firmware-facing auth at this layer; the backend proxy is the
    public boundary and gates the route with ``X-Admin-Key`` (see
    ``backend/src/app.ts``'s ``POST /api/modules/:id/measurements``).
    """
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "request body must be JSON"}), 400

    if isinstance(body, dict) and "measurements" in body:
        items = body["measurements"]
        if not isinstance(items, list):
            return jsonify({"error": "'measurements' must be a list"}), 400
    elif isinstance(body, dict):
        items = [body]
    else:
        return jsonify({"error": "request body must be a JSON object"}), 400

    if not items:
        return jsonify({"inserted": 0}), 200

    if len(items) > 1000:
        # Cap the per-request batch size so a runaway producer can't
        # wedge the global write lock for seconds. 1000 rows × 5 fields
        # is well under the DuckDB executemany sweet spot.
        return jsonify({"error": "batch exceeds 1000 rows per request"}), 400

    rows: list[tuple] = []
    for idx, raw in enumerate(items):
        if not isinstance(raw, dict):
            return (
                jsonify({"error": f"item {idx} is not an object"}),
                400,
            )
        row, err = _coerce_one(raw)
        if err is not None:
            json_body, status = err
            # Splice the index into the error payload so a batch
            # caller can find the bad row.
            payload = json_body.get_json()
            payload["index"] = idx
            return jsonify(payload), status
        rows.append(row)

    with write_transaction() as con:
        con.executemany(
            "INSERT INTO measurements (module_mac, ts, metric, value, source) "
            "VALUES (?, ?, ?, ?, ?)",
            rows,
        )

    return jsonify({"inserted": len(rows)}), 200


@measurements_bp.get("/modules/<module_id>/measurements")
def get_measurements(module_id: str):
    """Bucketed measurement read with dense-fill.

    Query params:
      * ``metric``   — required (e.g. ``battery_pct``). The same module
        carries many concurrent metric streams; the consumer picks one.
      * ``interval`` — ``hourly`` (default) or ``daily``.
      * ``days``     — window size, default 7, max 90.

    Empty buckets emit ``value: null`` and ``sample_count: 0`` rather
    than ``value: 0``. A missing sensor reading is NOT a reading of
    zero — see ``contracts/src/index.ts``'s ``MeasurementBucket``
    docstring for the rationale.
    """
    # Canonicalise the path id via the same ModuleId model the other
    # routes use; inline rather than depending on routes/modules.py'
    # private helper to keep this blueprint self-contained.
    try:
        canonical = ModuleId.model_validate(module_id).root
    except ValidationError as e:
        cleaned = [
            {"msg": err.get("msg"), "type": err.get("type"), "loc": list(err.get("loc", []))}
            for err in e.errors()
        ]
        return jsonify({"error": "invalid module id", "detail": cleaned}), 400

    metric = request.args.get("metric")
    if not metric:
        return jsonify({"error": "'metric' query parameter is required"}), 400
    if len(metric) > _MAX_NAME_LEN:
        return (
            jsonify({"error": f"'metric' exceeds {_MAX_NAME_LEN} char limit"}),
            400,
        )

    interval = request.args.get("interval", "hourly")
    if interval not in INTERVAL_STEP:
        return (
            jsonify(
                {"error": "invalid interval", "detail": "must be 'hourly' or 'daily'"}
            ),
            400,
        )

    days_raw = request.args.get("days", "7")
    try:
        days = int(days_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "days must be an integer"}), 400
    if days < 1 or days > 90:
        return jsonify({"error": "days must be in [1, 90]"}), 400

    if query_one("SELECT 1 FROM module_configs WHERE id = ?", (canonical,)) is None:
        return jsonify({"error": "Module not found"}), 404

    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    end = floor_to_interval(now_utc, interval) + INTERVAL_STEP[interval]
    start = end - timedelta(days=days)

    # `date_trunc`'s unit cannot be a bind parameter (it's a SQL keyword-
    # positional). Branch in Python — `interval` is whitelisted above so
    # this is not a SQL-injection vector.
    trunc_unit = "hour" if interval == "hourly" else "day"
    # ::TIMESTAMP cast is load-bearing — see `routes/_bucketing.py`
    # docstring and chapter 11 "date_trunc('day', ts) returns DATE not
    # TIMESTAMP" for the incident. Without the cast, daily-mode keys
    # render as "YYYY-MM-DD" and never match the dense-fill cursor's
    # "YYYY-MM-DDT00:00:00" keys.
    rows = query_all(
        f"""
        SELECT date_trunc('{trunc_unit}', ts)::TIMESTAMP AS bucket,
               AVG(value) AS avg_value,
               COUNT(*) AS sample_count
        FROM measurements
        WHERE module_mac = ?
          AND metric = ?
          AND ts >= ?
          AND ts <  ?
        GROUP BY bucket
        ORDER BY bucket
        """,
        (canonical, metric, start, end),
    )

    counts_by_bucket: dict[str, dict] = {}
    for row in rows:
        bucket = row["bucket"]
        if isinstance(bucket, datetime):
            key = bucket.replace(tzinfo=None).isoformat()
        else:
            key = str(bucket)
        counts_by_bucket[key] = {
            "value": float(row["avg_value"]) if row["avg_value"] is not None else None,
            "sample_count": int(row["sample_count"]),
        }

    step = INTERVAL_STEP[interval]
    buckets: list[dict] = []
    cursor = start
    while cursor < end:
        key = cursor.isoformat()
        entry = counts_by_bucket.get(key)
        if entry is None:
            buckets.append({"timestamp": key, "value": None, "sample_count": 0})
        else:
            buckets.append({"timestamp": key, **entry})
        cursor = cursor + step

    return (
        jsonify(
            {
                "module_id": canonical,
                "metric": metric,
                "interval": interval,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "buckets": buckets,
            }
        ),
        200,
    )

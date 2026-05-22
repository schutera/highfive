"""Shared helpers for time-bucketed read endpoints.

Extracted from `routes/modules.py`'s `activity_timeseries` so the new
`measurements` read endpoint (issue #110) can reuse the exact same
window / step / dense-fill semantics without copy-paste drift. Adding a
new granularity (e.g. ``weekly``) means a new ``_INTERVAL_STEP`` entry
plus a matching ``date_trunc`` argument in *every* caller — both wired
by the same ``interval`` query-param.

The ``date_trunc('{unit}', col)::TIMESTAMP`` cast that callers must
apply alongside this module is non-negotiable: ``date_trunc('day', ts)``
returns a ``DATE`` in DuckDB (no time component), which the Python
driver hands back as ``datetime.date``. The dense-fill cursor below
emits ``datetime.isoformat()`` keys like ``2026-05-20T00:00:00`` —
``date.isoformat()`` produces ``2026-05-20`` without the ``T00:00:00``,
so every daily-mode lookup misses and all buckets silently render their
gap-fill sentinel. The incident is recorded in chapter 11
"date_trunc('day', ts) returns DATE not TIMESTAMP".
"""

from __future__ import annotations

from datetime import datetime, timedelta


# Bucket sizes for time-bucketed read endpoints. The gap-fill cursor in
# every caller and the SQL ``date_trunc`` stay in sync via this single
# source of truth.
INTERVAL_STEP: dict[str, timedelta] = {
    "hourly": timedelta(hours=1),
    "daily": timedelta(days=1),
}


def floor_to_interval(ts: datetime, interval: str) -> datetime:
    """Truncate ``ts`` to the start of its hour/day in UTC.

    Mirrors DuckDB's ``date_trunc('hour'|'day', ...)`` semantics so the
    gap-fill loop emits the exact same bucket-start instants the SQL
    aggregate produces. Without this, a window starting at 12:34:56
    would produce a first gap-bucket at 12:34:56 and the chart would
    see "two buckets at the same hour, one zero".
    """
    if interval == "hourly":
        return ts.replace(minute=0, second=0, microsecond=0)
    # daily
    return ts.replace(hour=0, minute=0, second=0, microsecond=0)

"""Server-side weather worker (issue #111, ADR-017).

Hourly APScheduler job fetches Open-Meteo Forecast observations for
each module with a plausible lat/lng and writes them into the
``measurements`` table tagged ``source='open-meteo'``. A separate
one-shot ``run_weather_backfill`` (triggered by the admin endpoint
in ``routes/admin_weather.py``) pulls historical observations from
the Open-Meteo Archive endpoint with ``source='open-meteo-backfill'``.

Mirror of ``services/silence_watcher.py``'s pattern: read modules
under the DB lock, run HTTP and INSERTs outside the lock, swallow
per-module exceptions so a single failing call doesn't wedge the
scheduler thread.
"""

from __future__ import annotations

import datetime as _dt
import os
import threading
from datetime import datetime, timedelta, timezone

import requests

from db.connection import get_conn, lock
from db.repository import write_transaction

# Single-shot guard for ``run_weather_backfill``. Two simultaneous admin
# triggers would each read the same ``existing`` set and re-insert the
# same chunks (``measurements`` has no UNIQUE constraint per ADR-016 —
# duplicates are quietly allowed by design). The lock keeps the second
# caller from racing; admin endpoint returns a 409-shaped envelope.
_backfill_lock = threading.Lock()


_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Open-Meteo hourly fields → our `metric` column values. Keep this
# list aligned with the `source` table in
# `docs/08-crosscutting-concepts/api-contracts.md`.
_METRIC_FIELDS = {
    "temperature_2m": "temperature_c",
    "relative_humidity_2m": "humidity_pct",
    "precipitation": "precipitation_mm",
}
_HOURLY_PARAM = ",".join(_METRIC_FIELDS.keys())

_LIVE_SOURCE = "open-meteo"
_BACKFILL_SOURCE = "open-meteo-backfill"

# Open-Meteo Archive is ERA5-backed and trails real time by ~5 days;
# the live worker handles anything newer.
_ARCHIVE_LAG_DAYS = 5

# Default look-back when a module has no prior weather rows. Short
# enough that the first tick after enabling the worker doesn't crush
# the API for an operator with many modules; longer history is the
# explicit-backfill endpoint's job.
_DEFAULT_LOOKBACK_DAYS = int(os.getenv("WEATHER_DEFAULT_LOOKBACK_DAYS", "7"))

# Archive request chunk size. The API tolerates wider ranges fine;
# chunking limits the blast radius of a transient upstream failure.
_BACKFILL_CHUNK_DAYS = 30

# Forecast endpoint's `past_days` ceiling per Open-Meteo's docs.
_FORECAST_PAST_DAYS_MAX = 92

_HTTP_TIMEOUT_S = 10


def _enabled() -> bool:
    return os.getenv("WEATHER_WORKER_ENABLED", "true").lower() == "true"


# Naive-UTC timestamps throughout — DuckDB's TIMESTAMP column is
# tz-less. We strip tzinfo at every boundary so the comparison /
# storage shape matches what the heartbeat dual-write writes
# (``routes/heartbeats.py``'s ``received_at`` does the same).
def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _floor_hour(dt: datetime) -> datetime:
    return dt.replace(minute=0, second=0, microsecond=0)


def _is_plausible_location(lat, lng) -> bool:
    """Pared-down sibling of ``routes/heartbeats.py``'s
    ``_is_plausible_fix``: no ``accuracy`` arg (the column isn't stored
    on ``module_configs``; the heartbeat path already enforces it
    before writing the row). Catches Null Island, NaN, out-of-range."""
    if lat is None or lng is None:
        return False
    try:
        lat = float(lat)
        lng = float(lng)
    except (TypeError, ValueError):
        return False
    if lat != lat or lng != lng:  # NaN
        return False
    if lat == 0.0 and lng == 0.0:
        return False
    if lat > 90.0 or lat < -90.0:
        return False
    if lng > 180.0 or lng < -180.0:
        return False
    return True


def _first_online_to_dt(first_online) -> datetime | None:
    """DuckDB's DATE column surfaces as ``datetime.date``; the legacy
    seed inserts and the registration UPSERT both write date-only
    values. Return a naive-UTC ``datetime`` at midnight on that day."""
    if first_online is None:
        return None
    if isinstance(first_online, datetime):
        return first_online.replace(tzinfo=None)
    if isinstance(first_online, _dt.date):
        return datetime.combine(first_online, datetime.min.time())
    return None


def fetch_open_meteo(
    lat: float,
    lng: float,
    *,
    mode: str,
    start: datetime,
    end: datetime,
) -> list[tuple[datetime, str, float]]:
    """Fetch hourly observations from Open-Meteo, return flat rows.

    Returns a list of ``(ts, metric, value)`` tuples filtered to
    ``[start, end)``. ``mode='forecast'`` hits the live endpoint
    with ``past_days``; ``mode='archive'`` hits the historical ERA5
    endpoint with ``start_date``/``end_date``. Both endpoints return
    the same hourly JSON shape so the parser handles both.

    One retry on ``requests.RequestException``; the second failure
    raises so the caller's per-module try/except can log and move on.
    """
    if mode == "forecast":
        # Forecast endpoint serves past + future via past_days /
        # forecast_days. We never want future values so forecast_days=0.
        # +2 padding so the response definitely covers `start`; the
        # parser drops anything outside [start, end).
        gap_days = (end - start).total_seconds() / 86400.0
        past_days = max(1, min(_FORECAST_PAST_DAYS_MAX, int(gap_days) + 2))
        params = {
            "latitude": f"{lat:.4f}",
            "longitude": f"{lng:.4f}",
            "past_days": past_days,
            "forecast_days": 0,
            "hourly": _HOURLY_PARAM,
            "timezone": "UTC",
        }
        url = _FORECAST_URL
    elif mode == "archive":
        params = {
            "latitude": f"{lat:.4f}",
            "longitude": f"{lng:.4f}",
            "start_date": start.date().isoformat(),
            "end_date": end.date().isoformat(),
            "hourly": _HOURLY_PARAM,
            "timezone": "UTC",
        }
        url = _ARCHIVE_URL
    else:
        raise ValueError(f"unknown mode: {mode!r}")

    for attempt in range(2):
        try:
            resp = requests.get(url, params=params, timeout=_HTTP_TIMEOUT_S)
            resp.raise_for_status()
            return _parse_open_meteo(resp.json(), start, end)
        except requests.RequestException:
            if attempt == 1:
                raise
    # Unreachable — the loop either returns or re-raises.
    return []


def _parse_open_meteo(
    body: dict | None,
    start: datetime,
    end: datetime,
) -> list[tuple[datetime, str, float]]:
    """Flatten an Open-Meteo response to ``(ts, metric, value)`` rows.

    Drops rows where the value is null (Open-Meteo emits null for a
    metric/hour when the underlying grid has a gap) so the dense-fill
    reader surfaces those as ``value: null`` rather than a fake 0.
    Drops rows outside ``[start, end)`` so chunk edges don't double-
    count timestamps.
    """
    hourly = (body or {}).get("hourly") or {}
    times = hourly.get("time") or []
    rows: list[tuple[datetime, str, float]] = []
    for field, metric in _METRIC_FIELDS.items():
        values = hourly.get(field) or []
        for ts_str, val in zip(times, values):
            if val is None:
                continue
            try:
                ts = datetime.fromisoformat(ts_str)
            except (TypeError, ValueError):
                continue
            # With `timezone=UTC` the response strings are already naive
            # UTC. Defence-in-depth in case the API ever returns offset
            # strings on this endpoint.
            if ts.tzinfo is not None:
                ts = ts.astimezone(timezone.utc).replace(tzinfo=None)
            if ts < start or ts >= end:
                continue
            try:
                val_f = float(val)
            except (TypeError, ValueError):
                continue
            if val_f != val_f or val_f in (float("inf"), float("-inf")):
                continue
            rows.append((ts, metric, val_f))
    return rows


def _read_modules_with_location() -> list[tuple[str, float, float, datetime | None]]:
    """Snapshot all modules with a plausible fix under the DB lock.

    Returns a list of ``(mac, lat, lng, first_online_dt)``. The lock
    is released before the caller starts HTTP — the same shape as
    ``silence_watcher.check_silence``.
    """
    with lock:
        con = get_conn()
        try:
            # ORDER BY id is load-bearing for deterministic iteration —
            # DuckDB does not guarantee row order without it, and the
            # error-path test in test_weather_worker pins behaviour by
            # the order modules are visited. A page split / vacuum
            # could otherwise silently flip which module hits a faked
            # error branch.
            rows = con.execute(
                "SELECT id, lat, lng, first_online FROM module_configs ORDER BY id"
            ).fetchall()
        finally:
            con.close()
    out: list[tuple[str, float, float, datetime | None]] = []
    for mac, lat, lng, first_online in rows:
        if _is_plausible_location(lat, lng):
            out.append((mac, float(lat), float(lng), _first_online_to_dt(first_online)))
    return out


def _latest_weather_ts(module_mac: str) -> datetime | None:
    """Watermark — the most recent ``ts`` already in the measurements
    store for this module from either the live worker or the backfill.
    The live worker's next fetch starts at ``latest_ts + 1h``.

    Spans all three metrics (no metric filter) so a trailing hour with
    a null ``temperature_2m`` but non-null ``humidity`` / ``precip``
    still advances the watermark — otherwise the next tick would
    re-fetch that hour and double-insert the two non-null metrics.
    Open-Meteo's grid sometimes emits null for a single metric while
    the others are valid; the parser drops the nulls but the watermark
    has to count the hour as "we've been here" regardless. Idempotency
    contract from ADR-017's "Worker" section depends on this.
    """
    with lock:
        con = get_conn()
        try:
            row = con.execute(
                "SELECT MAX(ts) FROM measurements "
                "WHERE module_mac = ? AND source IN (?, ?)",
                [module_mac, _LIVE_SOURCE, _BACKFILL_SOURCE],
            ).fetchone()
        finally:
            con.close()
    return row[0] if row and row[0] is not None else None


def _existing_backfill_timestamps(module_mac: str) -> set[datetime]:
    """Distinct ``ts`` values already imported as ``open-meteo-backfill``.

    Used to dedupe within a backfill chunk so a re-run inserts only
    the gap rows. Picks the ``temperature_c`` metric specifically
    because the worker writes all three metrics in lockstep — if the
    timestamp exists for one, it exists for the others.
    """
    with lock:
        con = get_conn()
        try:
            rows = con.execute(
                "SELECT ts FROM measurements "
                "WHERE module_mac = ? AND metric = 'temperature_c' "
                "AND source = ?",
                [module_mac, _BACKFILL_SOURCE],
            ).fetchall()
        finally:
            con.close()
    return {r[0] for r in rows}


def _insert_measurement_rows(
    module_mac: str,
    rows: list[tuple[datetime, str, float]],
    source: str,
) -> int:
    if not rows:
        return 0
    with write_transaction() as con:
        con.executemany(
            "INSERT INTO measurements "
            "(module_mac, ts, metric, value, source) "
            "VALUES (?, ?, ?, ?, ?)",
            [(module_mac, ts, metric, val, source) for (ts, metric, val) in rows],
        )
    return len(rows)


def run_weather_fetch() -> None:
    """Hourly scheduler entry — gap-fill live weather observations.

    For each module with a plausible fix, computes the missing window
    since the latest existing measurement (or default lookback for
    fresh modules), fetches from Open-Meteo Forecast, and INSERTs
    rows tagged ``source='open-meteo'``. Per-module exceptions are
    caught and logged so the scheduler thread survives a transient
    upstream outage.
    """
    if not _enabled():
        return

    modules = _read_modules_with_location()
    if not modules:
        return

    now_hour = _floor_hour(_now_utc())
    fetched_modules = 0
    inserted_rows = 0

    for mac, lat, lng, _first_online in modules:
        latest_ts = _latest_weather_ts(mac)
        if latest_ts is None:
            start = now_hour - timedelta(days=_DEFAULT_LOOKBACK_DAYS)
        else:
            # Truncate any sub-hour precision DuckDB may surface
            # (TIMESTAMP without explicit precision) so the +1h step
            # lands on an hour boundary.
            start = _floor_hour(latest_ts) + timedelta(hours=1)
        if start >= now_hour:
            continue
        try:
            rows = fetch_open_meteo(
                lat, lng, mode="forecast", start=start, end=now_hour
            )
        except Exception as e:
            print(f"[weather_worker] fetch failed for {mac}: {e}")
            continue
        if not rows:
            continue
        try:
            written = _insert_measurement_rows(mac, rows, _LIVE_SOURCE)
        except Exception as e:
            print(f"[weather_worker] insert failed for {mac}: {e}")
            continue
        fetched_modules += 1
        inserted_rows += written

    if fetched_modules or inserted_rows:
        print(
            f"[weather_worker] live: touched {fetched_modules} modules, "
            f"wrote {inserted_rows} rows"
        )


def _backfill_start_for_module(
    first_online: datetime | None,
    days: int | None,
) -> datetime:
    """Resolve the backfill window's start for one module.

    ``days=None`` → start at the module's first_online (or default
    look-back if the column is unset). ``days=N`` → uniform
    ``now - N days`` for every module. Result is hour-floored.
    """
    if days is not None:
        return _floor_hour(_now_utc() - timedelta(days=days))
    if first_online is not None:
        return _floor_hour(first_online)
    return _floor_hour(_now_utc() - timedelta(days=_DEFAULT_LOOKBACK_DAYS))


def run_weather_backfill(*, days: int | None = None) -> dict:
    """One-shot historical backfill — operator-triggered via the
    ``POST /admin/weather/backfill`` endpoint.

    Returns ``{modules_touched, rows_written, errors}`` so the admin
    response can report partial success per module. A single module's
    Open-Meteo failure is reported in ``errors`` and does NOT abort
    the run — chapter 11's experience with the silence watcher's
    per-iteration error model is the precedent.

    The admin endpoint stays reachable even when
    ``WEATHER_WORKER_ENABLED`` is false (the env var gates the
    scheduled tick at boot, not the operator-initiated path). A
    concurrent second call returns immediately with an explicit
    ``errors`` entry rather than silently corrupting the in-memory
    ``existing`` dedup set.
    """
    acquired = _backfill_lock.acquire(blocking=False)
    if not acquired:
        return {
            "modules_touched": 0,
            "rows_written": 0,
            "errors": [{"module_mac": None, "error": "backfill already in progress"}],
        }
    try:
        return _run_weather_backfill_locked(days=days)
    finally:
        _backfill_lock.release()


def _run_weather_backfill_locked(*, days: int | None) -> dict:
    """Body of ``run_weather_backfill``. Caller holds ``_backfill_lock``."""
    modules = _read_modules_with_location()
    # Archive trails real time by ~5 days; round down to the previous
    # midnight so chunk boundaries align with the API's date params.
    end = (_now_utc() - timedelta(days=_ARCHIVE_LAG_DAYS)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    modules_touched = 0
    rows_written = 0
    errors: list[dict] = []

    for mac, lat, lng, first_online in modules:
        try:
            start = _backfill_start_for_module(first_online, days)
            if start >= end:
                continue
            existing = _existing_backfill_timestamps(mac)
            module_rows_written = 0
            cursor = start
            while cursor < end:
                chunk_end = min(cursor + timedelta(days=_BACKFILL_CHUNK_DAYS), end)
                rows = fetch_open_meteo(
                    lat, lng, mode="archive", start=cursor, end=chunk_end
                )
                new_rows = [r for r in rows if r[0] not in existing]
                module_rows_written += _insert_measurement_rows(
                    mac, new_rows, _BACKFILL_SOURCE
                )
                # Track in-memory so the next chunk's filter is correct
                # without re-querying.
                existing.update(r[0] for r in new_rows)
                cursor = chunk_end
            if module_rows_written:
                modules_touched += 1
                rows_written += module_rows_written
        except Exception as e:
            print(f"[weather_worker] backfill failed for {mac}: {e}")
            errors.append({"module_mac": mac, "error": str(e)})

    print(
        f"[weather_worker] backfill: touched {modules_touched} modules, "
        f"wrote {rows_written} rows, {len(errors)} errors"
    )
    return {
        "modules_touched": modules_touched,
        "rows_written": rows_written,
        "errors": errors,
    }

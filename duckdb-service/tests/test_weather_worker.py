"""Tests for the server-side weather worker (issue #111, ADR-017).

Covers:

* ``fetch_open_meteo`` — URL/param shape, null-value handling, window
  filtering, retry-on-failure
* ``run_weather_fetch`` — live-tick path, idempotency on re-run,
  ``(0,0)`` skip, error tolerance, ``WEATHER_WORKER_ENABLED=false`` gate
* ``run_weather_backfill`` — historical backfill, source tagging,
  idempotency
* Bucket-content assertion (CLAUDE.md PR-120 rule): the GET endpoint
  returns the seeded weather VALUE in the expected hour bucket, not
  just an envelope with the right shape.

HTTP is faked via ``monkeypatch.setattr(weather_worker.requests, ...)``
per the existing ``conftest`` convention (``responses`` /
``requests-mock`` are not in the project's deps).
"""

from __future__ import annotations

import importlib
from datetime import datetime, timedelta, timezone

import pytest
import requests


TEST_MAC = "aabbccddeeff"
SEED_LAT = 47.8086
SEED_LNG = 9.6433


# ---------- helpers ----------


def _seed_module(
    fresh_db,
    module_id=TEST_MAC,
    lat=SEED_LAT,
    lng=SEED_LNG,
    first_online="2024-01-01",
):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online, "
            "image_count) VALUES (?, 'Seed', ?, ?, ?, 0)",
            (module_id, lat, lng, first_online),
        )
        con.commit()
    finally:
        con.close()


def _count_rows(fresh_db, **filters) -> int:
    con = fresh_db.connection.get_conn()
    try:
        sql = "SELECT COUNT(*) FROM measurements"
        params: list = []
        if filters:
            clauses = []
            for k, v in filters.items():
                clauses.append(f"{k} = ?")
                params.append(v)
            sql += " WHERE " + " AND ".join(clauses)
        return con.execute(sql, params).fetchone()[0]
    finally:
        con.close()


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")


def _build_hourly_payload(start_hour: datetime, n_hours: int, base_temp: float = 12.0):
    """Build an Open-Meteo response covering N consecutive hours.

    Mirrors the live API's shape: parallel arrays under ``hourly``.
    Temperature ramps by 0.5 °C per hour so test assertions can pin a
    specific value to a specific bucket.
    """
    times = []
    temps = []
    hums = []
    rains = []
    for i in range(n_hours):
        ts = start_hour + timedelta(hours=i)
        times.append(ts.isoformat(timespec="minutes"))
        temps.append(base_temp + 0.5 * i)
        hums.append(60 + i)
        rains.append(0.0 if i % 4 else 0.2)
    return {
        "latitude": SEED_LAT,
        "longitude": SEED_LNG,
        "hourly_units": {
            "temperature_2m": "°C",
            "relative_humidity_2m": "%",
            "precipitation": "mm",
        },
        "hourly": {
            "time": times,
            "temperature_2m": temps,
            "relative_humidity_2m": hums,
            "precipitation": rains,
        },
    }


@pytest.fixture
def weather_worker(fresh_db, monkeypatch):
    """Import the worker AFTER fresh_db has set up the DB so the
    module's relative imports resolve against the test connection."""
    monkeypatch.setenv("WEATHER_WORKER_ENABLED", "true")
    module = importlib.import_module("services.weather_worker")
    return module


# ---------- fetch_open_meteo (pure HTTP wrapper) ----------


def test_fetch_open_meteo_forecast_url_and_params(weather_worker, monkeypatch):
    captured: dict = {}

    def fake_get(url, params=None, timeout=None):
        captured["url"] = url
        captured["params"] = params
        captured["timeout"] = timeout
        return _FakeResponse({"hourly": {"time": [], "temperature_2m": []}})

    monkeypatch.setattr(weather_worker.requests, "get", fake_get)
    start = datetime(2026, 5, 20, 0, 0, 0)
    end = datetime(2026, 5, 21, 0, 0, 0)
    weather_worker.fetch_open_meteo(47.8, 9.6, mode="forecast", start=start, end=end)

    assert captured["url"] == "https://api.open-meteo.com/v1/forecast"
    assert captured["params"]["timezone"] == "UTC"
    assert captured["params"]["forecast_days"] == 0
    assert captured["params"]["past_days"] >= 1
    # Temperature, humidity, precipitation all requested.
    assert "temperature_2m" in captured["params"]["hourly"]
    assert "relative_humidity_2m" in captured["params"]["hourly"]
    assert "precipitation" in captured["params"]["hourly"]


def test_fetch_open_meteo_archive_url_and_date_params(weather_worker, monkeypatch):
    captured: dict = {}

    def fake_get(url, params=None, timeout=None):
        captured["url"] = url
        captured["params"] = params
        return _FakeResponse({"hourly": {"time": [], "temperature_2m": []}})

    monkeypatch.setattr(weather_worker.requests, "get", fake_get)
    start = datetime(2025, 6, 1, 0, 0, 0)
    end = datetime(2025, 6, 11, 0, 0, 0)
    weather_worker.fetch_open_meteo(47.8, 9.6, mode="archive", start=start, end=end)

    assert captured["url"] == "https://archive-api.open-meteo.com/v1/archive"
    assert captured["params"]["start_date"] == "2025-06-01"
    assert captured["params"]["end_date"] == "2025-06-11"


def test_fetch_open_meteo_drops_null_values(weather_worker, monkeypatch):
    """Open-Meteo emits null for grid gaps; the parser should skip
    those rather than coerce to 0."""
    start = datetime(2026, 5, 20, 0, 0, 0)
    end = datetime(2026, 5, 20, 3, 0, 0)
    payload = {
        "hourly": {
            "time": ["2026-05-20T00:00", "2026-05-20T01:00", "2026-05-20T02:00"],
            "temperature_2m": [10.0, None, 11.0],
            "relative_humidity_2m": [70, 71, None],
            "precipitation": [0.0, 0.1, 0.2],
        }
    }
    monkeypatch.setattr(
        weather_worker.requests,
        "get",
        lambda *a, **k: _FakeResponse(payload),
    )
    rows = weather_worker.fetch_open_meteo(
        47.8, 9.6, mode="forecast", start=start, end=end
    )
    # 3 hours × 3 metrics minus 2 nulls (one temp + one humidity) = 7 rows.
    assert len(rows) == 7
    # Specifically: no row with metric='temperature_c' at 01:00.
    temp_times = {ts for (ts, metric, _v) in rows if metric == "temperature_c"}
    assert datetime(2026, 5, 20, 1, 0, 0) not in temp_times


def test_fetch_open_meteo_filters_outside_window(weather_worker, monkeypatch):
    """Chunk-edge hours that fall outside [start, end) must be dropped
    so a re-run can't double-count a boundary timestamp."""
    start = datetime(2026, 5, 20, 1, 0, 0)
    end = datetime(2026, 5, 20, 3, 0, 0)
    payload = {
        "hourly": {
            # API returns 4 hours; only the middle two are inside [start, end).
            "time": [
                "2026-05-20T00:00",
                "2026-05-20T01:00",
                "2026-05-20T02:00",
                "2026-05-20T03:00",
            ],
            "temperature_2m": [9.0, 10.0, 11.0, 12.0],
            "relative_humidity_2m": [60, 61, 62, 63],
            "precipitation": [0.0, 0.0, 0.0, 0.0],
        }
    }
    monkeypatch.setattr(
        weather_worker.requests, "get", lambda *a, **k: _FakeResponse(payload)
    )
    rows = weather_worker.fetch_open_meteo(
        47.8, 9.6, mode="forecast", start=start, end=end
    )
    temp_rows = [r for r in rows if r[1] == "temperature_c"]
    assert len(temp_rows) == 2
    assert {r[0] for r in temp_rows} == {
        datetime(2026, 5, 20, 1, 0, 0),
        datetime(2026, 5, 20, 2, 0, 0),
    }


def test_fetch_open_meteo_retries_once_then_raises(weather_worker, monkeypatch):
    """A transient ConnectionError on the first try should not abort
    the call — but a second failure must escape so the caller's
    per-module try/except can log it."""
    calls = {"n": 0}

    def fake_get(*_a, **_k):
        calls["n"] += 1
        raise requests.ConnectionError("boom")

    monkeypatch.setattr(weather_worker.requests, "get", fake_get)
    with pytest.raises(requests.ConnectionError):
        weather_worker.fetch_open_meteo(
            47.8,
            9.6,
            mode="forecast",
            start=datetime(2026, 5, 20),
            end=datetime(2026, 5, 21),
        )
    assert calls["n"] == 2


# ---------- run_weather_fetch (live worker) ----------


def test_run_weather_fetch_writes_rows_with_open_meteo_source(
    client, fresh_db, weather_worker, monkeypatch
):
    """The live worker writes the three metrics with source='open-meteo'
    and the rows are readable via the public measurements endpoint —
    bucket-content assertion (PR-120 rule), not just envelope shape."""
    _seed_module(fresh_db)

    # Place the seeded hours inside [now - 2h, now) so they land in
    # the GET endpoint's 7-day window regardless of when the test runs.
    now = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    )
    # Two completed hours: now-2h and now-1h. Worker's `end` is now
    # (the current hour, floored) and is exclusive, so these are the
    # last two rows it should accept.
    h_minus_2 = now - timedelta(hours=2)
    h_minus_1 = now - timedelta(hours=1)
    payload = _build_hourly_payload(h_minus_2, n_hours=2, base_temp=12.0)
    monkeypatch.setattr(
        weather_worker.requests, "get", lambda *a, **k: _FakeResponse(payload)
    )

    weather_worker.run_weather_fetch()

    # 2 hours × 3 metrics = 6 rows tagged 'open-meteo' for this module.
    assert _count_rows(fresh_db, module_mac=TEST_MAC, source="open-meteo") == 6

    # Bucket-content assertion: the GET endpoint returns the seeded
    # temperature value 12.0 at the h-2 bucket and 12.5 at h-1.
    resp = client.get(f"/modules/{TEST_MAC}/measurements?metric=temperature_c&days=2")
    assert resp.status_code == 200
    buckets = resp.get_json()["buckets"]
    by_ts = {b["timestamp"]: b for b in buckets}
    h_minus_2_iso = h_minus_2.isoformat()
    h_minus_1_iso = h_minus_1.isoformat()
    assert h_minus_2_iso in by_ts
    assert h_minus_1_iso in by_ts
    assert by_ts[h_minus_2_iso]["value"] == pytest.approx(12.0)
    assert by_ts[h_minus_1_iso]["value"] == pytest.approx(12.5)
    assert by_ts[h_minus_2_iso]["sample_count"] == 1


def test_run_weather_fetch_skips_modules_at_null_island(
    fresh_db, weather_worker, monkeypatch
):
    """Modules whose lat/lng sit at the (0,0) sentinel must NOT trigger
    an Open-Meteo call — the firmware-side `_is_plausible_fix` rule
    applies server-side too."""
    _seed_module(fresh_db, lat=0.0, lng=0.0)

    calls = {"n": 0}

    def fake_get(*_a, **_k):
        calls["n"] += 1
        return _FakeResponse({"hourly": {"time": []}})

    monkeypatch.setattr(weather_worker.requests, "get", fake_get)
    weather_worker.run_weather_fetch()
    assert calls["n"] == 0
    assert _count_rows(fresh_db, source="open-meteo") == 0


def test_run_weather_fetch_swallows_http_errors_per_module(
    fresh_db, weather_worker, monkeypatch
):
    """A transient Open-Meteo failure on one module must not abort the
    scheduler thread or roll back writes for other modules."""
    _seed_module(fresh_db, module_id="aabbccddeeff")
    _seed_module(fresh_db, module_id="001122334455", lat=48.0, lng=10.0)

    now = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    )
    h_minus_1 = now - timedelta(hours=1)
    good_payload = _build_hourly_payload(h_minus_1, n_hours=1, base_temp=15.0)

    def fake_get(url, params=None, timeout=None):
        # The worker iterates modules in `ORDER BY id` (lexicographic
        # ascending), so `0011...` runs first and `aabb...` second.
        # Discriminate by latitude, not call order — that survives any
        # future change to the iteration ordering.
        if params and params.get("latitude") == f"{SEED_LAT:.4f}":
            raise requests.ConnectionError("boom")
        return _FakeResponse(good_payload)

    monkeypatch.setattr(weather_worker.requests, "get", fake_get)
    weather_worker.run_weather_fetch()

    # First MAC: no rows. Second MAC: 1 hour × 3 metrics = 3 rows.
    assert _count_rows(fresh_db, module_mac="aabbccddeeff", source="open-meteo") == 0
    assert _count_rows(fresh_db, module_mac="001122334455", source="open-meteo") == 3


def test_run_weather_fetch_is_idempotent_on_rerun(
    fresh_db, weather_worker, monkeypatch
):
    """Calling the worker twice in a row must NOT double-write: the
    second call's start watermark = max(ts) + 1h leaves no gap to
    fill until the next real hour ticks over."""
    _seed_module(fresh_db)

    now = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    )
    payload = _build_hourly_payload(now - timedelta(hours=2), n_hours=2)
    monkeypatch.setattr(
        weather_worker.requests, "get", lambda *a, **k: _FakeResponse(payload)
    )

    weather_worker.run_weather_fetch()
    first_count = _count_rows(fresh_db, module_mac=TEST_MAC, source="open-meteo")
    weather_worker.run_weather_fetch()
    second_count = _count_rows(fresh_db, module_mac=TEST_MAC, source="open-meteo")

    assert first_count == 6  # 2 h × 3 metrics
    # Second call's window is empty: start = max(ts)+1h = now, end = now.
    # No rows inserted; count unchanged. (A duplicate-write bug would
    # produce 12 rows here.)
    assert second_count == first_count


def test_run_weather_fetch_no_duplicates_when_temperature_is_null(
    fresh_db, weather_worker, monkeypatch
):
    """Regression: if Open-Meteo returns a null `temperature_2m` at the
    most recent hour but non-null `humidity` / `precipitation`, the
    watermark must still advance — otherwise the next tick re-fetches
    that hour and double-inserts the two non-null metrics.

    Pre-fix, ``_latest_weather_ts`` filtered on ``metric='temperature_c'``
    so a null temp at hour H left the watermark at H-1; the second
    call re-wrote humidity and precipitation for H. Senior-reviewer
    flagged this as P0.
    """
    _seed_module(fresh_db)

    now = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    )
    h_minus_2 = now - timedelta(hours=2)
    h_minus_1 = now - timedelta(hours=1)
    # Temperature is null at h-1; humidity and precipitation are present.
    payload = {
        "hourly": {
            "time": [
                h_minus_2.isoformat(timespec="minutes"),
                h_minus_1.isoformat(timespec="minutes"),
            ],
            "temperature_2m": [12.0, None],
            "relative_humidity_2m": [65, 70],
            "precipitation": [0.0, 0.2],
        }
    }
    monkeypatch.setattr(
        weather_worker.requests, "get", lambda *a, **k: _FakeResponse(payload)
    )

    weather_worker.run_weather_fetch()
    first = _count_rows(fresh_db, module_mac=TEST_MAC, source="open-meteo")
    weather_worker.run_weather_fetch()
    second = _count_rows(fresh_db, module_mac=TEST_MAC, source="open-meteo")

    # Expected: 1 temp row + 2 humidity rows + 2 precip rows = 5 rows
    # on the first call. (Temp at h-1 is null → dropped by the parser.)
    assert first == 5
    # Second call must NOT re-write the h-1 humidity/precipitation rows
    # even though the temperature for h-1 is missing from the store.
    assert second == first


def test_run_weather_fetch_disabled_when_flag_is_false(
    fresh_db, weather_worker, monkeypatch
):
    """``WEATHER_WORKER_ENABLED=false`` must short-circuit BEFORE any
    DB query or HTTP call. This is the off-ramp the conftest uses to
    keep unrelated tests from triggering the scheduler."""
    _seed_module(fresh_db)
    monkeypatch.setenv("WEATHER_WORKER_ENABLED", "false")

    calls = {"n": 0}
    monkeypatch.setattr(
        weather_worker.requests,
        "get",
        lambda *a, **k: (
            calls.__setitem__("n", calls["n"] + 1) or _FakeResponse({"hourly": {}})
        ),
    )
    weather_worker.run_weather_fetch()
    assert calls["n"] == 0
    assert _count_rows(fresh_db, source="open-meteo") == 0


# ---------- run_weather_backfill (historical) ----------


def test_run_weather_backfill_writes_backfill_source(
    fresh_db, weather_worker, monkeypatch
):
    """Backfill writes go in with source='open-meteo-backfill' so they
    are distinguishable from live samples by SQL filter; aggregates
    over `metric` still collapse them together per ADR-016/017."""
    _seed_module(fresh_db, first_online="2024-01-01")

    # Cover the request window with a small canned response. The worker
    # chunks by 30 days, so over a many-day window it makes multiple
    # calls — accept whatever range is asked and return the same
    # 24-hour payload pinned at the start_date the worker requested.
    def fake_get(url, params=None, timeout=None):
        start_date = params["start_date"]
        # The worker passes `start_date` as YYYY-MM-DD; build a one-day
        # response so each chunk contributes a deterministic 24 rows ×
        # 3 metrics.
        start_dt = datetime.fromisoformat(start_date + "T00:00:00")
        return _FakeResponse(_build_hourly_payload(start_dt, n_hours=24))

    monkeypatch.setattr(weather_worker.requests, "get", fake_get)

    result = weather_worker.run_weather_backfill(days=10)
    assert result["modules_touched"] >= 1
    assert result["rows_written"] > 0
    assert result["errors"] == []

    # All rows tagged with the backfill source, none tagged 'open-meteo'.
    assert _count_rows(fresh_db, source="open-meteo-backfill") > 0
    assert _count_rows(fresh_db, source="open-meteo") == 0


def test_run_weather_backfill_is_idempotent_on_rerun(
    fresh_db, weather_worker, monkeypatch
):
    """Running the backfill twice produces the same row count — the
    in-loop `existing` set filter elides timestamps already present
    for ``source='open-meteo-backfill'``."""
    _seed_module(fresh_db, first_online="2024-01-01")

    def fake_get(url, params=None, timeout=None):
        start_dt = datetime.fromisoformat(params["start_date"] + "T00:00:00")
        return _FakeResponse(_build_hourly_payload(start_dt, n_hours=24))

    # days must exceed _ARCHIVE_LAG_DAYS (5) or the requested window
    # falls entirely inside ERA5's lag and the worker has nothing to
    # fetch — the test would assert against zero rows otherwise.
    monkeypatch.setattr(weather_worker.requests, "get", fake_get)
    weather_worker.run_weather_backfill(days=15)
    first = _count_rows(fresh_db, source="open-meteo-backfill")
    weather_worker.run_weather_backfill(days=15)
    second = _count_rows(fresh_db, source="open-meteo-backfill")

    assert first > 0
    assert second == first


# ---------- admin endpoint integration ----------


def test_admin_endpoint_invokes_backfill(client, fresh_db, weather_worker, monkeypatch):
    """``POST /admin/weather/backfill`` calls the worker and returns
    the result envelope verbatim."""
    _seed_module(fresh_db, first_online="2024-01-01")

    def fake_get(url, params=None, timeout=None):
        start_dt = datetime.fromisoformat(params["start_date"] + "T00:00:00")
        return _FakeResponse(_build_hourly_payload(start_dt, n_hours=24))

    monkeypatch.setattr(weather_worker.requests, "get", fake_get)

    # days=10 puts the window outside ERA5's ~5-day archive lag, so
    # the worker actually has data to fetch.
    resp = client.post("/admin/weather/backfill?days=10")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["modules_touched"] >= 1
    assert body["rows_written"] > 0
    assert body["errors"] == []


def test_run_weather_backfill_rejects_concurrent_callers(
    fresh_db, weather_worker, monkeypatch
):
    """A second concurrent backfill must not race the first: both would
    read the same `existing` ts set and silently double-insert chunks
    (``measurements`` has no UNIQUE constraint per ADR-016).

    Acquire the backfill lock externally, then call the public function
    — the public function should fail-fast with an explicit error
    envelope rather than blocking or duplicating writes.
    """
    _seed_module(fresh_db, first_online="2024-01-01")
    monkeypatch.setattr(
        weather_worker.requests,
        "get",
        lambda *a, **k: _FakeResponse({"hourly": {"time": []}}),
    )

    # Simulate the first caller still running by grabbing the lock.
    assert weather_worker._backfill_lock.acquire(blocking=False)
    try:
        result = weather_worker.run_weather_backfill(days=10)
    finally:
        weather_worker._backfill_lock.release()

    assert result["modules_touched"] == 0
    assert result["rows_written"] == 0
    assert len(result["errors"]) == 1
    assert "already in progress" in result["errors"][0]["error"]


def test_admin_endpoint_rejects_invalid_days(client):
    """Days outside the documented [1, 36500] range fail with 400 so
    a runaway script gets a clean error instead of an empty no-op."""
    resp = client.post("/admin/weather/backfill?days=0")
    assert resp.status_code == 400

    resp = client.post("/admin/weather/backfill?days=foo")
    assert resp.status_code == 400

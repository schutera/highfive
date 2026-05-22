"""Tests for the per-module measurements store (issue #110).

Covers:
* POST /measurements (single + batch + validation)
* GET  /modules/<id>/measurements (bucketing, AVG, dense-fill, null gaps)
* Heartbeat dual-write into the measurements table

CLAUDE.md rule 5: every aggregation test seeds real rows in known
buckets and asserts the bucket VALUES — not just envelope shape — so
a silently-broken aggregate (all-zeros, drops the row, mis-buckets it)
fails the test instead of passing it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


# Canonical 12-hex-char ModuleId test fixtures (match test_module_endpoints.py).
TEST_MAC_1 = "aabbccddeeff"
TEST_MAC_2 = "001122334455"


def _seed_module(fresh_db, module_id=TEST_MAC_1, image_count=0, battery_level=None):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online, "
            "battery_level, image_count) "
            "VALUES (?, 'Seed', 47.8, 9.6, '2024-01-01', ?, ?)",
            (module_id, battery_level, image_count),
        )
        con.commit()
    finally:
        con.close()


def _seed_measurement(fresh_db, module_mac, ts, metric, value, source):
    """Insert a single measurements row with an explicit timestamp.

    Bypasses the route so we can stage timestamps in known buckets for
    the aggregation tests — `POST /measurements` accepts an explicit
    `ts` too, but going via SQL keeps the test independent of the
    route's parsing behaviour.
    """
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO measurements (module_mac, ts, metric, value, source) "
            "VALUES (?, ?, ?, ?, ?)",
            (module_mac, ts, metric, float(value), source),
        )
        con.commit()
    finally:
        con.close()


def _count_measurements(fresh_db, **filters):
    con = fresh_db.connection.get_conn()
    try:
        sql = "SELECT COUNT(*) FROM measurements"
        params = []
        if filters:
            clauses = []
            for k, v in filters.items():
                clauses.append(f"{k} = ?")
                params.append(v)
            sql += " WHERE " + " AND ".join(clauses)
        return con.execute(sql, params).fetchone()[0]
    finally:
        con.close()


# ---------- POST /measurements ----------


def test_post_measurements_single_inserts_row(client, fresh_db):
    _seed_module(fresh_db)
    resp = client.post(
        "/measurements",
        json={
            "module_mac": TEST_MAC_1,
            "ts": "2026-05-20T12:00:00",
            "metric": "battery_pct",
            "value": 87.5,
            "source": "esp-heartbeat",
        },
    )
    assert resp.status_code == 200
    assert resp.get_json() == {"inserted": 1}
    assert _count_measurements(fresh_db, module_mac=TEST_MAC_1) == 1


def test_post_measurements_batch_inserts_all_rows(client, fresh_db):
    _seed_module(fresh_db)
    resp = client.post(
        "/measurements",
        json={
            "measurements": [
                {
                    "module_mac": TEST_MAC_1,
                    "ts": "2026-05-20T12:00:00",
                    "metric": "battery_pct",
                    "value": 87.5,
                    "source": "esp-heartbeat",
                },
                {
                    "module_mac": TEST_MAC_1,
                    "ts": "2026-05-20T13:00:00",
                    "metric": "battery_pct",
                    "value": 86.0,
                    "source": "esp-heartbeat",
                },
            ]
        },
    )
    assert resp.status_code == 200
    assert resp.get_json() == {"inserted": 2}
    assert _count_measurements(fresh_db, module_mac=TEST_MAC_1) == 2


def test_post_measurements_accepts_z_suffixed_iso_timestamp(client, fresh_db):
    """JavaScript's `Date.toISOString()` always emits `...Z`. Accept it."""
    _seed_module(fresh_db)
    resp = client.post(
        "/measurements",
        json={
            "module_mac": TEST_MAC_1,
            "ts": "2026-05-20T12:00:00Z",
            "metric": "battery_pct",
            "value": 50.0,
            "source": "esp-heartbeat",
        },
    )
    assert resp.status_code == 200


def test_post_measurements_invalid_mac_returns_400(client):
    resp = client.post(
        "/measurements",
        json={
            "module_mac": "not-a-mac",
            "ts": "2026-05-20T12:00:00",
            "metric": "battery_pct",
            "value": 50.0,
            "source": "esp-heartbeat",
        },
    )
    assert resp.status_code == 400
    assert "module_mac" in resp.get_json()["error"]


def test_post_measurements_missing_field_returns_400(client):
    resp = client.post(
        "/measurements",
        json={
            "module_mac": TEST_MAC_1,
            "ts": "2026-05-20T12:00:00",
            # metric missing
            "value": 50.0,
            "source": "esp-heartbeat",
        },
    )
    assert resp.status_code == 400


def test_post_measurements_rejects_nan_value(client):
    resp = client.post(
        "/measurements",
        json={
            "module_mac": TEST_MAC_1,
            "ts": "2026-05-20T12:00:00",
            "metric": "battery_pct",
            "value": float("nan"),
            "source": "esp-heartbeat",
        },
    )
    # JSON spec doesn't permit NaN literally; Flask may already 400
    # on the body parse. Either path is acceptable — assert the
    # outcome, not the mechanism.
    assert resp.status_code == 400


def test_post_measurements_rejects_oversized_batch(client, fresh_db):
    _seed_module(fresh_db)
    items = [
        {
            "module_mac": TEST_MAC_1,
            "ts": "2026-05-20T12:00:00",
            "metric": "battery_pct",
            "value": 50.0,
            "source": "esp-heartbeat",
        }
        for _ in range(1001)
    ]
    resp = client.post("/measurements", json={"measurements": items})
    assert resp.status_code == 400
    assert "batch" in resp.get_json()["error"].lower()


def test_post_measurements_batch_atomicity_on_validation_error(client, fresh_db):
    """A batch with one bad row rejects the whole batch — no partial writes."""
    _seed_module(fresh_db)
    resp = client.post(
        "/measurements",
        json={
            "measurements": [
                {
                    "module_mac": TEST_MAC_1,
                    "ts": "2026-05-20T12:00:00",
                    "metric": "battery_pct",
                    "value": 50.0,
                    "source": "esp-heartbeat",
                },
                {
                    "module_mac": "not-a-mac",  # invalid
                    "ts": "2026-05-20T13:00:00",
                    "metric": "battery_pct",
                    "value": 51.0,
                    "source": "esp-heartbeat",
                },
            ]
        },
    )
    assert resp.status_code == 400
    assert resp.get_json()["index"] == 1
    # First row must NOT have been written despite being valid.
    assert _count_measurements(fresh_db, module_mac=TEST_MAC_1) == 0


# ---------- GET /modules/<id>/measurements ----------


def test_get_measurements_invalid_module_id_returns_400(client):
    resp = client.get("/modules/hive-001/measurements?metric=battery_pct")
    assert resp.status_code == 400


def test_get_measurements_unknown_module_returns_404(client):
    resp = client.get("/modules/ffffffffffff/measurements?metric=battery_pct")
    assert resp.status_code == 404


def test_get_measurements_missing_metric_returns_400(client, fresh_db):
    _seed_module(fresh_db)
    resp = client.get(f"/modules/{TEST_MAC_1}/measurements")
    assert resp.status_code == 400
    assert "metric" in resp.get_json()["error"]


def test_get_measurements_invalid_interval_returns_400(client, fresh_db):
    _seed_module(fresh_db)
    resp = client.get(
        f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&interval=weekly"
    )
    assert resp.status_code == 400


def test_get_measurements_invalid_days_returns_400(client, fresh_db):
    _seed_module(fresh_db)
    assert (
        client.get(
            f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&days=0"
        ).status_code
        == 400
    )
    assert (
        client.get(
            f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&days=91"
        ).status_code
        == 400
    )
    assert (
        client.get(
            f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&days=abc"
        ).status_code
        == 400
    )


def test_get_measurements_empty_module_dense_fills_with_null(client, fresh_db):
    """No samples → every bucket emits ``value: null`` and ``sample_count: 0``.

    Critically NOT ``value: 0``: a missing battery reading is unknown,
    not 0%. Dense-fill with ``null`` is the contract; collapsing to 0
    would mis-render a silent device as a flat-line discharge.
    """
    _seed_module(fresh_db)
    resp = client.get(
        f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&interval=hourly&days=1"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["module_id"] == TEST_MAC_1
    assert body["metric"] == "battery_pct"
    assert body["interval"] == "hourly"
    assert len(body["buckets"]) == 24
    assert all(b["value"] is None for b in body["buckets"])
    assert all(b["sample_count"] == 0 for b in body["buckets"])


def test_get_measurements_groups_samples_by_hour_with_avg(client, fresh_db):
    """Three samples in two hourly buckets → AVG per bucket, exact values.

    CLAUDE.md rule 5 — assert real data lands in the expected bucket
    AND that the value is the AVG, not just that the envelope shape
    is right. Pinned the all-zeros aggregation failure mode from
    PR-120 (`date_trunc('day', ts)` returns DATE) at the read layer.
    """
    _seed_module(fresh_db)
    # Two samples in one hour (avg = 80), one sample in the next (avg = 60).
    base = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    ) - timedelta(hours=2)
    _seed_measurement(
        fresh_db, TEST_MAC_1, base + timedelta(minutes=5), "battery_pct", 75, "esp-heartbeat"
    )
    _seed_measurement(
        fresh_db, TEST_MAC_1, base + timedelta(minutes=45), "battery_pct", 85, "esp-heartbeat"
    )
    _seed_measurement(
        fresh_db,
        TEST_MAC_1,
        base + timedelta(hours=1, minutes=10),
        "battery_pct",
        60,
        "esp-heartbeat",
    )

    resp = client.get(
        f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&interval=hourly&days=1"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    non_empty = [b for b in body["buckets"] if b["value"] is not None]
    assert len(non_empty) == 2

    # First non-null bucket: two samples averaged to 80.
    first = next(b for b in non_empty if b["sample_count"] == 2)
    assert first["value"] == 80.0
    # Second non-null bucket: one sample, value 60.
    second = next(b for b in non_empty if b["sample_count"] == 1)
    assert second["value"] == 60.0


def test_get_measurements_daily_groups_samples_by_day(client, fresh_db):
    """`interval=daily` returns one bucket per day, AVG-aggregated.

    Specifically covers the ``date_trunc('day', ts)::TIMESTAMP`` cast
    fix from PR-120 — without the cast, daily-mode keys would be
    "YYYY-MM-DD" and the dense-fill cursor's "YYYY-MM-DDT00:00:00"
    keys would never match. The all-zero / all-null bucket array is
    the symptom that test catches.
    """
    _seed_module(fresh_db)
    today_noon = datetime.now(timezone.utc).replace(
        tzinfo=None, hour=12, minute=0, second=0, microsecond=0
    )
    two_days_ago_noon = today_noon - timedelta(days=2)

    # Three samples today, one sample two days ago.
    _seed_measurement(
        fresh_db,
        TEST_MAC_1,
        today_noon - timedelta(hours=3),
        "battery_pct",
        70,
        "esp-heartbeat",
    )
    _seed_measurement(fresh_db, TEST_MAC_1, today_noon, "battery_pct", 80, "esp-heartbeat")
    _seed_measurement(
        fresh_db,
        TEST_MAC_1,
        today_noon + timedelta(hours=3),
        "battery_pct",
        90,
        "esp-heartbeat",
    )
    _seed_measurement(
        fresh_db, TEST_MAC_1, two_days_ago_noon, "battery_pct", 50, "esp-heartbeat"
    )

    resp = client.get(
        f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&interval=daily&days=7"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["interval"] == "daily"
    assert len(body["buckets"]) == 7
    non_empty = [b for b in body["buckets"] if b["value"] is not None]
    assert len(non_empty) == 2

    # Today: average of 70, 80, 90 = 80, three samples.
    today_bucket = next(b for b in non_empty if b["sample_count"] == 3)
    assert today_bucket["value"] == 80.0
    # Two days ago: single value 50, one sample.
    older_bucket = next(b for b in non_empty if b["sample_count"] == 1)
    assert older_bucket["value"] == 50.0


def test_get_measurements_filters_by_metric(client, fresh_db):
    """A module carrying two metrics returns only the requested one."""
    _seed_module(fresh_db)
    base = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    ) - timedelta(hours=2)
    _seed_measurement(fresh_db, TEST_MAC_1, base, "battery_pct", 75, "esp-heartbeat")
    _seed_measurement(fresh_db, TEST_MAC_1, base, "temperature_c", 22.5, "weather-api")

    resp = client.get(
        f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&interval=hourly&days=1"
    )
    body = resp.get_json()
    non_empty = [b for b in body["buckets"] if b["value"] is not None]
    assert len(non_empty) == 1
    assert non_empty[0]["value"] == 75.0


def test_get_measurements_filters_by_module(client, fresh_db):
    """Samples from other modules must not leak into this module's series."""
    _seed_module(fresh_db, TEST_MAC_1)
    _seed_module(fresh_db, TEST_MAC_2)
    base = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    ) - timedelta(hours=2)
    _seed_measurement(fresh_db, TEST_MAC_1, base, "battery_pct", 75, "esp-heartbeat")
    _seed_measurement(fresh_db, TEST_MAC_2, base, "battery_pct", 30, "esp-heartbeat")

    resp = client.get(
        f"/modules/{TEST_MAC_1}/measurements?metric=battery_pct&interval=hourly&days=1"
    )
    body = resp.get_json()
    non_empty = [b for b in body["buckets"] if b["value"] is not None]
    assert len(non_empty) == 1
    assert non_empty[0]["value"] == 75.0  # not 30, not 52.5


# ---------- heartbeat dual-write ----------


def test_heartbeat_dual_writes_battery_pct_into_measurements(client, fresh_db):
    """POST /heartbeat writes both module_heartbeats AND measurements.

    Issue #110 acceptance: heartbeat is the first real producer wired
    to the canonical store. Without this dual-write, the dashboard
    chart would render empty on production deployments until a future
    backfill ran.
    """
    _seed_module(fresh_db)
    before = _count_measurements(fresh_db, module_mac=TEST_MAC_1)

    resp = client.post(
        "/heartbeat",
        data={"mac": TEST_MAC_1, "battery": "63"},
    )
    assert resp.status_code == 200

    after = _count_measurements(
        fresh_db, module_mac=TEST_MAC_1, metric="battery_pct", source="esp-heartbeat"
    )
    assert after == before + 1

    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT value FROM measurements WHERE module_mac = ? "
            "AND metric = 'battery_pct' AND source = 'esp-heartbeat' "
            "ORDER BY ts DESC LIMIT 1",
            (TEST_MAC_1,),
        ).fetchone()
    finally:
        con.close()
    assert row is not None
    assert row[0] == 63.0


def test_heartbeat_without_battery_skips_dual_write(client, fresh_db):
    """If the heartbeat has no battery, don't fabricate a 0% reading."""
    _seed_module(fresh_db)
    resp = client.post("/heartbeat", data={"mac": TEST_MAC_1, "rssi": "-60"})
    assert resp.status_code == 200
    # module_heartbeats has a row, measurements does not (battery missing).
    assert _count_measurements(fresh_db, module_mac=TEST_MAC_1) == 0


def test_heartbeat_received_at_matches_measurements_ts(client, fresh_db):
    """The two rows the dual-write produces share the same timestamp.

    Drift between the two columns would defeat the canonical-store
    rationale (cross-join queries on `received_at = ts` would miss).
    """
    _seed_module(fresh_db)
    resp = client.post("/heartbeat", data={"mac": TEST_MAC_1, "battery": "42"})
    assert resp.status_code == 200

    con = fresh_db.connection.get_conn()
    try:
        hb_row = con.execute(
            "SELECT received_at FROM module_heartbeats "
            "WHERE module_id = ? ORDER BY id DESC LIMIT 1",
            (TEST_MAC_1,),
        ).fetchone()
        ms_row = con.execute(
            "SELECT ts FROM measurements "
            "WHERE module_mac = ? AND metric = 'battery_pct' "
            "ORDER BY ts DESC LIMIT 1",
            (TEST_MAC_1,),
        ).fetchone()
    finally:
        con.close()
    assert hb_row is not None and ms_row is not None
    assert hb_row[0] == ms_row[0]

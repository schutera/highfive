"""Tests for per-module endpoints used by image-service.

Covers:
* GET  /modules/<id>/progress_count
* POST /modules/<id>/heartbeat
* POST /record_image
"""

# Canonical 12-hex-char ModuleId test fixtures.
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


def _seed_nest(fresh_db, nest_id, module_id, bee_type="blackmasked"):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            (nest_id, module_id, bee_type),
        )
        con.commit()
    finally:
        con.close()


def _seed_progress(fresh_db, progress_id, nest_id, day="2024-06-01"):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO daily_progress (progress_id, nest_id, date, empty, sealed, hatched) "
            "VALUES (?, ?, ?, 0, 50, 0)",
            (progress_id, nest_id, day),
        )
        con.commit()
    finally:
        con.close()


def _fetch_module(fresh_db, module_id):
    con = fresh_db.connection.get_conn()
    try:
        cur = con.execute(
            "SELECT id, battery_level, first_online, image_count "
            "FROM module_configs WHERE id = ?",
            (module_id,),
        )
        cols = [d[0] for d in cur.description]
        row = cur.fetchone()
        return dict(zip(cols, row)) if row else None
    finally:
        con.close()


# ---------- progress_count ----------


def test_progress_count_unknown_module_returns_zero(client):
    # Use a valid canonical-form MAC that simply isn't seeded; the route
    # rejects non-canonical IDs with a 400 now.
    resp = client.get("/modules/ffffffffffff/progress_count")
    assert resp.status_code == 200
    assert resp.get_json() == {"count": 0}


def test_progress_count_invalid_module_id_returns_400(client):
    resp = client.get("/modules/hive-001/progress_count")
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_progress_count_module_no_progress_returns_zero(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.get(f"/modules/{TEST_MAC_1}/progress_count")
    assert resp.status_code == 200
    assert resp.get_json() == {"count": 0}


def test_progress_count_returns_correct_count(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    _seed_module(fresh_db, TEST_MAC_2)  # noise — should not be counted
    _seed_nest(fresh_db, "nest-001", TEST_MAC_1, "blackmasked")
    _seed_nest(fresh_db, "nest-002", TEST_MAC_1, "resin")
    _seed_nest(fresh_db, "nest-003", TEST_MAC_2, "blackmasked")

    # 3 progress rows for TEST_MAC_1 (across two nests), 1 for TEST_MAC_2.
    _seed_progress(fresh_db, "prog-001", "nest-001", "2024-06-01")
    _seed_progress(fresh_db, "prog-002", "nest-001", "2024-06-02")
    _seed_progress(fresh_db, "prog-003", "nest-002", "2024-06-01")
    _seed_progress(fresh_db, "prog-004", "nest-003", "2024-06-01")

    resp = client.get(f"/modules/{TEST_MAC_1}/progress_count")
    assert resp.status_code == 200
    assert resp.get_json() == {"count": 3}

    resp2 = client.get(f"/modules/{TEST_MAC_2}/progress_count")
    assert resp2.status_code == 200
    assert resp2.get_json() == {"count": 1}


# ---------- heartbeat: validation ----------


def test_heartbeat_missing_battery_returns_400(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_heartbeat_battery_negative_returns_400(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={"battery": -1})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_heartbeat_battery_above_100_returns_400(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={"battery": 101})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_heartbeat_battery_non_int_returns_400(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={"battery": "abc"})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_heartbeat_invalid_module_id_returns_400(client):
    resp = client.post("/modules/does-not-exist/heartbeat", json={"battery": 50})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


# ---------- heartbeat: 404 ----------


def test_heartbeat_unknown_module_returns_404(client):
    # A canonical-form MAC that doesn't exist in the DB → 404 (not 400).
    resp = client.post("/modules/ffffffffffff/heartbeat", json={"battery": 50})
    assert resp.status_code == 404
    body = resp.get_json()
    assert body == {"error": "Module not found"}


# ---------- heartbeat: success ----------


def test_heartbeat_updates_battery_and_image_count(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1, image_count=0, battery_level=10)

    resp = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={"battery": 77})
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}

    row = _fetch_module(fresh_db, TEST_MAC_1)
    assert row is not None
    assert row["battery_level"] == 77
    assert row["image_count"] == 1


def test_heartbeat_does_not_clobber_existing_first_online(client, fresh_db):
    """Issue #75: the per-upload heartbeat must NOT overwrite
    `first_online` on every call. Before the COALESCE fix the column
    was rewritten to today's date on every heartbeat, so a module
    onboarded in 2024-01-01 ended up advertising itself as "first
    online today" on every fresh upload. The seed fixture writes
    `'2024-01-01'`; the heartbeat must leave that value intact."""
    _seed_module(fresh_db, TEST_MAC_1, image_count=0, battery_level=10)
    seeded = _fetch_module(fresh_db, TEST_MAC_1)["first_online"]
    assert str(seeded) == "2024-01-01", (
        f"fixture changed under us — _seed_module no longer writes 2024-01-01: {seeded!r}"
    )

    resp = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={"battery": 77})
    assert resp.status_code == 200

    row = _fetch_module(fresh_db, TEST_MAC_1)
    assert str(row["first_online"]) == "2024-01-01", (
        f"heartbeat clobbered first_online (issue #75 regression): {row['first_online']!r}"
    )


def test_heartbeat_increments_image_count_idempotently(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1, image_count=5, battery_level=20)

    r1 = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={"battery": 60})
    assert r1.status_code == 200
    r2 = client.post(f"/modules/{TEST_MAC_1}/heartbeat", json={"battery": 55})
    assert r2.status_code == 200

    row = _fetch_module(fresh_db, TEST_MAC_1)
    assert row["image_count"] == 7
    # Most recent battery is what stuck.
    assert row["battery_level"] == 55
    # first_online untouched by either heartbeat (issue #75).
    assert str(row["first_online"]) == "2024-01-01"


# ---------- record_image ----------


def _fetch_image_uploads(fresh_db, module_id):
    con = fresh_db.connection.get_conn()
    try:
        cur = con.execute(
            "SELECT module_id, filename FROM image_uploads WHERE module_id = ?",
            (module_id,),
        )
        return cur.fetchall()
    finally:
        con.close()


def test_record_image_inserts_row(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.post(
        "/record_image",
        json={"module_id": TEST_MAC_1, "filename": "esp_capture_001.jpg"},
    )
    assert resp.status_code == 200
    assert resp.get_json() == {"message": "Image recorded"}

    rows = _fetch_image_uploads(fresh_db, TEST_MAC_1)
    assert len(rows) == 1
    assert rows[0][0] == TEST_MAC_1
    assert rows[0][1] == "esp_capture_001.jpg"


def test_record_image_missing_module_id_returns_400(client):
    resp = client.post("/record_image", json={"filename": "x.jpg"})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_record_image_missing_filename_returns_400(client):
    resp = client.post("/record_image", json={"module_id": TEST_MAC_1})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_record_image_canonicalises_legacy_colon_mac(client, fresh_db):
    """A direct curl with `AA:BB:CC:DD:EE:FF` lands on the canonical 12-hex
    row. Without this gate at the route, the row would join against zero
    `module_configs` and be invisible to the admin page (the issue #58
    failure mode, one layer down)."""
    _seed_module(fresh_db, TEST_MAC_1)  # TEST_MAC_1 = canonical "aabbccddeeff"
    resp = client.post(
        "/record_image",
        json={"module_id": "AA:BB:CC:DD:EE:FF", "filename": "legacy.jpg"},
    )
    assert resp.status_code == 200

    rows = _fetch_image_uploads(fresh_db, TEST_MAC_1)
    assert len(rows) == 1
    assert rows[0][0] == TEST_MAC_1


def test_record_image_invalid_module_id_returns_400(client):
    resp = client.post(
        "/record_image",
        json={"module_id": "not-a-mac", "filename": "x.jpg"},
    )
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_record_image_stamps_uploaded_at_in_utc(client, fresh_db):
    """Regression pin for ADR-015 review P2: `record_image` stamps UTC,
    not container-local time. Without this, setting TZ=Europe/Berlin on
    the container would put rows 1-2 hours past `activity_timeseries`'s
    window upper bound and the chart would silently drop the most
    recent uploads. Lesson logged in chapter 11.

    The test asserts the stamp is within a tight window of "now UTC" —
    any naive-local writer in a non-UTC container would fail this. The
    container in CI runs UTC, so the test is a "future regression
    canary" rather than a current-bug repro, which is the right kind
    of pin to leave behind for a class-of-bug fix.
    """
    from datetime import datetime, timezone, timedelta

    _seed_module(fresh_db, TEST_MAC_1)
    before = datetime.now(timezone.utc).replace(tzinfo=None)
    resp = client.post(
        "/record_image",
        json={"module_id": TEST_MAC_1, "filename": "stamp.jpg"},
    )
    assert resp.status_code == 200
    after = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=1)

    con = fresh_db.connection.get_conn()
    try:
        cur = con.execute(
            "SELECT uploaded_at FROM image_uploads WHERE filename = ?", ("stamp.jpg",)
        )
        row = cur.fetchone()
    finally:
        con.close()

    assert row is not None
    stamped = row[0]
    # DuckDB returns the timestamp as a naive `datetime`. Drop seconds
    # of slack on either side — the assertion fails iff the stamp is in
    # the wrong timezone band.
    assert (before - timedelta(seconds=2)) <= stamped <= after, (
        f"uploaded_at {stamped!r} not within UTC window "
        f"[{before!r}, {after!r}] — writer drifted to container-local time?"
    )


# ---------- activity_timeseries ----------


def _seed_image_upload(fresh_db, module_id, filename, uploaded_at):
    """Insert an image_uploads row with an explicit timestamp.

    Bypasses the route so we can stage timestamps in the past for the
    bucketing tests — `record_image` always stamps `datetime.now()`.
    """
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO image_uploads (module_id, filename, uploaded_at) "
            "VALUES (?, ?, ?)",
            (module_id, filename, uploaded_at),
        )
        con.commit()
    finally:
        con.close()


def test_activity_timeseries_invalid_module_id_returns_400(client):
    resp = client.get("/modules/hive-001/activity_timeseries")
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_activity_timeseries_unknown_module_returns_404(client):
    resp = client.get("/modules/ffffffffffff/activity_timeseries")
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "Module not found"}


def test_activity_timeseries_invalid_interval_returns_400(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.get(f"/modules/{TEST_MAC_1}/activity_timeseries?interval=weekly")
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["error"] == "invalid interval"


def test_activity_timeseries_invalid_days_returns_400(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_1)
    too_large = client.get(f"/modules/{TEST_MAC_1}/activity_timeseries?days=91")
    assert too_large.status_code == 400

    zero = client.get(f"/modules/{TEST_MAC_1}/activity_timeseries?days=0")
    assert zero.status_code == 400

    non_int = client.get(f"/modules/{TEST_MAC_1}/activity_timeseries?days=abc")
    assert non_int.status_code == 400


def test_activity_timeseries_empty_module_fills_zero_buckets(client, fresh_db):
    """No uploads → every bucket in the window emits count=0.

    Without server-side gap-fill the chart would render an empty
    series and look indistinguishable from an outage. The dense
    series with explicit zeros is the contract.
    """
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.get(
        f"/modules/{TEST_MAC_1}/activity_timeseries?interval=hourly&days=1"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["module_id"] == TEST_MAC_1
    assert body["interval"] == "hourly"
    # 1 day, hourly → exactly 24 buckets.
    assert len(body["buckets"]) == 24
    assert all(b["count"] == 0 for b in body["buckets"])


def test_activity_timeseries_groups_uploads_by_hour(client, fresh_db):
    """Two uploads in the same hour → one bucket with count=2."""
    from datetime import datetime, timezone, timedelta

    _seed_module(fresh_db, TEST_MAC_1)
    # Pick a timestamp well inside the default 7-day window.
    base = datetime.now(timezone.utc).replace(
        tzinfo=None, minute=0, second=0, microsecond=0
    ) - timedelta(hours=2)

    _seed_image_upload(fresh_db, TEST_MAC_1, "a.jpg", base + timedelta(minutes=5))
    _seed_image_upload(fresh_db, TEST_MAC_1, "b.jpg", base + timedelta(minutes=45))
    _seed_image_upload(
        fresh_db, TEST_MAC_1, "c.jpg", base + timedelta(hours=1, minutes=10)
    )

    resp = client.get(
        f"/modules/{TEST_MAC_1}/activity_timeseries?interval=hourly&days=1"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    non_zero = [b for b in body["buckets"] if b["count"] > 0]
    assert len(non_zero) == 2
    # Two in the earlier hour, one in the next.
    counts = sorted(b["count"] for b in non_zero)
    assert counts == [1, 2]


def test_activity_timeseries_daily_interval(client, fresh_db):
    """`interval=daily` returns one bucket per day."""
    _seed_module(fresh_db, TEST_MAC_1)
    resp = client.get(
        f"/modules/{TEST_MAC_1}/activity_timeseries?interval=daily&days=7"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["interval"] == "daily"
    assert len(body["buckets"]) == 7


def test_activity_timeseries_daily_groups_uploads_by_day(client, fresh_db):
    """Seeded uploads MUST land in their day-bucket on the daily path.

    Regression pin for the PR-120 manual-test bug: `date_trunc('day', ts)`
    returns a DATE in DuckDB (handed back to Python as `datetime.date`),
    whereas `date_trunc('hour', ts)` returns a TIMESTAMP (`datetime`).
    The route's bucket-key normalisation used `isinstance(bucket,
    datetime)` and fell through to `str(bucket)` for the date case,
    producing keys like "2026-05-20" that never matched the dense-fill
    cursor's "2026-05-20T00:00:00". Result: every daily bucket silently
    rendered `count: 0` regardless of how many uploads existed.
    The existing `test_activity_timeseries_daily_interval` only asserts
    bucket *count* (which still hits 7 with all zeros), so the bug
    survived. This test asserts that data lands in the daily bucket.
    """
    from datetime import datetime, timezone, timedelta

    _seed_module(fresh_db, TEST_MAC_1)
    # Cluster all seeded stamps around midday so even a test run that
    # straddles UTC midnight between this `now` and the route's own
    # `datetime.now(timezone.utc)` (inside the request handler) lands
    # all four stamps in the same calendar day from both clocks. A
    # midnight-adjacent test could see "today" become "yesterday"
    # between seed time and read time, flaking the bucket assertion.
    now = datetime.now(timezone.utc).replace(
        tzinfo=None, hour=12, minute=0, second=0, microsecond=0
    )
    today_noon = now
    two_days_ago_noon = today_noon - timedelta(days=2)
    _seed_image_upload(fresh_db, TEST_MAC_1, "t1.jpg", today_noon - timedelta(hours=3))
    _seed_image_upload(fresh_db, TEST_MAC_1, "t2.jpg", today_noon)
    _seed_image_upload(fresh_db, TEST_MAC_1, "t3.jpg", today_noon + timedelta(hours=3))
    _seed_image_upload(fresh_db, TEST_MAC_1, "p1.jpg", two_days_ago_noon)

    resp = client.get(
        f"/modules/{TEST_MAC_1}/activity_timeseries?interval=daily&days=7"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    non_zero = {b["timestamp"]: b["count"] for b in body["buckets"] if b["count"] > 0}
    # Asserting against the exact bucket keys derived from `today_noon`
    # rather than the route's "today" — both clocks now agree on the
    # calendar day because all stamps are midday-aligned.
    today_bucket_key = today_noon.replace(hour=0).isoformat()
    two_days_ago_bucket_key = two_days_ago_noon.replace(hour=0).isoformat()
    assert non_zero == {
        today_bucket_key: 3,
        two_days_ago_bucket_key: 1,
    }, f"daily buckets did not aggregate as expected: {non_zero!r}"


def test_activity_timeseries_excludes_other_modules(client, fresh_db):
    """Activity for another module must not bleed into the result."""
    from datetime import datetime, timezone, timedelta

    _seed_module(fresh_db, TEST_MAC_1)
    _seed_module(fresh_db, TEST_MAC_2)
    recent = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
    _seed_image_upload(fresh_db, TEST_MAC_2, "noise.jpg", recent)

    resp = client.get(
        f"/modules/{TEST_MAC_1}/activity_timeseries?interval=hourly&days=1"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert all(b["count"] == 0 for b in body["buckets"])

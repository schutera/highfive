"""Tests for per-module endpoints used by image-service.

Covers:
* GET /modules/<id>/progress_count
* POST /modules/<id>/heartbeat
"""

from datetime import date


def _seed_module(fresh_db, module_id="hive-001", image_count=0, battery_level=None):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, status, first_online, "
            "battery_level, image_count) "
            "VALUES (?, 'Seed', 47.8, 9.6, 'online', '2024-01-01', ?, ?)",
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
    resp = client.get("/modules/does-not-exist/progress_count")
    assert resp.status_code == 200
    assert resp.get_json() == {"count": 0}


def test_progress_count_module_no_progress_returns_zero(client, fresh_db):
    _seed_module(fresh_db, "hive-001")
    resp = client.get("/modules/hive-001/progress_count")
    assert resp.status_code == 200
    assert resp.get_json() == {"count": 0}


def test_progress_count_returns_correct_count(client, fresh_db):
    _seed_module(fresh_db, "hive-001")
    _seed_module(fresh_db, "hive-002")  # noise — should not be counted
    _seed_nest(fresh_db, "nest-001", "hive-001", "blackmasked")
    _seed_nest(fresh_db, "nest-002", "hive-001", "resin")
    _seed_nest(fresh_db, "nest-003", "hive-002", "blackmasked")

    # 3 progress rows for hive-001 (across two nests), 1 for hive-002.
    _seed_progress(fresh_db, "prog-001", "nest-001", "2024-06-01")
    _seed_progress(fresh_db, "prog-002", "nest-001", "2024-06-02")
    _seed_progress(fresh_db, "prog-003", "nest-002", "2024-06-01")
    _seed_progress(fresh_db, "prog-004", "nest-003", "2024-06-01")

    resp = client.get("/modules/hive-001/progress_count")
    assert resp.status_code == 200
    assert resp.get_json() == {"count": 3}

    resp2 = client.get("/modules/hive-002/progress_count")
    assert resp2.status_code == 200
    assert resp2.get_json() == {"count": 1}


# ---------- heartbeat: validation ----------


def test_heartbeat_missing_battery_returns_400(client, fresh_db):
    _seed_module(fresh_db, "hive-001")
    resp = client.post("/modules/hive-001/heartbeat", json={})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_heartbeat_battery_negative_returns_400(client, fresh_db):
    _seed_module(fresh_db, "hive-001")
    resp = client.post("/modules/hive-001/heartbeat", json={"battery": -1})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_heartbeat_battery_above_100_returns_400(client, fresh_db):
    _seed_module(fresh_db, "hive-001")
    resp = client.post("/modules/hive-001/heartbeat", json={"battery": 101})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_heartbeat_battery_non_int_returns_400(client, fresh_db):
    _seed_module(fresh_db, "hive-001")
    resp = client.post("/modules/hive-001/heartbeat", json={"battery": "abc"})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


# ---------- heartbeat: 404 ----------


def test_heartbeat_unknown_module_returns_404(client):
    resp = client.post(
        "/modules/does-not-exist/heartbeat", json={"battery": 50}
    )
    assert resp.status_code == 404
    body = resp.get_json()
    assert body == {"error": "Module not found"}


# ---------- heartbeat: success ----------


def test_heartbeat_updates_battery_first_online_and_image_count(client, fresh_db):
    _seed_module(fresh_db, "hive-001", image_count=0, battery_level=10)

    resp = client.post("/modules/hive-001/heartbeat", json={"battery": 77})
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}

    row = _fetch_module(fresh_db, "hive-001")
    assert row is not None
    assert row["battery_level"] == 77
    assert row["image_count"] == 1
    # first_online stored as DATE — normalise to ISO string for comparison.
    assert str(row["first_online"]) == date.today().isoformat()


def test_heartbeat_increments_image_count_idempotently(client, fresh_db):
    _seed_module(fresh_db, "hive-001", image_count=5, battery_level=20)

    r1 = client.post("/modules/hive-001/heartbeat", json={"battery": 60})
    assert r1.status_code == 200
    r2 = client.post("/modules/hive-001/heartbeat", json={"battery": 55})
    assert r2.status_code == 200

    row = _fetch_module(fresh_db, "hive-001")
    assert row["image_count"] == 7
    # Most recent battery is what stuck.
    assert row["battery_level"] == 55
    assert str(row["first_online"]) == date.today().isoformat()

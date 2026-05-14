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

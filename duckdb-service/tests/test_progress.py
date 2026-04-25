from datetime import date


def _seed_module(fresh_db, module_id="hive-001"):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, status, first_online) "
            "VALUES (?, 'Seed', 47.8, 9.6, 'online', '2024-01-01')",
            (module_id,),
        )
        con.commit()
    finally:
        con.close()


def _query(fresh_db, sql, params=()):
    con = fresh_db.connection.get_conn()
    try:
        cur = con.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        con.close()


def test_get_progress_empty(client):
    resp = client.get("/progress")
    assert resp.status_code == 200
    assert resp.get_json() == {"progress": []}


def test_get_progress_field_names_use_progress_id_and_hatched(client, fresh_db):
    # Seed one nest + one progress row.
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, status, first_online) "
            "VALUES ('hive-001', 'Seed', 47.8, 9.6, 'online', '2024-01-01')"
        )
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES "
            "('nest-001', 'hive-001', 'blackmasked')"
        )
        con.execute(
            "INSERT INTO daily_progress (progress_id, nest_id, date, empty, sealed, hatched) "
            "VALUES ('prog-001', 'nest-001', '2024-06-01', 5, 45, 15)"
        )
        con.commit()
    finally:
        con.close()

    rows = client.get("/progress").get_json()["progress"]
    assert len(rows) == 1
    row = rows[0]
    assert "progress_id" in row
    assert "hatched" in row
    assert row["progress_id"] == "prog-001"
    assert row["nest_id"] == "nest-001"
    assert row["empty"] == 5
    assert row["sealed"] == 45
    assert row["hatched"] == 15


def test_add_progress_for_module_creates_nests_and_rows(client, fresh_db):
    _seed_module(fresh_db, "hive-001")

    # ClassificationOutput is Dict[str, Dict[int, int]] (strict int values).
    # image-service/stub_classify() emits 0 or 1 per cell, which become 0 or
    # 100 in the DB (route does int(sealed * 100)).
    payload = {
        "modul_id": "hive-001",
        "classification": {
            "black_masked_bee": {"0": 1, "1": 0},
            "resin_bee": {"0": 0, "1": 1, "2": 1, "3": 0},
        },
    }
    resp = client.post("/add_progress_for_module", json=payload)
    assert resp.status_code == 200
    assert resp.get_json() == {"success": True}

    # Should have created TARGET_NESTS_PER_TYPE (4) nests per requested type.
    nests = _query(fresh_db, "SELECT nest_id, beeType FROM nest_data ORDER BY nest_id")
    by_type: dict[str, list[str]] = {}
    for n in nests:
        by_type.setdefault(n["beeType"], []).append(n["nest_id"])
    assert len(by_type["blackmasked"]) == 4
    assert len(by_type["resin"]) == 4

    # daily_progress: 4 + 4 = 8 rows for today, sealed = int(value * 100).
    today = date.today().isoformat()
    progress = _query(
        fresh_db,
        "SELECT nest_id, sealed, empty, hatched, date FROM daily_progress",
    )
    assert len(progress) == 8
    for row in progress:
        # DuckDB returns DATE as datetime.date — normalise.
        assert str(row["date"]) == today
        assert row["empty"] == 0
        assert row["hatched"] == 0

    # Blackmasked supplied 2 values [1, 0], padded by repeating last →
    # [1, 0, 0, 0] → [100, 0, 0, 0].
    bm_nests = sorted(by_type["blackmasked"])
    bm_sealed = []
    for nid in bm_nests:
        cur = fresh_db.connection.get_conn()
        try:
            row = cur.execute(
                "SELECT sealed FROM daily_progress WHERE nest_id = ?", (nid,)
            ).fetchone()
            bm_sealed.append(row[0])
        finally:
            cur.close()
    assert bm_sealed == [100, 0, 0, 0]

    # Resin: [0, 1, 1, 0] → [0, 100, 100, 0].
    resin_nests = sorted(by_type["resin"])
    resin_sealed = []
    for nid in resin_nests:
        cur = fresh_db.connection.get_conn()
        try:
            row = cur.execute(
                "SELECT sealed FROM daily_progress WHERE nest_id = ?", (nid,)
            ).fetchone()
            resin_sealed.append(row[0])
        finally:
            cur.close()
    assert resin_sealed == [0, 100, 100, 0]


def test_add_progress_skips_unknown_bee_type(client, fresh_db):
    _seed_module(fresh_db, "hive-002")

    payload = {
        "modul_id": "hive-002",
        "classification": {
            "not_a_real_bee": {"0": 0.5},
            "leafcutter_bee": {"0": 0.10},
        },
    }
    resp = client.post("/add_progress_for_module", json=payload)
    assert resp.status_code == 200

    nests = _query(fresh_db, "SELECT beeType FROM nest_data")
    types = {n["beeType"] for n in nests}
    assert "leafcutter" in types
    # Unknown payload key is dropped — no rows for it.
    assert len(nests) == 4  # only leafcutter, padded to TARGET_NESTS_PER_TYPE


def test_add_progress_reuses_existing_nests(client, fresh_db):
    _seed_module(fresh_db, "hive-003")

    # Pre-seed 4 leafcutter nests (already at target).
    con = fresh_db.connection.get_conn()
    try:
        for i in range(1, 5):
            con.execute(
                "INSERT INTO nest_data (nest_id, module_id, beeType) "
                "VALUES (?, 'hive-003', 'leafcutter')",
                (f"nest-{i:03d}",),
            )
        con.commit()
    finally:
        con.close()

    payload = {
        "modul_id": "hive-003",
        "classification": {"leafcutter_bee": {"0": 0.25}},
    }
    resp = client.post("/add_progress_for_module", json=payload)
    assert resp.status_code == 200

    # No new nests created.
    nests = _query(fresh_db, "SELECT nest_id FROM nest_data")
    assert len(nests) == 4

    # 4 progress rows for the existing nests, sealed = 25.
    progress = _query(fresh_db, "SELECT sealed FROM daily_progress")
    assert len(progress) == 4
    assert all(p["sealed"] == 25 for p in progress)

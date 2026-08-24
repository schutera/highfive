from datetime import date

# Canonical 12-hex-char ModuleId test fixtures.
TEST_MAC_1 = "aabbccddeeff"
TEST_MAC_2 = "001122334455"
TEST_MAC_3 = "112233445566"


def _seed_module(fresh_db, module_id=TEST_MAC_1):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online) "
            "VALUES (?, 'Seed', 47.8, 9.6, '2024-01-01')",
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
        return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
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
            "INSERT INTO module_configs (id, name, lat, lng, first_online) "
            f"VALUES ('{TEST_MAC_1}', 'Seed', 47.8, 9.6, '2024-01-01')"
        )
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES "
            f"('nest-001', '{TEST_MAC_1}', 'blackmasked')"
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
    _seed_module(fresh_db, TEST_MAC_1)

    # ClassificationOutput is Dict[str, Dict[int, int]] (strict int values).
    # image-service/stub_classify() emits 0 or 1 per cell, which become 0 or
    # 100 in the DB (route does int(sealed * 100)).
    payload = {
        "module_id": TEST_MAC_1,
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


def test_add_progress_rejects_legacy_modul_id_typo(client, fresh_db):
    """Deprecation window CLOSED (2026-07 audit, for #207): the legacy
    ``modul_id`` typo is no longer accepted — clean 400, no write."""
    _seed_module(fresh_db, TEST_MAC_1)
    payload = {
        "modul_id": TEST_MAC_1,  # legacy typo'd name
        "classification": {"leafcutter_bee": {"0": 0.5}},
    }
    resp = client.post("/add_progress_for_module", json=payload)
    assert resp.status_code == 400
    assert _query(fresh_db, "SELECT * FROM daily_progress") == []


def test_add_progress_skips_unknown_bee_type(client, fresh_db):
    _seed_module(fresh_db, TEST_MAC_2)

    payload = {
        "module_id": TEST_MAC_2,
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
    _seed_module(fresh_db, TEST_MAC_3)

    # Pre-seed 4 leafcutter nests (already at target).
    con = fresh_db.connection.get_conn()
    try:
        for i in range(1, 5):
            con.execute(
                "INSERT INTO nest_data (nest_id, module_id, beeType) "
                f"VALUES (?, '{TEST_MAC_3}', 'leafcutter')",
                (f"nest-{i:03d}",),
            )
        con.commit()
    finally:
        con.close()

    payload = {
        "module_id": TEST_MAC_3,
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


# ------------- robustness + filters (2026-07 audit, for #205) -------------


def _seed_progress_matrix(fresh_db):
    """Two modules, one nest each, three dated rows for module 1 and one
    for module 2 — enough to pin filtering, windowing, and ordering."""
    con = fresh_db.connection.get_conn()
    try:
        for mac, nest in ((TEST_MAC_1, "nest-101"), (TEST_MAC_2, "nest-201")):
            con.execute(
                "INSERT INTO module_configs (id, name, lat, lng, first_online) "
                "VALUES (?, 'Seed', 47.8, 9.6, '2024-01-01')",
                (mac,),
            )
            con.execute(
                "INSERT INTO nest_data (nest_id, module_id, beeType) "
                "VALUES (?, ?, 'blackmasked')",
                (nest, mac),
            )
        for pid, nest, day, sealed in (
            ("p1", "nest-101", "2026-07-01", 10),
            ("p2", "nest-101", "2026-07-02", 20),
            ("p3", "nest-101", "2026-07-03", 30),
            ("p4", "nest-201", "2026-07-02", 99),
        ):
            con.execute(
                "INSERT INTO daily_progress "
                "(progress_id, nest_id, date, empty, sealed, hatched) "
                "VALUES (?, ?, ?, 0, ?, 0)",
                (pid, nest, day, sealed),
            )
        con.commit()
    finally:
        con.close()


def test_add_progress_non_json_body_returns_400(client):
    resp = client.post(
        "/add_progress_for_module", data="not json", content_type="text/plain"
    )
    assert resp.status_code == 400


def test_add_progress_empty_object_returns_400(client):
    resp = client.post("/add_progress_for_module", json={})
    assert resp.status_code == 400
    assert "invalid classification payload" in resp.get_json()["error"]


def test_add_progress_json_array_returns_400(client):
    resp = client.post("/add_progress_for_module", json=[1, 2, 3])
    assert resp.status_code == 400


def test_add_progress_bad_classification_shape_returns_400(client):
    resp = client.post(
        "/add_progress_for_module",
        json={"module_id": TEST_MAC_1, "classification": "not-a-dict"},
    )
    assert resp.status_code == 400


def test_get_progress_module_filter_returns_only_that_modules_rows(client, fresh_db):
    _seed_progress_matrix(fresh_db)
    rows = client.get(f"/progress?module_id={TEST_MAC_2}").get_json()["progress"]
    assert [r["progress_id"] for r in rows] == ["p4"]
    assert rows[0]["sealed"] == 99


def test_get_progress_module_filter_accepts_legacy_colon_form(client, fresh_db):
    _seed_progress_matrix(fresh_db)
    rows = client.get("/progress?module_id=AA:BB:CC:DD:EE:FF").get_json()["progress"]
    assert [r["progress_id"] for r in rows] == ["p1", "p2", "p3"]


def test_get_progress_invalid_module_id_returns_400(client):
    assert client.get("/progress?module_id=nope").status_code == 400


def test_get_progress_date_window_is_inclusive(client, fresh_db):
    _seed_progress_matrix(fresh_db)
    rows = client.get("/progress?since=2026-07-02&until=2026-07-02").get_json()[
        "progress"
    ]
    assert sorted(r["progress_id"] for r in rows) == ["p2", "p4"]


def test_get_progress_invalid_date_returns_400(client):
    assert client.get("/progress?since=notadate").status_code == 400


def test_get_progress_limit_keeps_most_recent_and_stays_ascending(client, fresh_db):
    """The latest-is-last invariant is load-bearing for the backend's
    totalHatches roll-up: limit must trim the OLDEST rows and the
    response must stay date-ascending."""
    _seed_progress_matrix(fresh_db)
    rows = client.get(f"/progress?module_id={TEST_MAC_1}&limit=2").get_json()[
        "progress"
    ]
    assert [r["progress_id"] for r in rows] == ["p2", "p3"]
    # jsonify serialises DATE columns as HTTP-dates ("Thu, 02 Jul 2026 …");
    # assert on the day-of-month tokens rather than an ISO prefix.
    assert [r["date"].split(", ")[1][:2] for r in rows] == ["02", "03"]


def test_get_progress_invalid_limit_returns_400(client):
    assert client.get("/progress?limit=0").status_code == 400
    assert client.get("/progress?limit=-3").status_code == 400
    assert client.get("/progress?limit=abc").status_code == 400
    # Unicode superscript: isdigit()-True but int()-invalid — must be a
    # clean 400, not a 500 (review-caught).
    assert client.get("/progress?limit=³").status_code == 400


def test_get_progress_unfiltered_stays_legacy_shaped(client, fresh_db):
    _seed_progress_matrix(fresh_db)
    rows = client.get("/progress").get_json()["progress"]
    assert len(rows) == 4
    assert [r["progress_id"] for r in rows] == ["p1", "p2", "p4", "p3"]


def test_date_filters_reject_non_dashed_forms_identically_on_every_python(
    client, fresh_db
):
    """`since`/`until` accept ONLY `YYYY-MM-DD`, on 3.10 through 3.14.

    `date.fromisoformat` widened in 3.11 to accept the basic form
    (`20260719`) and ISO week dates (`2026-W29-1`). Since CI runs a 3.10-3.14
    matrix (ADR-029), using it would make the same query string 400 on 3.10
    and 200 on 3.12 — an interpreter-dependent API contract. The route uses
    strptime so the grammar is identical everywhere, and these assertions fail
    on any Python if someone swaps it back.
    """
    for bad in ("20260719", "2026-W29-1", "2026-07-19T00:00:00", "not-a-date", ""):
        resp = client.get(f"/progress?since={bad}")
        assert resp.status_code == 400, (
            f"{bad!r} should be rejected, got {resp.status_code}"
        )
        assert "YYYY-MM-DD" in resp.get_json()["error"]

    # The documented form is still accepted.
    assert client.get("/progress?since=2026-07-19").status_code == 200
    assert client.get("/progress?until=2026-07-19").status_code == 200

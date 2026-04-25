def _seed_module_and_nests(fresh_db):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, status, first_online) "
            "VALUES ('hive-001', 'Seed', 47.8, 9.6, 'online', '2024-01-01')"
        )
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES "
            "('nest-001', 'hive-001', 'blackmasked'), "
            "('nest-002', 'hive-001', 'resin')"
        )
        con.commit()
    finally:
        con.close()


def test_get_nests_empty(client):
    resp = client.get("/nests")
    assert resp.status_code == 200
    assert resp.get_json() == {"nests": []}


def test_get_nests_returns_seeded_rows(client, fresh_db):
    _seed_module_and_nests(fresh_db)
    resp = client.get("/nests")
    assert resp.status_code == 200
    nests = resp.get_json()["nests"]
    assert len(nests) == 2
    by_id = {n["nest_id"]: n for n in nests}
    assert by_id["nest-001"]["module_id"] == "hive-001"
    assert by_id["nest-001"]["beeType"] == "blackmasked"
    assert by_id["nest-002"]["beeType"] == "resin"

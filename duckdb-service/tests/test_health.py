def test_health_returns_ok_and_db_path(client, fresh_db):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True
    assert body["db"] == fresh_db.db_path

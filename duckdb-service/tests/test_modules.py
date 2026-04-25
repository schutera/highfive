def _valid_payload(**overrides):
    payload = {
        "esp_id": "AA:BB:CC:DD:EE:FF",
        "module_name": "TestHive",
        "latitude": 47.8086,
        "longitude": 9.6433,
        "battery_level": 80,
    }
    payload.update(overrides)
    return payload


def test_get_modules_empty(client):
    resp = client.get("/modules")
    assert resp.status_code == 200
    assert resp.get_json() == {"modules": []}


def test_new_module_creates_row_and_calls_discord(client, fresh_db):
    resp = client.post("/new_module", json=_valid_payload())
    assert resp.status_code == 200, resp.get_json()
    body = resp.get_json()
    assert body["id"] == "AA:BB:CC:DD:EE:FF"
    assert body["message"] == "Module added successfully"

    # Discord webhook spy should have been called once.
    assert len(fresh_db.discord_calls) == 1
    msg = fresh_db.discord_calls[0]
    assert "TestHive" in msg
    assert "AA:BB:CC:DD:EE:FF" in msg
    assert "80" in msg

    # And the row should be visible via /modules.
    listed = client.get("/modules").get_json()["modules"]
    assert len(listed) == 1
    assert listed[0]["id"] == "AA:BB:CC:DD:EE:FF"
    assert listed[0]["name"] == "TestHive"
    assert listed[0]["battery_level"] == 80


def test_new_module_battery_above_100_returns_400(client):
    resp = client.post("/new_module", json=_valid_payload(battery_level=150))
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_new_module_battery_below_zero_returns_400(client):
    resp = client.post("/new_module", json=_valid_payload(battery_level=-1))
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_new_module_missing_required_field_returns_400(client):
    payload = _valid_payload()
    payload.pop("module_name")
    resp = client.post("/new_module", json=payload)
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_new_module_same_id_twice_replaces_row(client, fresh_db):
    first = client.post("/new_module", json=_valid_payload(module_name="First"))
    assert first.status_code == 200
    second = client.post(
        "/new_module",
        json=_valid_payload(module_name="Second", battery_level=42),
    )
    assert second.status_code == 200

    listed = client.get("/modules").get_json()["modules"]
    assert len(listed) == 1
    assert listed[0]["name"] == "Second"
    assert listed[0]["battery_level"] == 42
    # Two successful creates -> two webhook calls.
    assert len(fresh_db.discord_calls) == 2


def test_test_insert_and_remove_test_smoke(client):
    insert_resp = client.post("/test_insert")
    assert insert_resp.status_code == 200
    assert insert_resp.get_json() == {"success": True}

    listed = client.get("/modules").get_json()["modules"]
    assert any(m["id"] == "hive-091" for m in listed)

    remove_resp = client.post("/remove_test")
    assert remove_resp.status_code == 200
    assert remove_resp.get_json() == {"success": True}

    listed_after = client.get("/modules").get_json()["modules"]
    assert not any(m["id"] == "hive-091" for m in listed_after)

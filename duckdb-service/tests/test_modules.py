TEST_MAC = "aabbccddeeff"  # canonical ModuleId form
TEST_MAC_LEGACY = "AA:BB:CC:DD:EE:FF"  # canonicalises to TEST_MAC


def _valid_payload(**overrides):
    payload = {
        "esp_id": TEST_MAC,
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
    assert body["id"] == TEST_MAC
    assert body["message"] == "Module added successfully"

    # Discord webhook spy should have been called once.
    assert len(fresh_db.discord_calls) == 1
    msg = fresh_db.discord_calls[0]
    assert "TestHive" in msg
    assert TEST_MAC in msg
    assert "80" in msg

    # And the row should be visible via /modules.
    listed = client.get("/modules").get_json()["modules"]
    assert len(listed) == 1
    assert listed[0]["id"] == TEST_MAC
    assert listed[0]["name"] == "TestHive"
    assert listed[0]["battery_level"] == 80


def test_new_module_canonicalises_legacy_colon_form(client, fresh_db):
    """Inbound colon-separated/uppercase MACs are normalised to canonical."""
    resp = client.post("/new_module", json=_valid_payload(esp_id=TEST_MAC_LEGACY))
    assert resp.status_code == 200, resp.get_json()
    body = resp.get_json()
    # Stored & echoed as the canonical 12-hex form, regardless of input shape.
    assert body["id"] == TEST_MAC

    listed = client.get("/modules").get_json()["modules"]
    assert listed[0]["id"] == TEST_MAC


def test_new_module_invalid_mac_returns_400(client):
    resp = client.post("/new_module", json=_valid_payload(esp_id="hive-001"))
    assert resp.status_code == 400
    assert "error" in resp.get_json()


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


def test_get_modules_returns_json_500_on_query_failure(client, monkeypatch):
    """Pin behaviour from issue #32: an uncaught DB exception must surface as
    parseable JSON with status 500, not the Flask default HTML page that the
    Node backend can't deserialize (and would have masked as a generic 502)."""
    import routes.modules as routes_modules

    def boom(*_args, **_kwargs):
        raise RuntimeError("synthetic duckdb failure")

    monkeypatch.setattr(routes_modules, "query_all", boom)

    resp = client.get("/modules")
    assert resp.status_code == 500
    assert resp.is_json, "fallback HTML 500 would crash the JSON-parsing backend"
    body = resp.get_json()
    assert "error" in body
    assert "synthetic duckdb failure" in body["error"]
    # No silent `modules: []` fallback — a body without a modules key
    # forces any consumer that ignores the status to TypeError on
    # data.modules.map rather than render an empty fleet.
    assert "modules" not in body


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


def test_new_module_rejects_uint64_decimal_str_too_long(client):
    # Issue #39 regression: firmware previously called String(uint64) on the
    # eFuse MAC, which produces a 15–20 digit decimal that exceeds the 12-char
    # canonical ModuleId regex `^[0-9a-f]{12}$`. This test pins the LENGTH
    # rejection at the validator boundary — the chosen sample (15 digits)
    # would also pass [0-9a-f] character-wise, which makes it a faithful
    # reproduction of what the buggy firmware actually posted. A hypothetical
    # 12-digit decimal MAC would still pass the regex (digits are valid
    # hex); that is intentional in the canonical contract, not a bug here.
    resp = client.post("/new_module", json=_valid_payload(esp_id="193966879422984"))
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


# ---------- display_name override + auto-suffix collision (PR I — #93/#94) ----------


TEST_MAC_A = "aabbccddee01"
TEST_MAC_B = "aabbccddee02"
TEST_MAC_C = "aabbccddee03"


def _payload(mac, name="ShareName"):
    return {
        "esp_id": mac,
        "module_name": name,
        "latitude": 47.8086,
        "longitude": 9.6433,
        "battery_level": 80,
    }


def test_add_module_auto_suffixes_colliding_firmware_names(client, fresh_db):
    """Two distinct modules registering the same firmware-reported name
    don't both end up as `ShareName`. The second one becomes `ShareName-2`,
    the response body echoes the stored value, and the dashboard listing
    reflects the disambiguation. Closes #94."""
    r1 = client.post("/new_module", json=_payload(TEST_MAC_A, "ShareName"))
    assert r1.status_code == 200
    body1 = r1.get_json()
    assert body1["id"] == TEST_MAC_A
    assert body1["name"] == "ShareName", body1

    r2 = client.post("/new_module", json=_payload(TEST_MAC_B, "ShareName"))
    assert r2.status_code == 200
    body2 = r2.get_json()
    assert body2["id"] == TEST_MAC_B
    assert body2["name"] == "ShareName-2", body2

    # A third collision goes to -3.
    r3 = client.post("/new_module", json=_payload(TEST_MAC_C, "ShareName"))
    assert r3.status_code == 200
    assert r3.get_json()["name"] == "ShareName-3"

    listed = {m["id"]: m["name"] for m in client.get("/modules").get_json()["modules"]}
    assert listed[TEST_MAC_A] == "ShareName"
    assert listed[TEST_MAC_B] == "ShareName-2"
    assert listed[TEST_MAC_C] == "ShareName-3"


def test_add_module_reregistration_keeps_existing_name(client, fresh_db):
    """Re-registering the same MAC with the same firmware-reported name
    is a no-op on the suffix logic — the collision check excludes the
    row's own id, so we don't accidentally re-suffix every boot."""
    r1 = client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    assert r1.status_code == 200
    assert r1.get_json()["name"] == "BeeOne"

    # Same MAC, same name -> still BeeOne (the second insert is the UPSERT
    # path; the pre-check sees a self-match and skips suffixing).
    r2 = client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    assert r2.status_code == 200
    assert r2.get_json()["name"] == "BeeOne"


def test_get_modules_includes_display_name_field(client, fresh_db):
    """The wire shape exposes display_name (null by default). The homepage
    coalesces; the field's presence in every row is the contract that
    makes that coalesce safe."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    rows = client.get("/modules").get_json()["modules"]
    assert len(rows) == 1
    assert "display_name" in rows[0]
    assert rows[0]["display_name"] is None


def test_patch_display_name_sets_and_clears(client, fresh_db):
    """Happy path: set a display_name on a module, then clear it again.
    Both 200; the GET response reflects the latest state both times."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))

    r = client.patch(
        f"/modules/{TEST_MAC_A}/display_name",
        json={"display_name": "Garden Bee"},
    )
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["display_name"] == "Garden Bee"

    rows = client.get("/modules").get_json()["modules"]
    assert rows[0]["display_name"] == "Garden Bee"

    # Clear with null.
    r = client.patch(
        f"/modules/{TEST_MAC_A}/display_name",
        json={"display_name": None},
    )
    assert r.status_code == 200
    assert r.get_json()["display_name"] is None

    rows = client.get("/modules").get_json()["modules"]
    assert rows[0]["display_name"] is None


def test_patch_display_name_collision_returns_409(client, fresh_db):
    """Two modules cannot share a display_name. The 409 body carries the
    name and the conflicting MAC so the admin UI can render a useful
    inline error."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    client.post("/new_module", json=_payload(TEST_MAC_B, "BeeTwo"))

    r1 = client.patch(
        f"/modules/{TEST_MAC_A}/display_name", json={"display_name": "Garden Bee"}
    )
    assert r1.status_code == 200

    r2 = client.patch(
        f"/modules/{TEST_MAC_B}/display_name", json={"display_name": "Garden Bee"}
    )
    assert r2.status_code == 409
    body = r2.get_json()
    assert body["display_name"] == "Garden Bee"
    assert body["conflicting_module_id"] == TEST_MAC_A


def test_patch_display_name_unknown_module_returns_404(client, fresh_db):
    """Targeting a module that doesn't exist returns 404 even with a
    canonical-form id. (Invalid-shape ids are 400 — covered by
    `_canonicalize_or_400`.)"""
    r = client.patch(
        "/modules/ffffffffffff/display_name", json={"display_name": "Anything"}
    )
    assert r.status_code == 404


def test_patch_display_name_rejects_missing_key(client, fresh_db):
    """The body must include the `display_name` key — an empty body is
    a 400, not an accidental clear."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    r = client.patch(f"/modules/{TEST_MAC_A}/display_name", json={})
    assert r.status_code == 400


def test_patch_display_name_rejects_non_string(client, fresh_db):
    """display_name must be a string or null; numbers/bools/etc are 400."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    r = client.patch(f"/modules/{TEST_MAC_A}/display_name", json={"display_name": 42})
    assert r.status_code == 400


def test_patch_display_name_does_not_bump_updated_at(client, fresh_db):
    """Renaming is a metadata edit, not a liveness event. `updated_at`
    drives `Module.lastSeenAt` and the 2 h online window in
    `backend/src/database.ts::fetchAndAssemble`; bumping it on rename
    would flip any renamed offline module to "online" for two hours
    regardless of telemetry. Regression for PR-I senior review."""
    import time

    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))

    con = fresh_db.connection.get_conn()
    try:
        before = con.execute(
            "SELECT updated_at FROM module_configs WHERE id = ?", (TEST_MAC_A,)
        ).fetchone()[0]
    finally:
        con.close()

    # Force a measurable gap so any bump would surface as a non-equal
    # value, not a sub-second tie.
    time.sleep(0.01)

    r = client.patch(
        f"/modules/{TEST_MAC_A}/display_name", json={"display_name": "Renamed"}
    )
    assert r.status_code == 200

    con = fresh_db.connection.get_conn()
    try:
        after = con.execute(
            "SELECT updated_at FROM module_configs WHERE id = ?", (TEST_MAC_A,)
        ).fetchone()[0]
    finally:
        con.close()
    assert after == before, (
        f"updated_at must not move on rename; was {before!r}, is {after!r}"
    )


def test_patch_display_name_treats_empty_string_as_clear(client, fresh_db):
    """An empty/whitespace string clears the override. This matches the
    admin UI's "Save with empty input clears the override" UX."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    client.patch(f"/modules/{TEST_MAC_A}/display_name", json={"display_name": "First"})
    r = client.patch(
        f"/modules/{TEST_MAC_A}/display_name", json={"display_name": "   "}
    )
    assert r.status_code == 200
    assert r.get_json()["display_name"] is None

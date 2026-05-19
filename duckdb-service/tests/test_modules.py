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


def test_new_module_re_registration_does_not_clobber_recovered_location(
    client, fresh_db
):
    """PR II / issue #89 follow-up — pin the (0,0)-preservation guard.

    Scenario the senior-review caught: a module registers at (0,0)
    on day-1 boot (getGeolocation failed), the heartbeat-side
    deferred-retry recovers a real fix at, say, (47.79, 9.62), and
    day-2 boot's getGeolocation fails again — sending
    ``initNewModuleOnServer`` with (0,0) once more. The pre-fix
    UPSERT clobbered the recovered location back to (0,0), defeating
    the recovery on every daily reboot whose boot fix happened to
    fail. The new CASE-based UPSERT preserves the existing lat/lng
    when the incoming row is at (0,0) AND the stored row is not.
    """
    # Day-1: register at (0,0) — boot getGeolocation failed.
    r1 = client.post(
        "/new_module",
        json=_valid_payload(latitude=0.0, longitude=0.0),
    )
    assert r1.status_code == 200

    # Heartbeat-side recovery patches lat/lng to a real fix. Use the
    # heartbeat endpoint to mirror the actual recovery path rather
    # than a direct SQL write — keeps the test honest about the
    # cross-route contract.
    r_hb = client.post(
        "/heartbeat",
        data={
            "mac": TEST_MAC,
            "battery": 80,
            "latitude": "47.79",
            "longitude": "9.62",
            "accuracy": "50",
        },
    )
    assert r_hb.status_code == 200

    # Day-2: re-register at (0,0) — boot getGeolocation failed again.
    r2 = client.post(
        "/new_module",
        json=_valid_payload(latitude=0.0, longitude=0.0, module_name="TestHive"),
    )
    assert r2.status_code == 200

    # Critical assertion: the recovered location must survive.
    listed = client.get("/modules").get_json()["modules"]
    assert len(listed) == 1
    # duckdb-service returns raw `lat`/`lng`; the backend reshapes
    # to `location: {lat, lng}` for the homepage consumer.
    assert float(listed[0]["lat"]) == 47.79
    assert float(listed[0]["lng"]) == 9.62


def test_new_module_re_registration_with_real_fix_overwrites_existing(client, fresh_db):
    """Mirror image of the test above — when the firmware DOES have
    a plausible fix (boot getGeolocation succeeded), the UPSERT must
    still update lat/lng. The (0,0)-preservation guard is gated on
    ``EXCLUDED.lat = 0 AND EXCLUDED.lng = 0`` so any non-(0,0)
    incoming row overrides whatever was there before. This pins the
    "module physically moved by the operator" path — operator
    re-onboards from a new location, the new coords win.
    """
    r1 = client.post(
        "/new_module",
        json=_valid_payload(latitude=47.79, longitude=9.62),
    )
    assert r1.status_code == 200

    # Operator picks up the module and re-onboards from a different spot.
    r2 = client.post(
        "/new_module",
        json=_valid_payload(latitude=48.27, longitude=11.66),
    )
    assert r2.status_code == 200

    listed = client.get("/modules").get_json()["modules"]
    assert float(listed[0]["lat"]) == 48.27
    assert float(listed[0]["lng"]) == 11.66


def test_new_module_re_registration_after_null_island_with_real_fix_overwrites(
    client, fresh_db
):
    """Fourth quadrant of the (0,0)-preservation matrix (round-2
    senior-review P1): day-1 stored is (0,0), day-2 incoming is a
    plausible fix → UPSERT writes the new fix.

    The CASE's WHEN clause requires ``EXCLUDED.lat = 0 AND
    EXCLUDED.lng = 0``, which is false here, so the ELSE branch runs
    and EXCLUDED.lat/lng land in the row. Test pins it explicitly
    rather than leaving the path covered only implicitly by mutation
    of `test_register_module`.
    """
    # Day-1: registered at (0,0) — firmware boot getGeolocation failed.
    r1 = client.post(
        "/new_module",
        json=_valid_payload(latitude=0.0, longitude=0.0),
    )
    assert r1.status_code == 200

    # Day-2: boot succeeds, firmware sends a real fix.
    r2 = client.post(
        "/new_module",
        json=_valid_payload(latitude=47.79, longitude=9.62),
    )
    assert r2.status_code == 200

    # Row should reflect the new real fix.
    listed = client.get("/modules").get_json()["modules"]
    assert float(listed[0]["lat"]) == 47.79
    assert float(listed[0]["lng"]) == 9.62


def test_new_module_initial_registration_at_null_island_stores_zeros(client, fresh_db):
    """Edge case: very first registration is at (0,0). The CASE
    preserves "existing" only when there IS an existing non-(0,0)
    row; the INSERT side of the UPSERT just writes (0,0) as given.
    This is the right answer — the module shows up in the operator
    UI with the "Location pending" pill, and the heartbeat-side
    recovery can later patch it FROM (0,0).
    """
    r = client.post(
        "/new_module",
        json=_valid_payload(latitude=0.0, longitude=0.0),
    )
    assert r.status_code == 200

    listed = client.get("/modules").get_json()["modules"]
    assert float(listed[0]["lat"]) == 0.0
    assert float(listed[0]["lng"]) == 0.0


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


def test_patch_display_name_bumps_updated_at_not_last_seen_at(client, fresh_db):
    """Post-#97 split: renaming is a row-metadata edit (bumps
    `updated_at`) but NOT a liveness event (does NOT bump
    `last_seen_at`). The backend's `fetchAndAssemble` folds
    `last_seen_at` into `Module.lastSeenAt` for the 2 h status window,
    so bumping `last_seen_at` on rename would flip any renamed offline
    module to "online" for two hours regardless of telemetry. This is
    the inverted form of the pre-#97-split regression test (which
    pinned `updated_at` unchanged, because back then `updated_at` did
    double duty for both roles)."""
    import time

    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))

    con = fresh_db.connection.get_conn()
    try:
        before_updated, before_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (TEST_MAC_A,),
        ).fetchone()
    finally:
        con.close()

    # Force a measurable gap so any bump surfaces as a non-equal value,
    # not a sub-second tie.
    time.sleep(0.01)

    r = client.patch(
        f"/modules/{TEST_MAC_A}/display_name", json={"display_name": "Renamed"}
    )
    assert r.status_code == 200

    con = fresh_db.connection.get_conn()
    try:
        after_updated, after_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (TEST_MAC_A,),
        ).fetchone()
    finally:
        con.close()
    assert after_updated > before_updated, (
        f"updated_at must move on rename (row was touched); "
        f"was {before_updated!r}, is {after_updated!r}"
    )
    assert after_seen == before_seen, (
        f"last_seen_at must NOT move on rename (not a liveness event); "
        f"was {before_seen!r}, is {after_seen!r}"
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


def test_add_module_rejects_module_name_over_100_chars(client, fresh_db):
    """`ModuleData.module_name` is bounded at 100 chars by Pydantic
    `Field(max_length=100)` so a misbehaving firmware can't bypass the
    schema's intent. Round-2 PR-I senior-review nit: previously the
    cap only fired in the collision path of
    `_resolve_unique_firmware_name`, so the front-door entry was
    unbounded. Pin the rejection here."""
    over_long = "x" * 101
    r = client.post("/new_module", json=_payload(TEST_MAC_A, over_long))
    assert r.status_code == 400
    body = r.get_json()
    # Assert on the structured Pydantic v2 error code rather than the
    # human-readable `msg`, which has changed between minor versions.
    # `string_too_long` is the stable type emitted for `max_length`
    # violations on string fields; loc names which field tripped it.
    assert any(
        e.get("type") == "string_too_long" and "module_name" in e.get("loc", [])
        for e in body.get("error", [])
    ), body


def test_add_module_accepts_module_name_at_100_chars(client, fresh_db):
    """The boundary is inclusive — 100 chars is fine, 101 is not."""
    exactly_100 = "y" * 100
    r = client.post("/new_module", json=_payload(TEST_MAC_A, exactly_100))
    assert r.status_code == 200
    assert r.get_json()["name"] == exactly_100


def test_add_module_re_registration_bumps_both_timestamps(client, fresh_db):
    """Post-#97 split: `add_module` is the only writer that bumps
    `last_seen_at` (the device-liveness signal). It also bumps
    `updated_at` because the row was touched (the new "bump on every
    write" rule for row-metadata). Both timestamps must advance on a
    re-registration UPSERT.

    The companion `test_patch_display_name_bumps_updated_at_not_last_seen_at`
    pins the inverse for metadata-only writes."""
    import time

    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))

    con = fresh_db.connection.get_conn()
    try:
        before_updated, before_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (TEST_MAC_A,),
        ).fetchone()
    finally:
        con.close()

    time.sleep(0.01)

    # Re-register the same MAC (the ON CONFLICT path of `add_module`).
    r = client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    assert r.status_code == 200

    con = fresh_db.connection.get_conn()
    try:
        after_updated, after_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (TEST_MAC_A,),
        ).fetchone()
    finally:
        con.close()
    assert after_updated > before_updated, (
        f"updated_at must move on re-registration; "
        f"was {before_updated!r}, is {after_updated!r}"
    )
    assert after_seen > before_seen, (
        f"last_seen_at must move on re-registration (the only writer "
        f"that bumps it); was {before_seen!r}, is {after_seen!r}"
    )


def test_set_display_name_works_on_module_with_nest_data(client, fresh_db):
    """Issue #105 regression. Pre-fix, DuckDB 1.4.4 rejected
    `UPDATE module_configs SET display_name = ?` on any row whose `id`
    was referenced by `nest_data.module_id`, even though the UPDATE
    didn't touch the FK column. The compose stack seeds five modules
    all with `nest_data` rows, so all five were unrenamable out of
    the box.

    Test: seed a module via the normal `/new_module` path, INSERT a
    `nest_data` row pointing at it, then PATCH `display_name`. Must
    return 200 + the new label."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))

    con = fresh_db.connection.get_conn()
    try:
        # Insert a nest_data row pointing at this module — this is what
        # would have tripped the FK over-enforcement pre-fix.
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            ("nest-test-a", TEST_MAC_A, "blackmasked"),
        )
        con.commit()
    finally:
        con.close()

    r = client.patch(
        f"/modules/{TEST_MAC_A}/display_name",
        json={"display_name": "RenamedWithNest"},
    )
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["display_name"] == "RenamedWithNest"

    # Confirm the rename actually persisted (FK workaround must not
    # silently no-op the UPDATE).
    rows = client.get("/modules").get_json()["modules"]
    row = next(m for m in rows if m["id"] == TEST_MAC_A)
    assert row["display_name"] == "RenamedWithNest"

    # Confirm the FK invariant still holds — nest_data.module_id still
    # points at a real module_configs row.
    con = fresh_db.connection.get_conn()
    try:
        orphans = con.execute(
            "SELECT COUNT(*) FROM nest_data n "
            "LEFT JOIN module_configs m ON m.id = n.module_id "
            "WHERE m.id IS NULL"
        ).fetchone()[0]
    finally:
        con.close()
    assert orphans == 0, "the FK invariant must hold after the workaround"


def test_set_display_name_preserves_full_fk_chain_nest_and_progress(client, fresh_db):
    """Issue #105 — the temp-table dance must restore BOTH FK arms:
    `nest_data` AND `daily_progress`. The dance deletes in reverse-FK
    order (daily_progress first, nest_data second) and re-inserts in
    forward-FK order. This test seeds both arms and asserts they
    survive the rename intact.

    Without this test, a refactor that only restored nest_data would
    pass `test_set_display_name_works_on_module_with_nest_data` but
    silently drop the operator's image-classification history."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))

    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            ("nest-fc-1", TEST_MAC_A, "blackmasked"),
        )
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            ("nest-fc-2", TEST_MAC_A, "resin"),
        )
        con.execute(
            "INSERT INTO daily_progress "
            "(progress_id, nest_id, date, empty, sealed, hatched) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("prog-fc-1", "nest-fc-1", "2026-05-01", 3, 12, 4),
        )
        con.execute(
            "INSERT INTO daily_progress "
            "(progress_id, nest_id, date, empty, sealed, hatched) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("prog-fc-2", "nest-fc-2", "2026-05-02", 5, 7, 2),
        )
        con.commit()
    finally:
        con.close()

    r = client.patch(
        f"/modules/{TEST_MAC_A}/display_name",
        json={"display_name": "DanceFull"},
    )
    assert r.status_code == 200, r.get_json()

    # Both FK arms must survive intact — IDs, FK references, and the
    # payload columns (empty/sealed/hatched) all preserved verbatim.
    con = fresh_db.connection.get_conn()
    try:
        nests = sorted(
            con.execute(
                "SELECT nest_id, module_id, beeType FROM nest_data "
                "WHERE module_id = ? ORDER BY nest_id",
                (TEST_MAC_A,),
            ).fetchall()
        )
        progress = sorted(
            con.execute(
                "SELECT progress_id, nest_id, date, empty, sealed, hatched "
                "FROM daily_progress WHERE nest_id IN "
                "(SELECT nest_id FROM nest_data WHERE module_id = ?) "
                "ORDER BY progress_id",
                (TEST_MAC_A,),
            ).fetchall()
        )
    finally:
        con.close()

    assert len(nests) == 2
    assert nests[0][0] == "nest-fc-1" and nests[0][2] == "blackmasked"
    assert nests[1][0] == "nest-fc-2" and nests[1][2] == "resin"
    assert len(progress) == 2
    # Payload columns survive verbatim through the snapshot+restore.
    assert progress[0][3:] == (3, 12, 4), progress
    assert progress[1][3:] == (5, 7, 2), progress


def test_set_display_name_restores_children_on_mid_dance_failure(client, fresh_db):
    """Issue #105 / senior-review round 1 — pin the compensating-restore
    contract. If the dance fails partway through (e.g. the re-insert
    phase raises), the route MUST restore the children from the
    snapshot before the 500 surfaces.

    Without compensating restore, a partial failure would leave the
    operator with a module that's lost its nests/progress permanently —
    the worst kind of silent data loss because the operator just sees
    'Save failed' and retries with no idea anything else broke.

    We force a mid-dance failure by wrapping the route's connection
    in a thin proxy that raises on the first ``INSERT INTO nest_data``
    call — the dance's first re-insert in phase 3. The proxy
    delegates everything else via ``__getattr__`` because
    ``DuckDBPyConnection`` attributes are read-only and can't be
    monkey-patched directly."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    client.post("/new_module", json=_payload(TEST_MAC_B, "BeeTwo"))

    con = fresh_db.connection.get_conn()
    try:
        # Seed module A with one nest + one progress row.
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            ("nest-rescue-1", TEST_MAC_A, "blackmasked"),
        )
        con.execute(
            "INSERT INTO daily_progress "
            "(progress_id, nest_id, date, empty, sealed, hatched) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("prog-rescue-1", "nest-rescue-1", "2026-05-01", 3, 12, 4),
        )
        con.commit()
    finally:
        con.close()

    # Take an in-route fault-injection approach: wrap the duckdb
    # connection in a thin proxy that fails on the FIRST
    # "INSERT INTO nest_data" call (the dance's first re-insert in
    # phase 3). Direct attribute-patching of a DuckDBPyConnection
    # doesn't work because its attributes are read-only, so we use
    # a wrapper class that delegates everything except `execute`.
    import routes.modules as routes_modules

    real_get_conn = routes_modules.get_conn
    call_counter = {"nest_inserts": 0}

    class _FaultInjectingConn:
        def __init__(self, real_con):
            self._con = real_con

        def execute(self, sql, params=None):
            if "INSERT INTO nest_data" in sql:
                call_counter["nest_inserts"] += 1
                if call_counter["nest_inserts"] == 1:
                    raise RuntimeError("injected fault: re-insert failure")
            if params is None:
                return self._con.execute(sql)
            return self._con.execute(sql, params)

        def __getattr__(self, name):
            return getattr(self._con, name)

    def patched_get_conn():
        return _FaultInjectingConn(real_get_conn())

    import unittest.mock as _mock

    with _mock.patch.object(routes_modules, "get_conn", patched_get_conn):
        r = client.patch(
            f"/modules/{TEST_MAC_A}/display_name",
            json={"display_name": "ShouldFail"},
        )

    assert r.status_code == 500, r.get_json()

    # Now the critical assertion: the children must be restored, even
    # though the dance failed mid-re-insert.
    con = fresh_db.connection.get_conn()
    try:
        nest_count = con.execute(
            "SELECT COUNT(*) FROM nest_data WHERE module_id = ?",
            (TEST_MAC_A,),
        ).fetchone()[0]
        progress_count = con.execute(
            "SELECT COUNT(*) FROM daily_progress WHERE nest_id IN "
            "(SELECT nest_id FROM nest_data WHERE module_id = ?)",
            (TEST_MAC_A,),
        ).fetchone()[0]
        orphans = con.execute(
            "SELECT COUNT(*) FROM nest_data n "
            "LEFT JOIN module_configs m ON m.id = n.module_id "
            "WHERE m.id IS NULL"
        ).fetchone()[0]
    finally:
        con.close()

    assert nest_count == 1, (
        f"compensating restore must put the snapshotted nest back; found {nest_count}"
    )
    assert progress_count == 1, (
        f"compensating restore must put the snapshotted progress back; "
        f"found {progress_count}"
    )
    assert orphans == 0, "FK invariant must hold after the rescue"


def test_set_display_name_409_collision_still_works_with_nest_data(client, fresh_db):
    """The FK workaround for #105 must not regress the existing UNIQUE
    collision contract. Seed two modules — both with nest_data rows —
    rename module 1 to a label, try to rename module 2 to the same
    label; must 409 (not 500), and the body must carry the
    conflicting MAC."""
    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))
    client.post("/new_module", json=_payload(TEST_MAC_B, "BeeTwo"))

    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            ("nest-test-a", TEST_MAC_A, "blackmasked"),
        )
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            ("nest-test-b", TEST_MAC_B, "blackmasked"),
        )
        con.commit()
    finally:
        con.close()

    r1 = client.patch(
        f"/modules/{TEST_MAC_A}/display_name",
        json={"display_name": "Shared Label"},
    )
    assert r1.status_code == 200

    r2 = client.patch(
        f"/modules/{TEST_MAC_B}/display_name",
        json={"display_name": "Shared Label"},
    )
    assert r2.status_code == 409, r2.get_json()
    body = r2.get_json()
    assert body["display_name"] == "Shared Label"
    assert body["conflicting_module_id"] == TEST_MAC_A


def test_set_display_name_handles_missing_module_with_clean_rollback(client, fresh_db):
    """Pinning the fix for #105's Bug 2 (the stacked rollback). The
    route's old shape called `con.rollback()` in its exception handler
    even though DuckDB was in autocommit mode; that raised a secondary
    `TransactionException` which masked the real error and surfaced
    Flask's HTML 500 page to the operator. The fix switches the route
    to the project's `write_transaction()` helper, which handles the
    "no active transaction" rollback gracefully.

    Test: PATCH a non-existent module — the early-return 404 path must
    NOT crash on rollback. We assert (a) status 404, (b) body is JSON
    (not HTML), (c) body carries the expected error key."""
    r = client.patch(
        "/modules/ffffffffffff/display_name",
        json={"display_name": "Doesn't matter"},
    )
    assert r.status_code == 404
    # JSON, not HTML — if write_transaction's rollback path is broken,
    # Flask falls back to its default HTML 500.
    assert r.content_type.startswith("application/json"), r.data[:200]
    assert r.get_json()["error"] == "Module not found"


def test_legacy_heartbeat_bumps_updated_at_not_last_seen_at(client, fresh_db):
    """The legacy `/modules/<id>/heartbeat` route updates battery +
    image_count metadata; it does NOT represent a registration event.
    Post-#97 split, this route bumps `updated_at` (row was touched)
    but not `last_seen_at` (the new heartbeat path
    `heartbeats.py::post_heartbeat` writes to `module_heartbeats` and
    the backend folds that into the derived liveness separately).
    Pinning the contract so a future refactor that accidentally
    promotes legacy heartbeat to a liveness signal trips this test."""
    import time

    client.post("/new_module", json=_payload(TEST_MAC_A, "BeeOne"))

    con = fresh_db.connection.get_conn()
    try:
        before_updated, before_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (TEST_MAC_A,),
        ).fetchone()
    finally:
        con.close()

    time.sleep(0.01)

    r = client.post(f"/modules/{TEST_MAC_A}/heartbeat", json={"battery": 73})
    assert r.status_code == 200, r.get_json()

    con = fresh_db.connection.get_conn()
    try:
        after_updated, after_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (TEST_MAC_A,),
        ).fetchone()
    finally:
        con.close()
    assert after_updated > before_updated, (
        f"updated_at must move on legacy heartbeat; "
        f"was {before_updated!r}, is {after_updated!r}"
    )
    assert after_seen == before_seen, (
        f"last_seen_at must NOT move on legacy heartbeat (not a "
        f"registration event); was {before_seen!r}, is {after_seen!r}"
    )

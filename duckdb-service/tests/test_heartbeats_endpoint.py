"""Tests for the ESP-facing ``POST /heartbeat`` route.

This is the route the firmware hits hourly. It writes into the
``module_heartbeats`` table; ``module_id`` is the canonical 12-hex form
produced by ``ModuleId``. These tests pin the canonicalisation seam so a
non-firmware client (manual curl, future second client) sending colon-
or dash-form MACs cannot silently create a parallel row keyed on a
different string.

Companion to ``test_module_endpoints.py`` — that file covers
``/modules/<id>/heartbeat`` (a sibling route that writes into
``module_configs``); this file covers the bare ``/heartbeat`` POST.
"""

CANONICAL_MAC = "aabbccddeeff"


def _fetch_heartbeat_module_ids(fresh_db):
    con = fresh_db.connection.get_conn()
    try:
        cur = con.execute("SELECT module_id FROM module_heartbeats")
        return [row[0] for row in cur.fetchall()]
    finally:
        con.close()


# ---------- validation ----------


def test_heartbeat_missing_mac_returns_400(client):
    resp = client.post("/heartbeat", data={"battery": 50})
    assert resp.status_code == 400
    assert resp.get_json() == {"error": "missing mac"}


def test_heartbeat_blank_mac_returns_400(client):
    resp = client.post("/heartbeat", data={"mac": "   ", "battery": 50})
    assert resp.status_code == 400
    assert resp.get_json() == {"error": "missing mac"}


def test_heartbeat_malformed_mac_returns_400(client, fresh_db):
    resp = client.post("/heartbeat", data={"mac": "not-a-mac", "battery": 50})
    assert resp.status_code == 400
    assert resp.get_json() == {"error": "invalid mac format"}
    assert _fetch_heartbeat_module_ids(fresh_db) == []


def test_heartbeat_short_hex_returns_400(client, fresh_db):
    resp = client.post("/heartbeat", data={"mac": "aabbcc", "battery": 50})
    assert resp.status_code == 400
    assert resp.get_json() == {"error": "invalid mac format"}
    assert _fetch_heartbeat_module_ids(fresh_db) == []


# ---------- canonicalisation ----------


def test_heartbeat_canonical_mac_writes_canonical_pk(client, fresh_db):
    resp = client.post(
        "/heartbeat",
        data={"mac": CANONICAL_MAC, "battery": 80, "fw_version": "carpenter"},
    )
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}
    assert _fetch_heartbeat_module_ids(fresh_db) == [CANONICAL_MAC]


def test_heartbeat_uppercase_mac_canonicalised(client, fresh_db):
    resp = client.post("/heartbeat", data={"mac": "AABBCCDDEEFF", "battery": 80})
    assert resp.status_code == 200
    assert _fetch_heartbeat_module_ids(fresh_db) == [CANONICAL_MAC]


def test_heartbeat_colon_form_canonicalised(client, fresh_db):
    resp = client.post("/heartbeat", data={"mac": "AA:BB:CC:DD:EE:FF", "battery": 80})
    assert resp.status_code == 200
    assert _fetch_heartbeat_module_ids(fresh_db) == [CANONICAL_MAC]


def test_heartbeat_dash_form_canonicalised(client, fresh_db):
    resp = client.post("/heartbeat", data={"mac": "aa-bb-cc-dd-ee-ff", "battery": 80})
    assert resp.status_code == 200
    assert _fetch_heartbeat_module_ids(fresh_db) == [CANONICAL_MAC]


def test_heartbeat_mixed_forms_collapse_to_one_pk(client, fresh_db):
    """Three clients posting the same MAC in different shapes must all
    land on the same canonical ``module_id`` value. The table itself is
    append-only with a serial PK so the row count grows regardless;
    what canonicalisation pins is the ``module_id`` *column*, which is
    what every join, dashboard query, and silence-watcher GROUP BY uses
    to decide "is this the same module?". Before the fix, three forms
    would have written three different ``module_id`` strings and the
    dashboard would have shown three "modules"."""
    forms = [CANONICAL_MAC, "AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff"]
    for form in forms:
        resp = client.post("/heartbeat", data={"mac": form, "battery": 50})
        assert resp.status_code == 200

    ids = _fetch_heartbeat_module_ids(fresh_db)
    assert len(ids) == len(forms)
    assert set(ids) == {CANONICAL_MAC}


# ---------- esp_id alias ----------


def test_heartbeat_esp_id_field_is_canonicalised(client, fresh_db):
    """The route accepts ``esp_id`` as a synonym for ``mac``. Both paths
    must go through the same validator."""
    resp = client.post(
        "/heartbeat", data={"esp_id": "AA:BB:CC:DD:EE:FF", "battery": 50}
    )
    assert resp.status_code == 200
    assert _fetch_heartbeat_module_ids(fresh_db) == [CANONICAL_MAC]


def test_heartbeat_esp_id_malformed_returns_400(client, fresh_db):
    resp = client.post("/heartbeat", data={"esp_id": "garbage", "battery": 50})
    assert resp.status_code == 400
    assert resp.get_json() == {"error": "invalid mac format"}
    assert _fetch_heartbeat_module_ids(fresh_db) == []


# ---------- geolocation recovery (PR II / issue #89) ----------
#
# The firmware ships a plausible lat/lng/accuracy on the heartbeat
# AFTER the deferred-retry path obtains a fix mid-uptime. The server
# UPDATEs module_configs.lat/lng iff the existing row sits at the
# (0,0) sentinel — the conservative "only patch from (0,0)" rule.
# These tests pin the rule end-to-end so a future refactor can't
# silently lift the guard to "always patch" (which would clobber
# deliberately-placed modules).


def _seed_module_at(fresh_db, module_id, lat, lng):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online) "
            "VALUES (?, 'Test', ?, ?, '2026-05-01')",
            (module_id, lat, lng),
        )
        con.commit()
    finally:
        con.close()


def _fetch_module_lat_lng(fresh_db, module_id):
    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT lat, lng FROM module_configs WHERE id = ?",
            (module_id,),
        ).fetchone()
        return (float(row[0]), float(row[1])) if row else None
    finally:
        con.close()


def test_heartbeat_with_lat_lng_patches_null_island_module(client, fresh_db):
    _seed_module_at(fresh_db, CANONICAL_MAC, 0.0, 0.0)
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "battery": 50,
            "latitude": "47.79",
            "longitude": "9.62",
            "accuracy": "50",
        },
    )
    assert resp.status_code == 200
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (47.79, 9.62)


def test_heartbeat_with_lat_lng_does_not_overwrite_placed_module(client, fresh_db):
    # Deliberately-placed module — operator picked a real location.
    # The heartbeat-side recovery MUST NOT touch this row even if
    # the firmware fires a plausible fix at us.
    _seed_module_at(fresh_db, CANONICAL_MAC, 48.27, 11.66)
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "battery": 50,
            "latitude": "47.79",
            "longitude": "9.62",
            "accuracy": "50",
        },
    )
    assert resp.status_code == 200
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (48.27, 11.66)


def test_heartbeat_without_lat_lng_leaves_module_untouched(client, fresh_db):
    _seed_module_at(fresh_db, CANONICAL_MAC, 0.0, 0.0)
    resp = client.post(
        "/heartbeat",
        data={"mac": CANONICAL_MAC, "battery": 50},
    )
    assert resp.status_code == 200
    # Row remains at the (0,0) sentinel — no opportunistic write.
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (0.0, 0.0)


def test_heartbeat_with_implausible_zero_accuracy_dropped(client, fresh_db):
    # Google's "no fix" signal is acc=0. Firmware filters it, but
    # defence-in-depth on the server: the row stays at (0,0).
    _seed_module_at(fresh_db, CANONICAL_MAC, 0.0, 0.0)
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "battery": 50,
            "latitude": "47.79",
            "longitude": "9.62",
            "accuracy": "0",
        },
    )
    assert resp.status_code == 200
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (0.0, 0.0)


def test_heartbeat_with_out_of_range_lat_dropped(client, fresh_db):
    # A parser glitch on the wire — lat=200 is geometrically impossible.
    _seed_module_at(fresh_db, CANONICAL_MAC, 0.0, 0.0)
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "battery": 50,
            "latitude": "200",
            "longitude": "9.62",
            "accuracy": "50",
        },
    )
    # The endpoint MUST NOT 500 — firmware fails-quiet on non-2xx and
    # a 500 would mean recovery waits for the next daily reboot
    # instead of the next deferred-retry heartbeat.
    assert resp.status_code == 200
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (0.0, 0.0)


def test_heartbeat_with_null_island_lat_lng_dropped(client, fresh_db):
    # Firmware can never send (0,0) post-hf::isPlausibleFix, but a
    # stray manual curl could. Server re-checks; the (0,0) sentinel
    # is rejected even though the existing row IS at (0,0).
    _seed_module_at(fresh_db, CANONICAL_MAC, 0.0, 0.0)
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "battery": 50,
            "latitude": "0",
            "longitude": "0",
            "accuracy": "50",
        },
    )
    assert resp.status_code == 200
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (0.0, 0.0)


def test_heartbeat_with_lat_lng_for_unregistered_module_does_not_crash(
    client, fresh_db
):
    # Heartbeats for unregistered modules are accepted (the row in
    # module_heartbeats is keyed by module_id, not FK-constrained to
    # module_configs). The recovery path must SELECT-then-no-op
    # rather than UPDATE-and-fail when no config row exists yet.
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "battery": 50,
            "latitude": "47.79",
            "longitude": "9.62",
            "accuracy": "50",
        },
    )
    assert resp.status_code == 200
    # No row to fetch — assertion is just "we didn't 500".

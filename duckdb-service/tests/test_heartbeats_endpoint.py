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

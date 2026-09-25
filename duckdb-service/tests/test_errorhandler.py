"""Tests for the app-level JSON error handler + #246 edge-case fixes.

Covers:
* ``@app.errorhandler(Exception)`` in ``app.py`` — generic JSON 500,
  detail in the ring, HTTPException pass-through.
* ``_to_int`` non-finite/clamp behaviour on the public ``/heartbeat``.
* ``add_progress_for_module`` empty-dict 400 + unknown-module 404.
* ``add_module`` unexpected fault is a 500 (not a 400).
* Heartbeat reads use ``query_all`` + canonicalise module ids.
* ``check_silence`` smoke test (full suite is #240's).
"""

# Canonical 12-hex-char ModuleId test fixtures.
TEST_MAC_1 = "aabbccddeeff"

VALID_KEY = "hf_dev_key_2026"  # dev fallback resolved when HIGHFIVE_API_KEY unset


def _seed_module(fresh_db, module_id=TEST_MAC_1, last_seen_at=None):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online, last_seen_at) "
            "VALUES (?, 'Seed', 47.8, 9.6, '2024-01-01', ?)",
            (module_id, last_seen_at),
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


# ---------- app-level handler ----------


def test_unexpected_exception_returns_generic_json_500(client, monkeypatch):
    """An unhandled route fault is JSON `{"error": "internal error"}`
    with status 500 — never HTML, never `str(e)` to the client."""
    import routes.modules as routes_modules

    def boom(*_args, **_kwargs):
        raise RuntimeError("synthetic duckdb failure")

    monkeypatch.setattr(routes_modules, "query_all", boom)

    resp = client.get("/modules")
    assert resp.status_code == 500
    assert resp.is_json
    assert resp.get_json() == {"error": "internal error"}


def test_handler_logs_path_and_type_to_ring(client, monkeypatch):
    """The detail the client doesn't get lands in the ring: exactly one
    handler `error` entry naming the path and exception type (the
    access-log line is a separate, expected entry)."""
    import routes.modules as routes_modules
    from services import log_ring

    log_ring._reset_for_test()

    def boom(*_args, **_kwargs):
        raise RuntimeError("synthetic duckdb failure")

    monkeypatch.setattr(routes_modules, "query_all", boom)
    assert client.get("/modules").status_code == 500

    resp = client.get("/logs?lines=50", headers={"X-Admin-Key": VALID_KEY})
    assert resp.status_code == 200
    errors = [e["msg"] for e in resp.get_json()["entries"] if e["level"] == "error"]
    handler_lines = [m for m in errors if "RuntimeError" in m]
    assert len(handler_lines) == 1
    assert "GET /modules" in handler_lines[0]


def test_http_exception_passes_through_unchanged(client):
    """Routing errors are Flask's own answer, not a fault — an unknown
    path still 404s instead of becoming a handler 500."""
    resp = client.get("/does-not-exist")
    assert resp.status_code == 404


# ---------- _to_int ----------


def test_to_int_rejects_non_finite():
    from routes.heartbeats import _to_int

    assert _to_int("1e400") is None
    assert _to_int("-1e400") is None
    assert _to_int("nan") is None
    assert _to_int("-inf") is None
    assert _to_int("inf", default=7) == 7


def test_to_int_clamps_to_int32():
    from routes.heartbeats import _to_int

    assert _to_int("1e30") == 2**31 - 1
    assert _to_int("-1e30") == -(2**31)
    assert _to_int("42") == 42
    assert _to_int("") is None
    assert _to_int(None) is None
    assert _to_int("abc", default=3) == 3


def test_heartbeat_non_finite_fields_never_500(client, fresh_db):
    """`rssi=1e400` / `nan` / `-inf` degrade to NULL with a 200 — a
    non-2xx here would count toward the firmware's `hb_failure`
    streak (#172) for a single malformed field."""
    _seed_module(fresh_db)
    for field, value in (
        ("rssi", "1e400"),
        ("rssi", "nan"),
        ("battery", "-inf"),
    ):
        resp = client.post("/heartbeat", data={"mac": TEST_MAC_1, field: value})
        assert resp.status_code == 200, f"{field}={value}"
        assert resp.get_json() == {"ok": True}

    rows = _query(
        fresh_db,
        "SELECT battery, rssi FROM module_heartbeats WHERE module_id = ?",
        (TEST_MAC_1,),
    )
    assert len(rows) == 3
    assert all(r["rssi"] is None for r in rows)
    assert all(r["battery"] is None for r in rows)


# ---------- add_progress edges ----------


def _progress_payload(module_id, classification):
    return {"module_id": module_id, "classification": classification}


def test_add_progress_unknown_module_returns_404(client):
    resp = client.post(
        "/add_progress_for_module",
        json=_progress_payload("ffffffffffff", {"black_masked_bee": {"0": 0.5}}),
    )
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "unknown module"}


def test_add_progress_empty_per_type_dict_returns_400(client, fresh_db):
    """A known bee type with zero nests 400s instead of IndexErroring
    on `sealed_list[-1]`. (Unknown types still skip — forward-compat
    with future firmware types — so the probe uses a known type.)"""
    _seed_module(fresh_db)
    resp = client.post(
        "/add_progress_for_module",
        json=_progress_payload(TEST_MAC_1, {"black_masked_bee": {}}),
    )
    assert resp.status_code == 400
    assert resp.get_json() == {
        "error": "classification.black_masked_bee must contain at least one nest"
    }
    # Nothing was written for the rejected type.
    assert _query(fresh_db, "SELECT COUNT(*) AS n FROM nest_data")[0]["n"] == 0


# ---------- add_module unexpected fault ----------


def test_add_module_unexpected_exception_is_500_not_400(client, monkeypatch):
    """A genuine server fault during registration is a 500, not a 400 —
    callers must not read it as 'your request was bad' and stop
    retrying."""
    import routes.modules as routes_modules

    def boom():
        raise RuntimeError("synthetic write failure")

    monkeypatch.setattr(routes_modules, "write_transaction", boom)

    resp = client.post(
        "/new_module",
        json={
            "esp_id": TEST_MAC_1,
            "module_name": "Seed",
            "latitude": 47.8086,
            "longitude": 9.6433,
            "battery_level": 80,
        },
    )
    assert resp.status_code == 500
    assert resp.is_json
    assert resp.get_json() == {"error": "internal error"}


# ---------- heartbeat reads: query_all + canonicalisation ----------


def test_get_heartbeats_malformed_id_returns_400(client):
    assert client.get("/heartbeats/not-a-mac").status_code == 400


def test_get_heartbeats_non_canonical_id_accepted(client, fresh_db):
    _seed_module(fresh_db)
    resp = client.get(f"/heartbeats/{TEST_MAC_1.upper()}")
    assert resp.status_code == 200
    assert resp.get_json() == {"heartbeats": []}


def test_get_heartbeat_gaps_echoes_canonical_id(client, fresh_db):
    _seed_module(fresh_db)
    resp = client.get(f"/heartbeats/{TEST_MAC_1.upper()}/gaps")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["module_id"] == TEST_MAC_1
    assert body["gaps"] == []


def test_get_heartbeats_summary_reads_back_rows(client, fresh_db):
    _seed_module(fresh_db)
    client.post("/heartbeat", data={"mac": TEST_MAC_1, "battery": "42"})
    body = client.get("/heartbeats_summary").get_json()
    assert body["summary"][TEST_MAC_1]["battery"] == 42


# ---------- silence_watcher smoke (full suite is #240) ----------


def test_check_silence_flags_quiet_module_and_clears_recovered(
    fresh_db,
):
    """The `query_all` + `write_transaction` restructure preserves the
    alert/recovery semantics end to end."""
    watcher = fresh_db.silence_watcher
    _seed_module(fresh_db, TEST_MAC_1, last_seen_at="2020-01-01 00:00:00")

    watcher.check_silence()

    assert len(fresh_db.discord_calls) == 1
    assert "is down" in fresh_db.discord_calls[0]
    flagged = _query(
        fresh_db,
        "SELECT last_silence_alert_at FROM module_configs WHERE id = ?",
        (TEST_MAC_1,),
    )
    assert flagged[0]["last_silence_alert_at"] is not None

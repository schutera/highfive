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


def test_heartbeat_geo_patch_bumps_updated_at_not_last_seen_at(client, fresh_db):
    """Post-#97 split: the (0,0) → real-fix recovery is a row-metadata
    write (the row was touched). It MUST bump `updated_at` but MUST
    NOT bump `last_seen_at` — the heartbeat itself is already
    recorded in the `module_heartbeats` table (which the backend
    folds into the derived `lastSeenAt` separately), so bumping
    `last_seen_at` here would double-count the same liveness event.

    The test seeds a module at (0,0) using `add_module` (the normal
    registration path), waits, fires a plausible-fix heartbeat, and
    asserts the timestamp deltas."""
    import time

    # Seed via the normal registration path so both timestamps start
    # at a known value.
    resp = client.post(
        "/new_module",
        json={
            "esp_id": CANONICAL_MAC,
            "module_name": "TestHive",
            "latitude": 0.0,
            "longitude": 0.0,
            "battery_level": 80,
        },
    )
    assert resp.status_code == 200, resp.get_json()

    con = fresh_db.connection.get_conn()
    try:
        before_updated, before_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (CANONICAL_MAC,),
        ).fetchone()
    finally:
        con.close()

    time.sleep(0.01)

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

    con = fresh_db.connection.get_conn()
    try:
        after_updated, after_seen = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            (CANONICAL_MAC,),
        ).fetchone()
    finally:
        con.close()

    # Sanity: the geo-patch fired, so lat/lng changed from (0,0).
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (47.79, 9.62)
    assert after_updated > before_updated, (
        f"updated_at must move on geo-patch (row was touched); "
        f"was {before_updated!r}, is {after_updated!r}"
    )
    assert after_seen == before_seen, (
        f"last_seen_at must NOT move on geo-patch (the liveness was "
        f"already recorded in module_heartbeats); "
        f"was {before_seen!r}, is {after_seen!r}"
    )


def test_heartbeat_geo_patch_coarsens_precise_fix(client, fresh_db):
    """The heartbeat-side (0,0) → real-fix recovery generalizes coordinates
    to ~1 km before persisting (issue #145, ADR-020). This write path does
    not go through the `ModuleData` model, so it must coarsen explicitly —
    the server is the enforcement boundary and cannot trust the firmware to
    have already rounded (old firmware, spoofed heartbeat).
    """
    # Seed at (0,0) so the geo-patch guard fires.
    resp = client.post(
        "/new_module",
        json={
            "esp_id": CANONICAL_MAC,
            "module_name": "TestHive",
            "latitude": 0.0,
            "longitude": 0.0,
            "battery_level": 80,
        },
    )
    assert resp.status_code == 200, resp.get_json()

    # A precise fix arrives via heartbeat (e.g. firmware that hasn't OTA'd yet).
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "battery": 50,
            "latitude": "47.794321",
            "longitude": "9.621987",
            "accuracy": "50",
        },
    )
    assert resp.status_code == 200

    # Stored at 2 dp, not the precise heartbeat value.
    assert _fetch_module_lat_lng(fresh_db, CANONICAL_MAC) == (47.79, 9.62)


# ---------- diagnostic fields: reset_reason / min_free_heap / boot_count (#148) ----------
#
# A crash-looping or hung module never reaches the daily noon image upload
# that carries the telemetry sidecar, so these fields are lifted onto the
# hourly heartbeat — the very next heartbeat after a reset reports *why*.
# These tests assert the values actually round-trip into the persisted row
# and back out of both read endpoints (not merely that the response envelope
# has the keys — see CLAUDE.md rule 5, "envelope right, behaviour wrong").


def test_heartbeat_persists_diagnostic_fields(client, fresh_db):
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "rssi": -72,
            "uptime_ms": 16462,
            "free_heap": 167888,
            "fw_version": "carpenter",
            "reset_reason": "TASK_WDT",
            "min_free_heap": 69916,
            "boot_count": 3169,
        },
    )
    assert resp.status_code == 200, resp.get_json()

    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT reset_reason, min_free_heap, boot_count "
            "FROM module_heartbeats WHERE module_id = ?",
            (CANONICAL_MAC,),
        ).fetchone()
    finally:
        con.close()
    assert row == ("TASK_WDT", 69916, 3169)


def test_heartbeats_get_returns_diagnostic_fields(client, fresh_db):
    client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "reset_reason": "BROWNOUT",
            "min_free_heap": 42000,
            "boot_count": 7,
        },
    )
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}")
    assert resp.status_code == 200
    hb = resp.get_json()["heartbeats"][0]
    assert hb["reset_reason"] == "BROWNOUT"
    assert hb["min_free_heap"] == 42000
    assert hb["boot_count"] == 7


def test_heartbeats_summary_returns_latest_diagnostic_fields(client, fresh_db):
    # Two heartbeats: the summary must reflect the MOST RECENT one's
    # diagnostic values (ARG_MAX over received_at), not the first.
    client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "reset_reason": "POWERON",
            "min_free_heap": 100000,
            "boot_count": 1,
        },
    )
    client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "reset_reason": "PANIC",
            "min_free_heap": 51234,
            "boot_count": 2,
        },
    )
    resp = client.get("/heartbeats_summary")
    assert resp.status_code == 200
    entry = resp.get_json()["summary"][CANONICAL_MAC]
    assert entry["reset_reason"] == "PANIC"
    assert entry["min_free_heap"] == 51234
    assert entry["boot_count"] == 2


def test_heartbeat_omitting_diagnostic_fields_stores_null(client, fresh_db):
    # Older firmware (pre-#148) omits all three. A mixed fleet during an OTA
    # rollout must not 500 and must store NULL, not 0 (0 boots / 0 KB heap
    # would be an honest-looking lie).
    resp = client.post(
        "/heartbeat",
        data={"mac": CANONICAL_MAC, "rssi": -80, "fw_version": "mason"},
    )
    assert resp.status_code == 200
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}")
    hb = resp.get_json()["heartbeats"][0]
    assert hb["reset_reason"] is None
    assert hb["min_free_heap"] is None
    assert hb["boot_count"] is None


# ---------- steady-state heartbeat-failure streak: last_hb_fail_* (#172) ----------
#
# The hourly heartbeats fail *between* boots and never reach the server (no
# 2xx), so reset_reason/boot_count above only describe the boot call. The
# firmware accumulates a failure streak across a session and attaches it to
# the next 2xx heartbeat — typically the boot heartbeat after a
# `livenessReboot`. These tests assert the streak actually round-trips into
# the persisted row and back out of BOTH read endpoints (not merely that the
# envelope has the keys — CLAUDE.md rule 5, "envelope right, behaviour wrong").


def test_heartbeat_persists_failure_streak_fields(client, fresh_db):
    # The #170 reboot-loop shape: the boot heartbeat round-trips 200 while
    # carrying the count of hourly heartbeats that failed in the prior 2 h
    # window (here 2, last code -2 = connect/WiFi-down sentinel).
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "uptime_ms": 16000,
            "reset_reason": "SW",
            "boot_count": 9,
            "last_hb_fail_code": -2,
            "last_hb_fail_count": 2,
        },
    )
    assert resp.status_code == 200, resp.get_json()

    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT last_hb_fail_code, last_hb_fail_count "
            "FROM module_heartbeats WHERE module_id = ?",
            (CANONICAL_MAC,),
        ).fetchone()
    finally:
        con.close()
    assert row == (-2, 2)


def test_heartbeats_get_returns_failure_streak_fields(client, fresh_db):
    client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "last_hb_fail_code": 500,
            "last_hb_fail_count": 4,
        },
    )
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}")
    assert resp.status_code == 200
    hb = resp.get_json()["heartbeats"][0]
    assert hb["last_hb_fail_code"] == 500
    assert hb["last_hb_fail_count"] == 4


def test_heartbeats_summary_clears_streak_after_recovery_not_latching(client, fresh_db):
    # REGRESSION (the reason the firmware sends the streak fields DENSELY, with
    # a literal 0 on a healthy heartbeat rather than omitting them): the summary
    # folds the latest value via `ARG_MAX(last_hb_fail_count, received_at)`, and
    # DuckDB's ARG_MAX *ignores rows where the arg is NULL*. So if a recovered
    # module sent NULL (omitted fields) after a reboot-loop session that wrote
    # last_hb_fail_count=3, ARG_MAX would skip the NULL recovery rows and latch
    # the stale 3 forever — the dashboard's "possible reboot loop" banner would
    # never clear. Sending 0 keeps the column dense so the latest heartbeat wins.
    #
    # Sequence: reboot-loop boot heartbeat carries the streak, then the now-
    # healthy heartbeat reports 0/0. The summary MUST show the cleared 0, not 3.
    import time

    client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "last_hb_fail_code": -2,
            "last_hb_fail_count": 3,
        },
    )
    # Make the recovery strictly later: received_at is stamped server-side at
    # now() with microsecond precision, and ARG_MAX picks the max-received_at
    # row — so a same-microsecond tie between the two posts could otherwise let
    # ARG_MAX pick the streak row and mask the regression this test guards.
    time.sleep(0.01)
    client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "last_hb_fail_code": 0,
            "last_hb_fail_count": 0,
        },
    )
    resp = client.get("/heartbeats_summary")
    assert resp.status_code == 200
    entry = resp.get_json()["summary"][CANONICAL_MAC]
    assert entry["last_hb_fail_count"] == 0, (
        "summary latched a stale streak — ARG_MAX skipped the cleared row; "
        "the recovery banner would never clear"
    )
    assert entry["last_hb_fail_code"] == 0


def test_heartbeat_omitting_failure_streak_stores_null(client, fresh_db):
    # Pre-#172 firmware omits both fields. A mixed fleet during the OTA rollout
    # must not 500 and must store NULL, not 0 — a real 0-count streak (the
    # healthy steady state) and "this firmware can't report a streak" are
    # different facts the dashboard renders differently.
    resp = client.post(
        "/heartbeat",
        data={"mac": CANONICAL_MAC, "rssi": -80, "fw_version": "blueberry"},
    )
    assert resp.status_code == 200
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}")
    hb = resp.get_json()["heartbeats"][0]
    assert hb["last_hb_fail_code"] is None
    assert hb["last_hb_fail_count"] is None


# ---------- stage breadcrumb on the heartbeat: last_stage_before_reboot (#172 opt 2) ----


def test_heartbeat_persists_stage_before_reboot(client, fresh_db):
    resp = client.post(
        "/heartbeat",
        data={
            "mac": CANONICAL_MAC,
            "reset_reason": "SW",
            "last_stage_before_reboot": "loop:livenessReboot",
        },
    )
    assert resp.status_code == 200, resp.get_json()
    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT last_stage_before_reboot FROM module_heartbeats "
            "WHERE module_id = ?",
            (CANONICAL_MAC,),
        ).fetchone()
    finally:
        con.close()
    assert row == ("loop:livenessReboot",)


def test_heartbeat_stage_surfaces_in_get_and_summary(client, fresh_db):
    client.post(
        "/heartbeat",
        data={"mac": CANONICAL_MAC, "last_stage_before_reboot": "setup:getGeolocation"},
    )
    hb = client.get(f"/heartbeats/{CANONICAL_MAC}").get_json()["heartbeats"][0]
    assert hb["last_stage_before_reboot"] == "setup:getGeolocation"
    summary = client.get("/heartbeats_summary").get_json()["summary"][CANONICAL_MAC]
    assert summary["last_stage_before_reboot"] == "setup:getGeolocation"


def test_heartbeat_dense_empty_stage_is_stored_not_null(client, fresh_db):
    # Dense send: a healthy module reports "" (no breadcrumb survived) — distinct
    # on the wire from legacy firmware that omits the field (NULL).
    client.post(
        "/heartbeat",
        data={"mac": CANONICAL_MAC, "last_stage_before_reboot": ""},
    )
    hb = client.get(f"/heartbeats/{CANONICAL_MAC}").get_json()["heartbeats"][0]
    assert hb["last_stage_before_reboot"] == ""


def test_heartbeat_omitting_stage_stores_null(client, fresh_db):
    # Pre-opt-2 firmware omits the field entirely → NULL, not "".
    client.post("/heartbeat", data={"mac": CANONICAL_MAC, "rssi": -70})
    hb = client.get(f"/heartbeats/{CANONICAL_MAC}").get_json()["heartbeats"][0]
    assert hb["last_stage_before_reboot"] is None


# ---------- derived heartbeat gaps: GET /heartbeats/<id>/gaps (#172 opt 3) ----
#
# Server-side complement to the device-reported streak above: the silent
# windows the device could NOT report (power loss, hang, timeout — a failed
# heartbeat never reaches the server). Derived from the persisted
# `received_at` timeline. These seed real rows with a deliberate gap and assert
# the gap lands with the right bounds — behaviour, not envelope (CLAUDE.md
# rule 5: an empty `gaps` list satisfies any shape-only assertion, which is
# exactly what a silently-broken window function looks like).


def _insert_heartbeats(fresh_db, mac, timestamps):
    """Insert bare heartbeat rows at explicit received_at instants. The
    `/heartbeat` POST stamps received_at=now(), so gaps can only be seeded by
    writing the timeline directly."""
    con = fresh_db.connection.get_conn()
    try:
        for ts in timestamps:
            con.execute(
                "INSERT INTO module_heartbeats (module_id, received_at) VALUES (?, ?)",
                (mac, ts),
            )
    finally:
        con.close()


def test_heartbeat_gaps_detects_silent_window(client, fresh_db):
    from datetime import datetime, timedelta

    base = datetime(2026, 6, 1, 0, 0, 0)
    # Hourly until 02:00, then a 4 h silence, then resumes at 06:00. Only the
    # 02:00 -> 06:00 interval (> 90 min threshold) is a gap.
    _insert_heartbeats(
        fresh_db,
        CANONICAL_MAC,
        [
            base,
            base + timedelta(hours=1),
            base + timedelta(hours=2),
            base + timedelta(hours=6),
            base + timedelta(hours=7),
        ],
    )
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}/gaps")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["module_id"] == CANONICAL_MAC
    assert len(body["gaps"]) == 1, body["gaps"]
    gap = body["gaps"][0]
    assert gap["gap_start"] == (base + timedelta(hours=2)).isoformat()
    assert gap["gap_end"] == (base + timedelta(hours=6)).isoformat()
    assert gap["gap_seconds"] == 4 * 3600


def test_heartbeat_gaps_empty_for_regular_hourly(client, fresh_db):
    from datetime import datetime, timedelta

    base = datetime(2026, 6, 2, 0, 0, 0)
    _insert_heartbeats(
        fresh_db, CANONICAL_MAC, [base + timedelta(hours=h) for h in range(6)]
    )
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}/gaps")
    assert resp.status_code == 200
    assert resp.get_json()["gaps"] == []


def test_heartbeat_gaps_newest_first(client, fresh_db):
    from datetime import datetime, timedelta

    base = datetime(2026, 6, 3, 0, 0, 0)
    # Two distinct gaps; the endpoint returns newest-first.
    _insert_heartbeats(
        fresh_db,
        CANONICAL_MAC,
        [base, base + timedelta(hours=3), base + timedelta(hours=10)],
    )
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}/gaps")
    gaps = resp.get_json()["gaps"]
    assert len(gaps) == 2
    assert gaps[0]["gap_start"] == (base + timedelta(hours=3)).isoformat()
    assert gaps[1]["gap_start"] == base.isoformat()


def test_heartbeat_gaps_unknown_module_empty(client, fresh_db):
    resp = client.get(f"/heartbeats/{CANONICAL_MAC}/gaps")
    assert resp.status_code == 200
    assert resp.get_json() == {"module_id": CANONICAL_MAC, "gaps": []}

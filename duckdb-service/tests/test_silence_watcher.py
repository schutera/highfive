"""Tests for the silence watcher (``services/silence_watcher.py``).

The watcher compares ``now`` against timestamps that every writer stamps
UTC-naive (``routes/heartbeats.py`` stamps ``received_at`` with
``datetime.now(timezone.utc).replace(tzinfo=None)``; ``record_image``
does the same for ``uploaded_at``). Pre-fix, ``check_silence`` used
naive-local ``datetime.now()``, which agrees with those rows only while
the process TZ is UTC (the ``python:3.x-slim`` default). Under a UTC+2
process TZ every computed age inflated by 2 h, so a module heard from
1.5 h ago crossed the 3 h ``SILENCE_THRESHOLD_S`` and fired a false
"down" alert; a TZ behind UTC would instead suppress real alerts. These
tests pin the UTC-naive clock discipline under a non-UTC process TZ.

The TZ fixture uses ``Etc/GMT-2`` (a fixed UTC+2 zone under the POSIX
inverted-sign convention, no DST) rather than ``Europe/Berlin`` so the
offset is deterministic year-round. ``time.tzset`` is POSIX-only, so
these tests skip on Windows; CI's ubuntu runners exercise them.
"""

from __future__ import annotations

import importlib
import os
import time
import types
from datetime import datetime, timedelta, timezone

import pytest

TEST_MAC = "aabbccddeeff"


# ---------- helpers ----------


def _utc_naive_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _seed_module(fresh_db, last_seen_at, last_silence_alert_at=None):
    """Insert a module row with explicit timestamps. The live write paths
    stamp their timestamps at now(), so a backdated liveness signal can
    only be seeded by writing the row directly (same rationale as
    ``test_heartbeats_endpoint.py``'s ``_insert_heartbeats``). Values are
    UTC-naive, exactly like the production writers'. ``last_seen_at`` is
    passed explicitly so the column's ``DEFAULT CURRENT_TIMESTAMP`` (which
    carries its own naive-local risk) never enters the picture."""
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, lat, lng, first_online, last_seen_at, "
            "last_silence_alert_at) "
            "VALUES (?, 'Watched', 47.79, 9.62, '2026-05-01', ?, ?)",
            (TEST_MAC, last_seen_at, last_silence_alert_at),
        )
        con.commit()
    finally:
        con.close()


def _fetch_alert_stamp(fresh_db):
    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT last_silence_alert_at FROM module_configs WHERE id = ?",
            (TEST_MAC,),
        ).fetchone()
        return row[0]
    finally:
        con.close()


# ---------- fixtures ----------


@pytest.fixture
def watcher(fresh_db, monkeypatch):
    """Import the watcher AFTER ``fresh_db`` so its import-time
    ``from db.connection import lock, get_conn`` binds to the test DB,
    then replace its bound ``send_discord_message`` with a spy. The
    module does ``from services.discord import send_discord_message``,
    so the patch targets the watcher's own namespace, where the name is
    looked up."""
    module = importlib.import_module("services.silence_watcher")
    calls: list[str] = []
    monkeypatch.setattr(module, "send_discord_message", calls.append)
    return types.SimpleNamespace(check_silence=module.check_silence, calls=calls)


@pytest.fixture
def utc_plus_2_tz():
    """Run the test under a fixed UTC+2 process TZ, restoring the
    original TZ (and re-running tzset) on teardown."""
    if not hasattr(time, "tzset"):
        pytest.skip("time.tzset is POSIX-only; the TZ cannot be flipped in-process")
    original = os.environ.get("TZ")
    os.environ["TZ"] = "Etc/GMT-2"
    time.tzset()
    yield
    if original is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = original
    time.tzset()


# ---------- the TZ regression (the reason this file exists) ----------


def test_module_seen_90_min_ago_does_not_alert_under_utc_plus_2(
    watcher, fresh_db, utc_plus_2_tz
):
    """REGRESSION: last heard from 1.5 h ago, half the 3 h threshold.
    Pre-fix, naive-local now() under UTC+2 added 2 h to the age
    (1.5 h -> 3.5 h) and fired a false "down" alert for a healthy
    module, every 15-minute scheduler tick, fleet-wide."""
    _seed_module(fresh_db, last_seen_at=_utc_naive_now() - timedelta(minutes=90))

    watcher.check_silence()

    assert watcher.calls == []
    assert _fetch_alert_stamp(fresh_db) is None


def test_module_silent_4_h_still_alerts_under_utc_plus_2(
    watcher, fresh_db, utc_plus_2_tz
):
    """True positive: a genuinely silent module (4 h > 3 h threshold)
    must still alert with the UTC clock. Pins that the fix suppresses
    the false positives above without muting real outages."""
    _seed_module(fresh_db, last_seen_at=_utc_naive_now() - timedelta(hours=4))

    watcher.check_silence()

    assert len(watcher.calls) == 1
    assert "Watched is down" in watcher.calls[0]


def test_alert_stamp_is_utc_naive_not_local(watcher, fresh_db, utc_plus_2_tz):
    """The ``last_silence_alert_at`` bookkeeping the watcher writes back
    must follow the same UTC-naive discipline as every other writer; a
    local-clock stamp would skew the ``REALERT_INTERVAL_S`` spacing and
    the recovery-downtime arithmetic by the UTC offset."""
    _seed_module(fresh_db, last_seen_at=_utc_naive_now() - timedelta(hours=4))

    watcher.check_silence()

    stamp = _fetch_alert_stamp(fresh_db)
    assert stamp is not None
    skew_s = abs((stamp - _utc_naive_now()).total_seconds())
    assert skew_s < 300, (
        f"last_silence_alert_at is {skew_s:.0f}s away from UTC now; "
        "an offset-sized skew means the stamp came from the local clock"
    )


# ---------- baseline watcher behaviour (TZ-independent) ----------


def test_recovered_module_fires_recovery_and_clears_state(watcher, fresh_db):
    """A module that is alive again after an alert gets exactly one
    recovery message, and the alert state clears so the next real
    outage re-alerts from scratch."""
    _seed_module(
        fresh_db,
        last_seen_at=_utc_naive_now(),
        last_silence_alert_at=_utc_naive_now() - timedelta(hours=2),
    )

    watcher.check_silence()

    assert len(watcher.calls) == 1
    assert "Watched is back" in watcher.calls[0]
    assert _fetch_alert_stamp(fresh_db) is None


def test_recent_alert_is_not_refired_within_realert_interval(watcher, fresh_db):
    """A module still silent but already alerted 2 h ago (inside the
    6 h ``REALERT_INTERVAL_S``) must stay quiet, no Discord spam."""
    _seed_module(
        fresh_db,
        last_seen_at=_utc_naive_now() - timedelta(hours=5),
        last_silence_alert_at=_utc_naive_now() - timedelta(hours=2),
    )
    stamp_before = _fetch_alert_stamp(fresh_db)

    watcher.check_silence()

    assert watcher.calls == []
    assert _fetch_alert_stamp(fresh_db) == stamp_before, (
        "suppressed re-alert must not refresh last_silence_alert_at, "
        "or the next re-alert keeps sliding forward"
    )

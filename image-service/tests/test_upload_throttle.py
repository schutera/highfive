"""Unit tests for services.upload_throttle (2026-07 audit, for #203)."""

from __future__ import annotations

from services.upload_throttle import UploadThrottle


def test_under_budget_allows():
    t = UploadThrottle(max_per_window=3, window_seconds=3600)
    assert all(t.allow("aabbccddeeff", now) for now in (0.0, 1.0, 2.0))


def test_over_budget_blocks_then_window_slides():
    t = UploadThrottle(max_per_window=2, window_seconds=100)
    assert t.allow("aabbccddeeff", 0.0)
    assert t.allow("aabbccddeeff", 10.0)
    assert not t.allow("aabbccddeeff", 20.0)
    # First event (t=0) leaves the window at t>100 → budget frees up.
    assert t.allow("aabbccddeeff", 101.0)


def test_keys_are_independent():
    t = UploadThrottle(max_per_window=1, window_seconds=3600)
    assert t.allow("aabbccddeeff", 0.0)
    assert not t.allow("aabbccddeeff", 1.0)
    assert t.allow("ccddeeff0011", 1.0), "a second module must not be starved"


def test_zero_disables():
    t = UploadThrottle(max_per_window=0)
    assert all(t.allow("aabbccddeeff", float(i)) for i in range(100))


def test_tracked_key_dict_stays_bounded_under_mac_flood():
    """Unauthenticated MACs: a client inventing a fresh MAC per request
    must not grow the dict without bound (same class as the backend's
    userLocation cache)."""
    t = UploadThrottle(max_per_window=5, window_seconds=3600, max_tracked=50)
    for i in range(500):
        t.allow(f"mac{i:012x}", float(i))
    assert len(t._events) <= 50


def test_legitimate_fleet_cadence_never_throttled():
    """Boot capture + noon capture + a full capture_gate storm (~48/day,
    ~2/hour) stays far under the default budget."""
    t = UploadThrottle()  # defaults
    mac = "aabbccddeeff"
    # Worst hour of a reboot storm: capture_gate admits ~2/hour sustained;
    # give it 10 in one hour to be pessimistic.
    assert all(t.allow(mac, i * 360.0) for i in range(10))

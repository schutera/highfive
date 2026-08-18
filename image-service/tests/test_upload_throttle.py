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


def test_mac_rotation_defeats_the_budget_this_is_the_documented_gap():
    """Pins the LIMIT of this control, so nobody mistakes it for more.

    The existing bounded-dict test performs exactly this attack and asserts
    only that the tracking dict stays small — it demonstrates the hole while
    appearing to test a defence. This asserts the hole itself, so if someone
    later closes it (see #224) this test fails loudly and gets updated,
    rather than the gap quietly persisting behind a green suite.
    """
    throttle = UploadThrottle(max_per_window=5, window_seconds=3600.0)

    # One identity is bounded: 5 through, the 6th refused.
    admitted_single = sum(
        1 for _ in range(50) if throttle.allow("aabbccddeeff", 1000.0)
    )
    assert admitted_single == 5

    # Rotating the (unauthenticated) MAC buys a fresh budget every time, so
    # the same 50 requests all land. This is why auth.md says "rate-bounded
    # per claimed identity", not "rate-bounded per caller".
    admitted_rotating = sum(
        1 for i in range(50) if throttle.allow(f"aabbccdd{i:04x}", 1000.0)
    )
    assert admitted_rotating == 50


def test_concurrent_allow_does_not_raise_under_threads():
    """app.py runs Flask with threaded=True, so `allow` is called in parallel.

    SCOPE: this is a smoke test, not a proof. The race the lock guards
    (check-then-popleft on a shared deque) could NOT be reproduced on CPython
    3.12 even with sys.setswitchinterval(1e-9) and 16 contending threads — the
    GIL makes the window extremely narrow, so this test passes with or without
    the lock today. It earns its place on 3.13/3.14 free-threaded builds, which
    the CI matrix already covers and where the GIL no longer hides the race.
    Do not read a green run here as evidence the lock is unnecessary.
    """
    import threading

    throttle = UploadThrottle(max_per_window=1000, window_seconds=0.5)
    errors: list[BaseException] = []

    def hammer(worker: int) -> None:
        try:
            for i in range(400):
                # Shared keys (contention) plus per-worker keys (dict growth
                # and pruning happening concurrently).
                throttle.allow("shared-key", 1000.0 + i * 0.01)
                throttle.allow(f"w{worker}-{i % 7}", 1000.0 + i * 0.01)
        except BaseException as exc:  # pragma: no cover - only on regression
            errors.append(exc)

    threads = [threading.Thread(target=hammer, args=(w,)) for w in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], f"concurrent allow() raised: {errors!r}"


def test_events_never_outlive_the_window_with_a_monotonic_clock():
    """A monotonic clock never goes backwards, so entries always age out.

    app.py passes time.monotonic() for exactly this reason: with wall-clock
    time an NTP step backwards leaves future-stamped events that never fall
    outside the window, silently throttling a healthy module.
    """
    throttle = UploadThrottle(max_per_window=2, window_seconds=100.0)
    assert throttle.allow("mac", 1000.0) is True
    assert throttle.allow("mac", 1000.0) is True
    assert throttle.allow("mac", 1000.0) is False
    # Past the window: budget is restored.
    assert throttle.allow("mac", 1101.0) is True

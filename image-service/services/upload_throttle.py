"""Per-module upload rate guard (2026-07 audit, for #203).

`/upload` is deliberately unauthenticated (the fleet can't hold
per-device secrets — see docs/08-crosscutting-concepts/auth.md). This
bounds a **runaway or looping module**: legitimate cadence is tiny (one
boot capture + one noon capture per module per day, and even a reboot
storm is capped device-side at ~48/day by `ESP32-CAM/lib/capture_gate`,
ADR-024), so 30/hour sits far above anything healthy while still
catching a module stuck in a capture loop.

SCOPE — read before relying on this as a security control. The key is
the client-supplied MAC, which is canonicalized but **not
authenticated**. A hostile client that rotates MACs gets a fresh budget
per invented identity, so this does NOT bound a determined attacker
filling `/data`; `_MAX_TRACKED` bounds the tracking dict, not the
writes. What actually caps a single request is `MAX_CONTENT_LENGTH`.
Closing that gap needs a second budget keyed on something the client
cannot mint — but note an IP-keyed budget must be sized for a whole
site behind one NAT, since every module at a location shares an egress
address, so a naive per-IP cap would throttle legitimate ingestion.
Tracked separately; do not read this module as more than a
runaway-module guard.

Clock-injected so it unit-tests without Flask or sleeps. Callers should
pass a MONOTONIC clock: with wall-clock time an NTP step backwards
leaves future-stamped events that never age out of the window, silently
throttling a module until they do.
"""

from __future__ import annotations

import threading
from collections import deque

DEFAULT_MAX_PER_HOUR = 30
_WINDOW_SECONDS = 3600.0

# Bound on distinct MACs tracked. The MAC arrives canonicalized but NOT
# authenticated — a client inventing random MACs per request would grow
# the dict without bound otherwise (same failure class as the backend's
# userLocation cache, fixed in the same audit).
_MAX_TRACKED = 1000


class UploadThrottle:
    """Sliding-window per-key counter: `allow(key, now)` → bool."""

    def __init__(
        self,
        max_per_window: int = DEFAULT_MAX_PER_HOUR,
        window_seconds: float = _WINDOW_SECONDS,
        max_tracked: int = _MAX_TRACKED,
    ):
        self.max_per_window = max_per_window
        self.window_seconds = window_seconds
        self.max_tracked = max_tracked
        self._events: dict[str, deque[float]] = {}
        # app.py runs Flask with threaded=True (pinned explicitly there), so
        # concurrent uploads mutate this state in parallel. `allow` is a
        # read-modify-write over a shared deque and dict: two threads draining
        # the same deque can both pass the `while events` guard before either
        # calls popleft() (IndexError), and _prune can delete a key another
        # thread just removed (KeyError). Both would surface as a 500 on a
        # live upload.
        #
        # Honesty about the evidence: neither race reproduced on CPython 3.12,
        # even with sys.setswitchinterval(1e-9) and 16 threads contending a
        # single deque — the GIL makes the window extremely narrow. The lock
        # stays anyway, because the GIL is an implementation detail rather
        # than a guarantee, and this repo's CI matrix already runs 3.13/3.14
        # where free-threaded builds remove it. An uncontended lock on a path
        # that runs tens of times per hour per module costs nothing.
        self._lock = threading.Lock()

    def allow(self, key: str, now: float) -> bool:
        """True iff `key` is under its window budget; records the event if so.

        A `max_per_window` of 0 (or negative) disables throttling entirely.
        `now` should come from a monotonic clock — see the module docstring.
        """
        if self.max_per_window <= 0:
            return True
        cutoff = now - self.window_seconds
        with self._lock:
            events = self._events.get(key)
            if events is None:
                self._prune(cutoff)
                events = self._events.setdefault(key, deque())
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= self.max_per_window:
                return False
            events.append(now)
            return True

    def _prune(self, cutoff: float) -> None:
        """Keep the tracked-key dict bounded: drop fully-expired keys first,
        then oldest-inserted keys if a flood of distinct MACs persists.

        Caller must hold `self._lock`.
        """
        if len(self._events) < self.max_tracked:
            return
        for key in [k for k, dq in self._events.items() if not dq or dq[-1] <= cutoff]:
            del self._events[key]
        while len(self._events) >= self.max_tracked:
            del self._events[next(iter(self._events))]

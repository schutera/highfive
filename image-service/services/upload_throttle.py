"""Per-module upload rate guard (2026-07 audit, for #203).

`/upload` is deliberately unauthenticated (the fleet can't hold
per-device secrets — see docs/08-crosscutting-concepts/auth.md), so the
only defence against a runaway client filling the shared `/data` volume
is a rate bound. Legitimate cadence is tiny: one boot capture + one
noon capture per module per day, and even a reboot storm is capped
device-side at ~48/day by `ESP32-CAM/lib/capture_gate` (ADR-024). The
default of 30/hour is therefore far above anything a healthy or even
storm-looping module produces, while still bounding a runaway.

Pure and clock-injected so it unit-tests without Flask or sleeps.
"""

from __future__ import annotations

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

    def allow(self, key: str, now: float) -> bool:
        """True iff `key` is under its window budget; records the event if so.

        A `max_per_window` of 0 (or negative) disables throttling entirely.
        """
        if self.max_per_window <= 0:
            return True
        cutoff = now - self.window_seconds
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
        then oldest-inserted keys if a flood of distinct MACs persists."""
        if len(self._events) < self.max_tracked:
            return
        for key in [k for k, dq in self._events.items() if not dq or dq[-1] <= cutoff]:
            del self._events[key]
        while len(self._events) >= self.max_tracked:
            del self._events[next(iter(self._events))]

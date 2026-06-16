"""In-memory ring of this service's recent stdout/stderr lines (#171).

A stdout/stderr *tee* installed at startup: every write is appended to a
bounded deque AND passed through to the real stream, so ``docker logs`` / PM2
still see everything unchanged. Captures ``print(...)`` (which re-resolves
``sys.stdout`` on every call) and anything else written to the wrapped
streams -- i.e. what the container log shows. Same idea as the ESP ``logbuf``
ring. Read via this service's internal admin-gated ``GET /logs``.

Caveats (see ADR-021): in-memory, so it resets on process restart (only holds
lines since startup) and is per-process. ``install()`` runs at import time in
``app.py`` (after the import block, before the app serves traffic), so the
Flask/werkzeug log handlers — constructed lazily at ``app.run`` / first request
— bind to the tee.
"""

import sys
import threading
from collections import deque

_MAX_RING_LINES = 2000
_ring: "deque[str]" = deque(maxlen=_MAX_RING_LINES)
_lock = threading.Lock()
_installed = False
_tees: "list[_TeeStream]" = []  # installed tee instances (for test carry reset)


class _TeeStream:
    """Wraps a real text stream; mirrors complete lines into the ring."""

    def __init__(self, real):
        self._real = real
        self._carry = ""

    def write(self, text):
        n = self._real.write(text)
        try:
            self._capture(text)
        except Exception:
            # Capture must never break real logging.
            pass
        return n

    def _capture(self, text):
        if not isinstance(text, str) or not text:
            return
        combined = self._carry + text
        parts = combined.split("\n")
        # The last element is the (possibly empty) incomplete tail.
        self._carry = parts.pop()
        if parts:
            with _lock:
                _ring.extend(parts)

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        # Delegate everything else (fileno, isatty, encoding, …) to the real
        # stream so the tee is transparent to Flask/werkzeug.
        return getattr(self._real, name)


def install():
    """Wrap sys.stdout/sys.stderr. Idempotent; call once at process start."""
    global _installed
    if _installed:
        return
    _installed = True
    out = _TeeStream(sys.stdout)
    err = _TeeStream(sys.stderr)
    _tees.extend((out, err))
    sys.stdout = out
    sys.stderr = err


def get_recent(n):
    """Return (lines, truncated): the most recent ``n`` lines oldest→newest,
    and whether the ring held more than were returned."""
    with _lock:
        items = list(_ring)
    n = max(0, min(n, len(items)))
    lines = items[len(items) - n :] if n else []
    return lines, len(items) > len(lines)


def _reset_for_test():
    with _lock:
        _ring.clear()
    # Also clear any installed tee's partial-line carry so a half-line from a
    # previous test can't bleed into the next.
    for tee in _tees:
        tee._carry = ""

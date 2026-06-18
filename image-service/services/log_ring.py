"""In-memory ring of this service's recent log entries (#171, #178).

Two ingestion paths feed the same bounded deque of structured entries
(``{"ts", "level", "msg"}``), with no double-capture:

  1. A stdout/stderr *tee* installed at startup: every write NOT produced by the
     structured logger is wrapped as an entry AND passed through to the real
     stream, so ``docker logs`` / PM2 still see everything unchanged. Captures
     ``print(...)`` and werkzeug's request lines. stdout lines become
     ``info``, stderr lines become ``error``.
  2. The structured logger (``log_event``) appends an entry directly, then
     writes its formatted human line to the *saved real* stream (bypassing the
     tee, so its own output is not re-captured as a duplicate entry).

Read via this service's internal admin-gated ``GET /logs`` and streamed live
via ``GET /logs/stream``.

Caveats (see ADR-021): in-memory, so it resets on process restart and is
per-process. On-disk persistence + startup backfill is layered on separately
(ADR-022). ``install()`` runs at import time in ``app.py`` (after the import
block, before the app serves traffic), so the Flask/werkzeug log handlers —
constructed lazily at ``app.run`` / first request — bind to the tee.
"""

import sys
import threading
from collections import deque
from datetime import UTC, datetime

_MAX_RING_ENTRIES = 2000
_ring: "deque[dict]" = deque(maxlen=_MAX_RING_ENTRIES)
_lock = threading.Lock()
_installed = False
_tees: "list[_TeeStream]" = []  # installed tee instances (for test carry reset)

# Saved real streams, so the structured logger can write past the tee.
_real_stdout = None
_real_stderr = None


def _now_iso() -> str:
    # Millisecond precision, 'Z' suffix — matches the LogEntry contract.
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _push(level: str, msg: str) -> None:
    with _lock:
        _ring.append({"ts": _now_iso(), "level": level, "msg": msg})


class _TeeStream:
    """Wraps a real text stream; mirrors complete lines into the ring as entries."""

    def __init__(self, real, level):
        self._real = real
        self._level = level
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
        for line in parts:
            _push(self._level, line)

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        # Delegate everything else (fileno, isatty, encoding, …) to the real
        # stream so the tee is transparent to Flask/werkzeug.
        return getattr(self._real, name)


def install():
    """Wrap sys.stdout/sys.stderr. Idempotent; call once at process start."""
    global _installed, _real_stdout, _real_stderr
    if _installed:
        return
    _installed = True
    _real_stdout = sys.stdout
    _real_stderr = sys.stderr
    out = _TeeStream(sys.stdout, "info")
    err = _TeeStream(sys.stderr, "error")
    _tees.extend((out, err))
    sys.stdout = out
    sys.stderr = err


def log_event(level: str, msg: str) -> None:
    """Append a structured entry AND write a formatted human line to the real
    stream (bypassing the tee, so it is not re-captured as a duplicate).

    SECURITY: never pass secrets, auth headers, request bodies, or the admin
    password — entries are admin-readable and (ADR-022) persisted to disk.
    """
    _push(level, msg)
    ts = _ring[-1]["ts"] if _ring else _now_iso()
    line = f"{ts} {level.upper()} {msg}\n"
    real = _real_stderr if level == "error" else _real_stdout
    if real is None:
        # Tee not installed yet (e.g. very early startup): fall back to the
        # current stream — capture is harmless here.
        real = sys.stderr if level == "error" else sys.stdout
    try:
        real.write(line)
    except Exception:
        pass


def get_recent(n):
    """Return (entries, truncated): the most recent ``n`` entries oldest→newest,
    and whether the ring held more than were returned."""
    with _lock:
        items = list(_ring)
    n = max(0, min(n, len(items)))
    entries = items[len(items) - n :] if n else []
    return entries, len(items) > len(entries)


def _reset_for_test():
    with _lock:
        _ring.clear()
    # Also clear any installed tee's partial-line carry so a half-line from a
    # previous test can't bleed into the next.
    for tee in _tees:
        tee._carry = ""

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
(ADR-023). ``install()`` runs at import time in ``app.py`` (after the import
block, before the app serves traffic), so the Flask/werkzeug log handlers —
constructed lazily at ``app.run`` / first request — bind to the tee.
"""

import glob
import json
import logging
import os
import queue
import sys
import threading
import time
from collections import deque
from datetime import UTC, datetime
from logging.handlers import TimedRotatingFileHandler

_MAX_RING_ENTRIES = 2000
_ring: "deque[dict]" = deque(maxlen=_MAX_RING_ENTRIES)
_lock = threading.Lock()
_installed = False
_tees: "list[_TeeStream]" = []  # installed tee instances (for test carry reset)

# Saved real streams, so the structured logger can write past the tee.
_real_stdout = None
_real_stderr = None

# On-disk persistence (#178 / ADR-023). Gated on LOG_DIR: when set, each entry is
# also appended as one JSON object per line (JSONL) to a rotating file, and the
# ring is backfilled from that file at startup so history survives a restart.
# Rotation: daily OR at 50 MB, retain ≤30 files AND ≤100 MB total (prune oldest).
_LOG_FILENAME = "service.log"  # each service has its OWN LOG_DIR (no collision)
_MAX_TOTAL_BYTES = 100 * 1024 * 1024
# Roll the active file at 50 MB too (not just at midnight), matching the Node
# rfs `size: '50M'` trigger — so a high-volume day can't grow the active file
# unbounded between daily rotations and the 100 MB total bound holds continuously.
_MAX_FILE_BYTES = 50 * 1024 * 1024
_MAX_BACKUP_FILES = 30
_disk_logger: "logging.Logger | None" = None

# Live SSE subscribers (#178 Phase 4). Each /logs/stream connection registers a
# bounded queue; _push fans every entry out to all of them (drop on full, never
# block the logger). Guarded by _lock alongside the ring.
_SUBSCRIBER_MAXSIZE = 1000
_subscribers: "set[queue.Queue]" = set()


def _now_iso() -> str:
    # Millisecond precision, 'Z' suffix — matches the LogEntry contract.
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _push(level: str, msg: str) -> dict:
    entry = {"ts": _now_iso(), "level": level, "msg": msg}
    with _lock:
        _ring.append(entry)
        subs = list(_subscribers)
    if _disk_logger is not None:
        try:
            _disk_logger.info(json.dumps(entry, ensure_ascii=False))
        except Exception:
            # Persistence must never break in-memory logging.
            pass
    for q in subs:
        try:
            q.put_nowait(entry)
        except queue.Full:
            # Slow/stuck subscriber — drop rather than block the logger.
            pass
    return entry


def subscribe() -> "queue.Queue":
    """Register a live-tail subscriber (SSE). Returns a bounded queue the caller
    drains; pair with unsubscribe() in a finally so a disconnect cleans up."""
    q: queue.Queue = queue.Queue(maxsize=_SUBSCRIBER_MAXSIZE)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q: "queue.Queue") -> None:
    with _lock:
        _subscribers.discard(q)


def _prune_by_count(log_path: str) -> None:
    """Keep only the newest _MAX_BACKUP_FILES rotated files (the active file,
    which has no `.<stamp>` suffix, is never matched)."""
    rotated = sorted(glob.glob(log_path + ".*"), key=os.path.getmtime)
    for p in rotated[:-_MAX_BACKUP_FILES] if len(rotated) > _MAX_BACKUP_FILES else []:
        try:
            os.remove(p)
        except OSError:
            pass


def _prune_by_size(log_path: str) -> None:
    """Delete oldest rotated files until the total of <log>* is ≤ 100 MB.
    Never deletes the active file — which is fine because _MAX_FILE_BYTES (50 MB)
    < _MAX_TOTAL_BYTES (100 MB), so the active file alone can't exceed the total
    cap and a size-roll always moves its bytes into an evictable rotated file."""
    files = sorted(glob.glob(log_path + "*"), key=lambda p: os.path.getmtime(p))
    total = sum(os.path.getsize(p) for p in files if os.path.exists(p))
    for p in files:
        if total <= _MAX_TOTAL_BYTES:
            break
        if p == log_path:
            continue  # keep the active file
        try:
            total -= os.path.getsize(p)
            os.remove(p)
        except OSError:
            pass


class _PruningTimedHandler(TimedRotatingFileHandler):
    """Rotate daily OR at _MAX_FILE_BYTES, retain ≤30 rotated files AND ≤100 MB
    total. We fully override ``doRollover`` because stdlib's dated filename
    (``service.log.YYYY-MM-DD``) collides on a SECOND same-day, size-triggered
    roll and then refuses to rotate — letting the active file grow unbounded.
    Our rollover always renames to a unique timestamped file, so every size
    trigger truly rotates, then enforces both retention bounds."""

    def shouldRollover(self, record):  # noqa: N802 (stdlib name)
        # Time trigger (stdlib computes self.rolloverAt) OR per-file size trigger.
        if int(time.time()) >= self.rolloverAt:
            return 1
        try:
            if self.stream is None:
                self.stream = self._open()
            self.stream.seek(0, 2)  # to EOF
            if self.stream.tell() >= _MAX_FILE_BYTES:
                return 1
        except (OSError, ValueError):
            pass
        return 0

    def doRollover(self):  # noqa: N802 (stdlib name)
        if self.stream:
            self.stream.close()
            self.stream = None
        base = self.baseFilename
        stamp = datetime.now(UTC).strftime("%Y-%m-%d_%H-%M-%S")
        dfn = f"{base}.{stamp}"
        idx = 1
        while os.path.exists(dfn):  # multiple rolls within the same second
            dfn = f"{base}.{stamp}.{idx}"
            idx += 1
        if os.path.exists(base):
            os.rename(base, dfn)
        self.rolloverAt = self.computeRollover(int(time.time()))  # next daily boundary
        if not self.delay:
            self.stream = self._open()
        _prune_by_count(base)
        _prune_by_size(base)


def _backfill_from_disk(log_path: str) -> None:
    """Load the tail of the active file into the ring so a restart shows
    pre-restart history. Skips malformed/partial lines."""
    try:
        with open(log_path, encoding="utf-8") as fh:
            lines = [ln for ln in fh.read().split("\n") if ln]
    except OSError:
        return
    for ln in lines[-_MAX_RING_ENTRIES:]:
        try:
            entry = json.loads(ln)
        except (ValueError, TypeError):
            continue
        if (
            isinstance(entry, dict)
            and "ts" in entry
            and "msg" in entry
            and entry.get("level") in ("info", "warn", "error")
        ):
            with _lock:
                _ring.append(entry)


def init_persistence(log_dir: "str | None" = None) -> None:
    """Enable on-disk persistence + startup backfill. Idempotent. Reads LOG_DIR
    when no dir is passed; a falsy value is a no-op (ring stays in-memory)."""
    global _disk_logger
    if _disk_logger is not None:
        return
    log_dir = log_dir if log_dir is not None else os.getenv("LOG_DIR")
    if not log_dir:
        return
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, _LOG_FILENAME)
    _backfill_from_disk(log_path)  # before opening the handler
    logger = logging.getLogger("hf_log_persistence")
    logger.setLevel(logging.INFO)
    logger.propagate = False  # don't reach root/stdout → no double-capture via the tee
    handler = _PruningTimedHandler(
        log_path, when="midnight", backupCount=30, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(message)s"))  # raw JSON line, no prefix
    logger.addHandler(handler)
    _disk_logger = logger
    _prune_by_size(log_path)


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
    password — entries are admin-readable and (ADR-023) persisted to disk.
    """
    entry = _push(level, msg)
    line = f"{entry['ts']} {level.upper()} {msg}\n"
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
    global _disk_logger
    with _lock:
        _ring.clear()
        _subscribers.clear()
    # Also clear any installed tee's partial-line carry so a half-line from a
    # previous test can't bleed into the next.
    for tee in _tees:
        tee._carry = ""
    # Tear down disk persistence so a later test can re-init against a fresh dir.
    if _disk_logger is not None:
        for h in list(_disk_logger.handlers):
            h.close()
            _disk_logger.removeHandler(h)
        _disk_logger = None

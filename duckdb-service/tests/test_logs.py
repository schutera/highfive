"""Tests for the internal admin-gated GET /logs server-log tail (#171, #178)."""

import io
import json
import sys
from queue import Empty

import pytest

from services import log_ring

VALID_KEY = "hf_dev_key_2026"  # dev fallback resolved when HIGHFIVE_API_KEY unset


def _msgs(entries):
    return [e["msg"] for e in entries]


def test_tee_captures_complete_lines_as_entries_and_passes_through():
    log_ring._reset_for_test()
    sink = io.StringIO()
    tee = log_ring._TeeStream(sink, "info")
    tee.write("alpha\n")
    tee.write("partial")  # no newline yet — buffered, not a line
    entries, _ = log_ring.get_recent(10)
    assert "alpha" in _msgs(entries)
    assert "partial" not in _msgs(entries)
    tee.write(" done\n")
    entries, _ = log_ring.get_recent(10)
    assert "partial done" in _msgs(entries)
    # Captured lines carry the tee's level and a timestamp.
    alpha = next(e for e in entries if e["msg"] == "alpha")
    assert alpha["level"] == "info"
    assert alpha["ts"].endswith("Z")
    # The real stream still saw every byte (tee, not intercept).
    assert sink.getvalue() == "alpha\npartial done\n"


def test_stderr_tee_records_error_level():
    log_ring._reset_for_test()
    tee = log_ring._TeeStream(io.StringIO(), "error")
    tee.write("boom\n")
    entries, _ = log_ring.get_recent(10)
    assert entries[-1] == {"ts": entries[-1]["ts"], "level": "error", "msg": "boom"}


def test_log_event_no_double_capture_in_installed_state(monkeypatch):
    # Simulate the *installed* state: sys.stdout is the tee. A correct log_event
    # writes the human line to the saved real stream (the sink) — bypassing the
    # tee — and pushes exactly one structured entry directly. A buggy log_event
    # that wrote to sys.stdout would route the formatted human line through the
    # tee, producing a SECOND ring entry (an info-level line of formatted text).
    # The exact-size assertion below is the load-bearing discriminator: it is 1
    # only if the tee never saw the logger's own output. (A substring count on
    # the raw msg would NOT catch the bug — the re-captured entry holds the
    # formatted line, a different string — so don't rely on that.)
    log_ring._reset_for_test()
    sink = io.StringIO()
    tee = log_ring._TeeStream(sink, "info")
    monkeypatch.setattr(sys, "stdout", tee)
    monkeypatch.setattr(log_ring, "_real_stdout", sink)

    log_ring.log_event("warn", "GET /modules 200 5ms")

    entries, _ = log_ring.get_recent(10)
    assert len(entries) == 1  # exactly one entry — not re-captured via the tee
    assert entries[0] == {"ts": entries[0]["ts"], "level": "warn", "msg": "GET /modules 200 5ms"}
    # The human line reached the real stream exactly once.
    assert sink.getvalue().count("GET /modules 200 5ms") == 1


def test_get_recent_clamps_and_flags_truncation():
    log_ring._reset_for_test()
    for i in range(5):
        log_ring._push("info", f"line {i}")
    entries, truncated = log_ring.get_recent(2)
    assert _msgs(entries) == ["line 3", "line 4"]
    assert truncated is True


def test_ring_caps_at_max_and_evicts_oldest():
    log_ring._reset_for_test()
    total = log_ring._MAX_RING_ENTRIES + 10
    for i in range(total):
        log_ring._push("info", f"L{i}")
    entries, truncated = log_ring.get_recent(total)
    assert len(entries) == log_ring._MAX_RING_ENTRIES  # bounded
    assert entries[0]["msg"] == "L10"  # first 10 evicted
    assert entries[-1]["msg"] == f"L{total - 1}"  # newest kept
    assert truncated is False  # asked for >= ring size


def test_logs_requires_admin_key(client):
    log_ring._reset_for_test()
    assert client.get("/logs").status_code == 401
    assert client.get("/logs", headers={"X-Admin-Key": "wrong"}).status_code == 401


def test_logs_returns_ring_with_valid_key(client):
    log_ring._reset_for_test()
    log_ring._push("info", "duckdb marker line")
    resp = client.get("/logs?lines=50", headers={"X-Admin-Key": VALID_KEY})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["service"] == "duckdb-service"
    assert "duckdb marker line" in _msgs(body["entries"])
    # Each entry carries the structured wire shape.
    entry = body["entries"][-1]
    assert set(entry.keys()) == {"ts", "level", "msg"}
    assert body["truncated"] is False


def test_logs_route_honours_lines_and_reports_truncation(client):
    log_ring._reset_for_test()
    for i in range(5):
        log_ring._push("info", f"row {i}")
    resp = client.get("/logs?lines=2", headers={"X-Admin-Key": VALID_KEY})
    body = resp.get_json()
    assert _msgs(body["entries"]) == ["row 3", "row 4"]
    assert body["truncated"] is True


def test_access_log_emits_entry_per_request(client):
    # The @app.after_request hook (#178) emits one structured access entry per
    # handled request. A real request must land as an entry (CLAUDE.md rule #5).
    log_ring._reset_for_test()
    resp = client.get("/health")
    assert resp.status_code == 200
    entries, _ = log_ring.get_recent(50)
    access = [e for e in entries if e["msg"].startswith("GET /health 200 ")]
    assert len(access) == 1
    assert access[0]["level"] == "info"
    assert access[0]["msg"].endswith("ms")


def test_access_log_redacts_query_and_credentials(client):
    # path ONLY: the token-ish query param and the admin key must never appear
    # in any entry, and no entry may carry a query string.
    log_ring._reset_for_test()
    resp = client.get("/logs?lines=5&token=secret123", headers={"X-Admin-Key": VALID_KEY})
    assert resp.status_code == 200
    blob = "\n".join(_msgs(log_ring.get_recent(50)[0]))
    assert "secret123" not in blob
    assert "?" not in blob
    assert VALID_KEY not in blob
    assert "X-Admin-Key" not in blob
    # The path itself is still logged (without the query).
    assert any(e["msg"].startswith("GET /logs 200 ") for e in log_ring.get_recent(50)[0])


def test_persistence_writes_jsonl(tmp_path):
    log_ring._reset_for_test()
    log_ring.init_persistence(str(tmp_path))
    log_ring._push("info", "persist alpha")
    log_ring._push("warn", "persist bravo")
    log_ring._reset_for_test()  # closes the handler, flushing to disk

    lines = (tmp_path / "service.log").read_text(encoding="utf-8").splitlines()
    parsed = [json.loads(ln) for ln in lines if ln]
    assert [p["msg"] for p in parsed] == ["persist alpha", "persist bravo"]
    assert parsed[0]["level"] == "info" and parsed[1]["level"] == "warn"
    assert set(parsed[0].keys()) == {"ts", "level", "msg"}


def test_persistence_backfills_ring_on_restart(tmp_path):
    log_ring._reset_for_test()
    log_ring.init_persistence(str(tmp_path))
    log_ring._push("info", "prior 1")
    log_ring._push("info", "prior 2")
    log_ring._reset_for_test()  # ring cleared + handler closed == "process exit"
    assert log_ring.get_recent(10)[0] == []

    log_ring.init_persistence(str(tmp_path))  # "restart"
    assert _msgs(log_ring.get_recent(10)[0]) == ["prior 1", "prior 2"]


def test_persistence_is_noop_without_dir(tmp_path):
    log_ring._reset_for_test()
    log_ring.init_persistence(None)  # no LOG_DIR → in-memory only
    log_ring._push("info", "in-memory only")
    assert "in-memory only" in _msgs(log_ring.get_recent(10)[0])
    assert list(tmp_path.iterdir()) == []


# --- SSE live tail (#178 Phase 4) ---


def test_subscribe_receives_push_then_unsubscribe_stops():
    log_ring._reset_for_test()
    q = log_ring.subscribe()
    log_ring._push("warn", "sub-entry")
    got = q.get_nowait()
    assert got["msg"] == "sub-entry" and got["level"] == "warn"
    log_ring.unsubscribe(q)
    log_ring._push("info", "after-unsub")
    with pytest.raises(Empty):
        q.get_nowait()


def test_stream_requires_admin_key(client):
    assert client.get("/logs/stream").status_code == 401
    assert client.get("/logs/stream", headers={"X-Admin-Key": "wrong"}).status_code == 401


def test_stream_emits_pushed_entry_as_sse(client):
    log_ring._reset_for_test()
    resp = client.get("/logs/stream", headers={"X-Admin-Key": VALID_KEY})
    assert resp.status_code == 200
    assert resp.mimetype == "text/event-stream"
    assert resp.headers.get("X-Accel-Buffering") == "no"

    it = iter(resp.response)
    first = next(it)  # ": connected" — also registers the subscriber
    assert b"connected" in (first if isinstance(first, bytes) else first.encode())

    log_ring._push("error", "stream-entry")
    chunk = next(it)
    text = chunk.decode() if isinstance(chunk, bytes) else chunk
    assert text.startswith("data: ")
    payload = json.loads(text[len("data: ") :].strip())
    assert payload["msg"] == "stream-entry" and payload["level"] == "error"
    it.close()

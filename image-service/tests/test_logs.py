"""Tests for the internal admin-gated GET /logs server-log tail (#171, #178)."""

import io
import sys

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
    alpha = next(e for e in entries if e["msg"] == "alpha")
    assert alpha["level"] == "info"
    assert alpha["ts"].endswith("Z")
    assert sink.getvalue() == "alpha\npartial done\n"


def test_stderr_tee_records_error_level():
    log_ring._reset_for_test()
    tee = log_ring._TeeStream(io.StringIO(), "error")
    tee.write("boom\n")
    entries, _ = log_ring.get_recent(10)
    assert entries[-1]["level"] == "error"
    assert entries[-1]["msg"] == "boom"


def test_log_event_no_double_capture_in_installed_state(monkeypatch):
    # Simulate the *installed* state: sys.stdout is the tee. If log_event wrote
    # to sys.stdout instead of the saved real stream, the tee would re-capture
    # it and the message would land in the ring twice. The real stream behind
    # the tee is the sink, which is also log_event's bypass target — so a
    # correct implementation writes the human line once (to the sink) and
    # pushes the entry once (directly), never through the tee.
    log_ring._reset_for_test()
    sink = io.StringIO()
    tee = log_ring._TeeStream(sink, "info")
    monkeypatch.setattr(sys, "stdout", tee)
    monkeypatch.setattr(log_ring, "_real_stdout", sink)

    log_ring.log_event("warn", "POST /upload 200 8ms")

    entries, _ = log_ring.get_recent(10)
    assert entries[-1]["level"] == "warn"
    assert entries[-1]["msg"] == "POST /upload 200 8ms"
    assert _msgs(entries).count("POST /upload 200 8ms") == 1
    assert sink.getvalue().count("POST /upload 200 8ms") == 1


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
    log_ring._push("info", "image marker line")
    resp = client.get("/logs?lines=50", headers={"X-Admin-Key": VALID_KEY})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["service"] == "image-service"
    assert "image marker line" in _msgs(body["entries"])
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

"""Tests for the internal admin-gated GET /logs server-log tail (#171)."""

import io

from services import log_ring

VALID_KEY = "hf_dev_key_2026"  # dev fallback resolved when HIGHFIVE_API_KEY unset


def test_tee_captures_complete_lines_and_passes_through():
    log_ring._reset_for_test()
    sink = io.StringIO()
    tee = log_ring._TeeStream(sink)
    tee.write("alpha\n")
    tee.write("partial")  # no newline yet — buffered, not a line
    lines, _ = log_ring.get_recent(10)
    assert "alpha" in lines
    assert "partial" not in lines
    tee.write(" done\n")
    lines, _ = log_ring.get_recent(10)
    assert "partial done" in lines
    # The real stream still saw every byte (tee, not intercept).
    assert sink.getvalue() == "alpha\npartial done\n"


def test_get_recent_clamps_and_flags_truncation():
    log_ring._reset_for_test()
    for i in range(5):
        log_ring._ring.append(f"line {i}")
    lines, truncated = log_ring.get_recent(2)
    assert lines == ["line 3", "line 4"]
    assert truncated is True


def test_ring_caps_at_max_and_evicts_oldest():
    log_ring._reset_for_test()
    total = log_ring._MAX_RING_LINES + 10
    for i in range(total):
        log_ring._ring.append(f"L{i}")
    lines, truncated = log_ring.get_recent(total)
    assert len(lines) == log_ring._MAX_RING_LINES  # bounded
    assert lines[0] == "L10"  # first 10 evicted
    assert lines[-1] == f"L{total - 1}"  # newest kept
    assert truncated is False  # asked for >= ring size


def test_logs_requires_admin_key(client):
    log_ring._reset_for_test()
    assert client.get("/logs").status_code == 401
    assert client.get("/logs", headers={"X-Admin-Key": "wrong"}).status_code == 401


def test_logs_returns_ring_with_valid_key(client):
    log_ring._reset_for_test()
    log_ring._ring.append("duckdb marker line")
    resp = client.get("/logs?lines=50", headers={"X-Admin-Key": VALID_KEY})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["service"] == "duckdb-service"
    assert "duckdb marker line" in body["lines"]
    assert body["truncated"] is False


def test_logs_route_honours_lines_and_reports_truncation(client):
    log_ring._reset_for_test()
    for i in range(5):
        log_ring._ring.append(f"row {i}")
    resp = client.get("/logs?lines=2", headers={"X-Admin-Key": VALID_KEY})
    body = resp.get_json()
    assert body["lines"] == ["row 3", "row 4"]
    assert body["truncated"] is True

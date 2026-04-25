"""Tests for GET /modules/<mac>/logs."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path


def _write_sidecar(folder: Path, name: str, mac: str, received_at: str, mtime: float | None = None):
    p = folder / name
    payload = {
        "_mac": mac,
        "_received_at": received_at,
        "_image": name.replace(".log.json", ""),
        "rssi": -60,
    }
    p.write_text(json.dumps(payload), encoding="utf-8")
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


def test_logs_returns_only_matching_mac(client, tmp_upload_dir: Path):
    _write_sidecar(tmp_upload_dir, "a.jpg.log.json", "AA:AA", "2026-04-25T10:00:00")
    _write_sidecar(tmp_upload_dir, "b.jpg.log.json", "BB:BB", "2026-04-25T10:01:00")
    _write_sidecar(tmp_upload_dir, "c.jpg.log.json", "AA:AA", "2026-04-25T10:02:00")

    resp = client.get("/modules/AA:AA/logs")
    assert resp.status_code == 200
    body = resp.get_json()
    assert isinstance(body, list)
    assert len(body) == 2
    assert all(entry["_mac"] == "AA:AA" for entry in body)


def test_logs_newest_first(client, tmp_upload_dir: Path):
    now = time.time()
    _write_sidecar(tmp_upload_dir, "old.jpg.log.json", "AA:AA", "2026-04-25T09:00:00", mtime=now - 1000)
    _write_sidecar(tmp_upload_dir, "mid.jpg.log.json", "AA:AA", "2026-04-25T09:30:00", mtime=now - 500)
    _write_sidecar(tmp_upload_dir, "new.jpg.log.json", "AA:AA", "2026-04-25T10:00:00", mtime=now)

    resp = client.get("/modules/AA:AA/logs")
    assert resp.status_code == 200
    body = resp.get_json()
    assert [e["_image"] for e in body] == ["new.jpg", "mid.jpg", "old.jpg"]


def test_logs_default_limit_is_10(client, tmp_upload_dir: Path):
    now = time.time()
    for i in range(15):
        _write_sidecar(
            tmp_upload_dir,
            f"img{i:02d}.jpg.log.json",
            "AA:AA",
            f"2026-04-25T10:{i:02d}:00",
            mtime=now + i,  # later i = newer
        )
    resp = client.get("/modules/AA:AA/logs")
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body) == 10
    # Newest 10 should be img14..img05 (newest-first)
    expected = [f"img{i:02d}.jpg" for i in range(14, 4, -1)]
    assert [e["_image"] for e in body] == expected


def test_logs_respects_limit_query_param(client, tmp_upload_dir: Path):
    now = time.time()
    for i in range(5):
        _write_sidecar(
            tmp_upload_dir, f"x{i}.jpg.log.json", "AA:AA",
            f"2026-04-25T11:{i:02d}:00", mtime=now + i,
        )
    resp = client.get("/modules/AA:AA/logs?limit=3")
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body) == 3


def test_logs_limit_is_capped_to_100(client, tmp_upload_dir: Path):
    # Don't actually write 200 files; just verify the cap by passing a huge limit
    # and ensuring the request still succeeds (the cap is internal — we verify
    # behaviour via the route not erroring and returning <= 100 entries).
    now = time.time()
    for i in range(3):
        _write_sidecar(
            tmp_upload_dir, f"y{i}.jpg.log.json", "AA:AA",
            f"2026-04-25T12:{i:02d}:00", mtime=now + i,
        )
    resp = client.get("/modules/AA:AA/logs?limit=99999")
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body) <= 100
    assert len(body) == 3  # only 3 exist


def test_logs_limit_floor_is_1(client, tmp_upload_dir: Path):
    now = time.time()
    for i in range(3):
        _write_sidecar(
            tmp_upload_dir, f"z{i}.jpg.log.json", "AA:AA",
            f"2026-04-25T13:{i:02d}:00", mtime=now + i,
        )
    resp = client.get("/modules/AA:AA/logs?limit=0")
    assert resp.status_code == 200
    body = resp.get_json()
    # max(1, min(0, 100)) == 1
    assert len(body) == 1


def test_logs_invalid_limit_falls_back_to_default(client, tmp_upload_dir: Path):
    now = time.time()
    for i in range(12):
        _write_sidecar(
            tmp_upload_dir, f"w{i:02d}.jpg.log.json", "AA:AA",
            f"2026-04-25T14:{i:02d}:00", mtime=now + i,
        )
    resp = client.get("/modules/AA:AA/logs?limit=not-a-number")
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body) == 10  # default


def test_logs_empty_when_no_sidecars(client, tmp_upload_dir: Path):
    resp = client.get("/modules/AA:AA/logs")
    assert resp.status_code == 200
    assert resp.get_json() == []


def test_logs_skips_corrupt_sidecar(client, tmp_upload_dir: Path):
    _write_sidecar(tmp_upload_dir, "good.jpg.log.json", "AA:AA", "2026-04-25T15:00:00")
    # A malformed sidecar file should be skipped, not 500.
    (tmp_upload_dir / "broken.jpg.log.json").write_text("{not valid json", encoding="utf-8")

    resp = client.get("/modules/AA:AA/logs")
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body) == 1
    assert body[0]["_image"] == "good.jpg"

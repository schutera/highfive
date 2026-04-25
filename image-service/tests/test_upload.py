"""Tests for POST /upload."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path

import pytest


# --------------------------- helpers ---------------------------

def _img_bytes() -> bytes:
    # Minimal 1x1 PNG, valid enough to be saved by Flask. Content is opaque
    # to the service — it does not decode the image.
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00"
        b"\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def _make_form(*, mac="AA:BB:CC:DD:EE:FF", battery="80", filename="test.jpg",
               include_image=True, logs=None):
    data = {}
    if mac is not None:
        data["mac"] = mac
    if battery is not None:
        data["battery"] = battery
    if logs is not None:
        data["logs"] = logs
    if include_image:
        data["image"] = (io.BytesIO(_img_bytes()), filename)
    return data


# --------------------------- happy path ---------------------------

def test_upload_happy_path_saves_image_and_returns_classification(
    client, tmp_upload_dir: Path, upload_env
):
    resp = client.post(
        "/upload",
        data=_make_form(filename="bee01.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200, resp.get_json()
    body = resp.get_json()

    assert body["mac"] == "AA:BB:CC:DD:EE:FF"
    assert body["battery"] == 80
    assert "Image bee01.jpg uploaded successfully" in body["message"]
    # Classification stub structure
    assert set(body["classification"].keys()) == {
        "black_masked_bee", "leafcutter_bee", "orchard_bee", "resin_bee"
    }
    for species, slots in body["classification"].items():
        assert set(slots.keys()) == {"1", "2", "3", "4"}
        for v in slots.values():
            assert v in (0, 1)

    # Image file landed on disk in the configured upload folder.
    saved = tmp_upload_dir / "bee01.jpg"
    assert saved.exists()
    assert saved.read_bytes() == _img_bytes()

    # No logs field => no sidecar should be written.
    assert not (tmp_upload_dir / "bee01.jpg.log.json").exists()

    # Outbound POST to duckdb-service was attempted.
    assert len(upload_env["duckdb_posts"]) == 1
    call = upload_env["duckdb_posts"][0]
    assert call["url"].endswith("/add_progress_for_module")
    assert call["json"]["modul_id"] == "AA:BB:CC:DD:EE:FF"
    assert "classification" in call["json"]


def test_upload_with_logs_writes_sidecar(client, tmp_upload_dir: Path, upload_env):
    logs_payload = {"rssi": -55, "uptime_s": 1234, "fw": "1.0.0"}
    resp = client.post(
        "/upload",
        data=_make_form(filename="bee02.jpg", logs=json.dumps(logs_payload)),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200

    sidecar = tmp_upload_dir / "bee02.jpg.log.json"
    assert sidecar.exists(), "expected .log.json sidecar"
    data = json.loads(sidecar.read_text(encoding="utf-8"))

    # Original telemetry preserved
    assert data["rssi"] == -55
    assert data["uptime_s"] == 1234
    assert data["fw"] == "1.0.0"

    # Service-injected metadata
    assert data["_mac"] == "AA:BB:CC:DD:EE:FF"
    assert data["_image"] == "bee02.jpg"
    assert "_received_at" in data and isinstance(data["_received_at"], str)
    # No parse error on valid JSON
    assert "parse_error" not in data


def test_upload_battery_accepts_zero_and_hundred(client, upload_env):
    for batt in ("0", "100"):
        resp = client.post(
            "/upload",
            data=_make_form(battery=batt, filename=f"img-{batt}.jpg"),
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200, (batt, resp.get_json())
        assert resp.get_json()["battery"] == int(batt)


# --------------------------- validation ---------------------------

def test_upload_missing_mac_returns_400(client, upload_env):
    resp = client.post(
        "/upload",
        data=_make_form(mac=None),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "mac" in resp.get_json()["error"].lower()


def test_upload_missing_battery_returns_400(client, upload_env):
    resp = client.post(
        "/upload",
        data=_make_form(battery=None),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "battery" in resp.get_json()["error"].lower()


def test_upload_battery_non_integer_returns_400(client, upload_env):
    resp = client.post(
        "/upload",
        data=_make_form(battery="not-a-number"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "integer" in resp.get_json()["error"].lower()


@pytest.mark.parametrize("bad", ["-1", "101", "999"])
def test_upload_battery_out_of_range_returns_400(client, upload_env, bad):
    resp = client.post(
        "/upload",
        data=_make_form(battery=bad),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "between 0 and 100" in resp.get_json()["error"].lower()


def test_upload_missing_image_file_returns_400(client, upload_env):
    resp = client.post(
        "/upload",
        data=_make_form(include_image=False),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "image" in resp.get_json()["error"].lower()


def test_upload_empty_filename_returns_400(client, upload_env):
    resp = client.post(
        "/upload",
        data=_make_form(filename=""),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "selected" in resp.get_json()["error"].lower()


# --------------------------- telemetry edge cases ---------------------------

def test_upload_no_logs_field_writes_no_sidecar(client, tmp_upload_dir: Path, upload_env):
    resp = client.post(
        "/upload",
        data=_make_form(filename="nolog.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    # No sidecar created
    sidecars = list(tmp_upload_dir.glob("*.log.json"))
    assert sidecars == []


def test_upload_malformed_logs_writes_sidecar_with_parse_error(
    client, tmp_upload_dir: Path, upload_env
):
    resp = client.post(
        "/upload",
        data=_make_form(filename="bad.jpg", logs="this is not json {{"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200

    sidecar = tmp_upload_dir / "bad.jpg.log.json"
    assert sidecar.exists()
    data = json.loads(sidecar.read_text(encoding="utf-8"))
    assert data.get("parse_error") is True
    assert data.get("raw") == "this is not json {{"
    assert data["_mac"] == "AA:BB:CC:DD:EE:FF"
    assert data["_image"] == "bad.jpg"

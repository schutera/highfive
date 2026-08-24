"""Tests for POST /upload."""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import cv2
import numpy as np
import pytest

# Canonical 12-hex-char ModuleId form. The legacy AA:BB:CC:DD:EE:FF input
# canonicalises to this same value.
TEST_MAC = "aabbccddeeff"
TEST_MAC_LEGACY = "AA:BB:CC:DD:EE:FF"


# --------------------------- helpers ---------------------------


def _img_bytes() -> bytes:
    # A real, small JPEG (2026-08 audit, for #228): probe_jpeg now inspects
    # the bytes before save/decode, so the fixture must be a genuine JPEG,
    # not the opaque-content PNG this used to be. A flat 32x32 frame is
    # deliberately featureless — verified (see test_image_guard.py's sibling
    # check and this module's own detection tests below) to produce zero
    # hole-detector snips, keeping the duckdb POST count assertions in the
    # happy-path tests unaffected by the real ONNX model.
    img = np.zeros((32, 32, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


def _png_bytes() -> bytes:
    # Minimal 1x1 PNG — used by the negative tests below to prove the
    # service now actually inspects upload bytes instead of trusting the
    # client-supplied filename/extension.
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00"
        b"\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def _oversized_jpeg_header_bytes(height: int = 20000, width: int = 20000) -> bytes:
    """A hand-built JPEG whose SOF0 declares an oversized frame — no real
    encoder will happily produce a 20000x20000 image for a test fixture,
    and probe_jpeg only ever reads the header, so this is enough to
    exercise the rejection without gigabytes of pixel data."""
    sof_payload = (
        bytes([8])
        + struct.pack(">H", height)
        + struct.pack(">H", width)
        + bytes([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])
    )
    return (
        b"\xff\xd8"
        + b"\xff\xc0"
        + struct.pack(">H", 2 + len(sof_payload))
        + sof_payload
    )


def _make_form(
    *,
    mac=TEST_MAC,
    battery="80",
    filename="test.jpg",
    include_image=True,
    logs=None,
):
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

    assert body["mac"] == TEST_MAC
    assert body["battery"] == 80
    assert "Image bee01.jpg uploaded successfully" in body["message"]
    # Classification stub structure
    assert set(body["classification"].keys()) == {
        "black_masked_bee",
        "leafcutter_bee",
        "orchard_bee",
        "resin_bee",
    }
    for _species, slots in body["classification"].items():
        assert set(slots.keys()) == {"1", "2", "3", "4"}
        for v in slots.values():
            assert v in (0, 1)

    # Image file landed on disk in the configured upload folder.
    saved = tmp_upload_dir / "bee01.jpg"
    assert saved.exists()
    assert saved.read_bytes() == _img_bytes()

    # No logs field => no sidecar should be written.
    assert not (tmp_upload_dir / "bee01.jpg.log.json").exists()

    # Outbound POSTs to duckdb-service: /record_image, /add_progress_for_module
    # and /heartbeat.
    posts = upload_env["duckdb_posts"]
    assert len(posts) == 3

    progress_calls = [p for p in posts if p["url"].endswith("/add_progress_for_module")]
    assert len(progress_calls) == 1
    # Wire field is now canonical ``module_id`` (was the legacy ``modul_id`` typo).
    assert progress_calls[0]["json"]["module_id"] == TEST_MAC
    assert "classification" in progress_calls[0]["json"]

    heartbeat_calls = [
        p for p in posts if p["url"].endswith(f"/modules/{TEST_MAC}/heartbeat")
    ]
    assert len(heartbeat_calls) == 1
    assert heartbeat_calls[0]["json"] == {"battery": 80}

    # /record_image fires once after the file lands on disk (#58).
    record_image_calls = [p for p in posts if p["url"].endswith("/record_image")]
    assert len(record_image_calls) == 1
    assert record_image_calls[0]["json"] == {
        "module_id": TEST_MAC,
        "filename": "bee01.jpg",
    }

    # progress_count is fetched once per upload via GET.
    gets = upload_env["duckdb_gets"]
    progress_count_calls = [
        g for g in gets if g["url"].endswith(f"/modules/{TEST_MAC}/progress_count")
    ]
    assert len(progress_count_calls) == 1


def test_upload_canonicalises_legacy_colon_mac(client, upload_env):
    """Legacy ``AA:BB:CC:DD:EE:FF`` form is normalised to canonical."""
    resp = client.post(
        "/upload",
        data=_make_form(mac=TEST_MAC_LEGACY, filename="legacy.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200, resp.get_json()
    assert resp.get_json()["mac"] == TEST_MAC

    # Downstream POSTs see the canonical form, not the colon-separated input.
    posts = upload_env["duckdb_posts"]
    progress_calls = [p for p in posts if p["url"].endswith("/add_progress_for_module")]
    assert progress_calls[0]["json"]["module_id"] == TEST_MAC
    heartbeat_urls = [p["url"] for p in posts if p["url"].endswith("/heartbeat")]
    assert any(f"/modules/{TEST_MAC}/heartbeat" in u for u in heartbeat_urls)
    record_image_calls = [p for p in posts if p["url"].endswith("/record_image")]
    assert len(record_image_calls) == 1
    assert record_image_calls[0]["json"]["module_id"] == TEST_MAC


def test_upload_invalid_mac_returns_400(client, upload_env):
    resp = client.post(
        "/upload",
        data=_make_form(mac="not-a-mac", filename="bad.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert "mac" in resp.get_json()["error"].lower()


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

    # New envelope schema: metadata at top level, ESP telemetry nested under `payload`.
    assert data["mac"] == TEST_MAC
    assert data["image"] == "bee02.jpg"
    assert "received_at" in data and isinstance(data["received_at"], str)

    # Original telemetry preserved under `payload`.
    assert data["payload"]["rssi"] == -55
    assert data["payload"]["uptime_s"] == 1234
    assert data["payload"]["fw"] == "1.0.0"
    # No parse error on valid JSON
    assert "parse_error" not in data["payload"]
    # Legacy flat keys must NOT be present
    assert "_mac" not in data
    assert "_image" not in data
    assert "_received_at" not in data


def test_upload_battery_accepts_zero_and_hundred(client, upload_env):
    for batt in ("0", "100"):
        resp = client.post(
            "/upload",
            data=_make_form(battery=batt, filename=f"img-{batt}.jpg"),
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200, (batt, resp.get_json())
        assert resp.get_json()["battery"] == int(batt)


# ---------------- content validation (2026-08 audit, for #228) ----------------


def _persisted_files(upload_dir: Path) -> list[Path]:
    """Files (not directories — `snips/` is created empty at app boot,
    unrelated to any one upload) under the upload folder."""
    return [p for p in upload_dir.rglob("*") if p.is_file()]


def test_upload_non_jpeg_bytes_returns_400_and_persists_nothing(
    client, tmp_upload_dir: Path, upload_env
):
    """A stored `.html` would be served back and could run same-origin
    against the admin session cookie (SEC-9) — the fix is to inspect the
    bytes, not the client-declared filename or Content-Type."""
    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(b"<script>alert(1)</script>"), "evil.html")
    resp = client.post("/upload", data=form, content_type="multipart/form-data")
    assert resp.status_code == 400
    assert "invalid image" in resp.get_json()["error"].lower()
    assert _persisted_files(tmp_upload_dir) == [], "nothing may be persisted"


@pytest.mark.parametrize("filename", ["image.svg", "image.xhtml", "x.jpg.log.json"])
def test_upload_non_jpeg_bytes_rejected_regardless_of_extension(
    client, tmp_upload_dir: Path, upload_env, filename
):
    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(b"not a jpeg"), filename)
    resp = client.post("/upload", data=form, content_type="multipart/form-data")
    assert resp.status_code == 400
    assert _persisted_files(tmp_upload_dir) == []


def test_upload_png_bytes_named_jpg_returns_400(
    client, tmp_upload_dir: Path, upload_env
):
    """Content is no longer opaque — a PNG posted as `test.jpg` (the shape
    the pre-fix test fixture itself used) must now be rejected."""
    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(_png_bytes()), "test.jpg")
    resp = client.post("/upload", data=form, content_type="multipart/form-data")
    assert resp.status_code == 400
    assert _persisted_files(tmp_upload_dir) == []


def test_upload_oversized_sof_returns_400_and_never_reaches_imread(
    client, tmp_upload_dir: Path, upload_env, monkeypatch
):
    """A crafted JPEG whose SOF0 declares a 20000x20000 frame must be
    rejected before any decoder allocates a buffer for it (SEC-10)."""
    import services.hole_detection as hole_detection_mod

    imread_calls: list[str] = []
    original_imread = hole_detection_mod.cv2.imread

    def spy_imread(path, *a, **kw):
        imread_calls.append(path)
        return original_imread(path, *a, **kw)

    monkeypatch.setattr(hole_detection_mod.cv2, "imread", spy_imread)

    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(_oversized_jpeg_header_bytes()), "huge.jpg")
    resp = client.post("/upload", data=form, content_type="multipart/form-data")
    assert resp.status_code == 400
    assert "invalid image" in resp.get_json()["error"].lower()
    assert _persisted_files(tmp_upload_dir) == []
    assert imread_calls == [], "cv2.imread must never see a rejected upload"


def test_upload_valid_jpeg_named_svg_is_stored_as_jpg(
    client, tmp_upload_dir: Path, upload_env
):
    """The bytes are what matter, not the client-declared extension — a
    real JPEG named `photo.svg` is accepted and stored as `.jpg`."""
    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(_img_bytes()), "photo.svg")
    resp = client.post("/upload", data=form, content_type="multipart/form-data")
    assert resp.status_code == 200, resp.get_json()
    assert resp.get_json()["message"].startswith("Image photo.jpg ")
    assert (tmp_upload_dir / "photo.jpg").exists()
    assert not list(tmp_upload_dir.glob("*.svg"))


def test_upload_honours_max_image_dim_env_override(
    client, tmp_upload_dir: Path, upload_env, monkeypatch
):
    """A real capture that's fine under the 4096 default is rejected once
    the operator configures a tighter MAX_IMAGE_DIM."""
    monkeypatch.setenv("MAX_IMAGE_DIM", "10")
    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(_img_bytes()), "capture.jpg")  # 32x32
    resp = client.post("/upload", data=form, content_type="multipart/form-data")
    assert resp.status_code == 400
    assert _persisted_files(tmp_upload_dir) == []


@pytest.mark.parametrize(
    "capture_name",
    ["block_tungsten_640.jpg", "block_warm_1024.jpg"],
)
def test_upload_real_captures_still_accepted(
    client, tmp_upload_dir: Path, upload_env, capture_name
):
    """Real ESP32-CAM fleet output — the ground truth this whole guard is
    calibrated against — must keep uploading with 200 after the fix."""
    fixture_path = (
        Path(__file__).resolve().parents[2]
        / "dev-tools"
        / "real_captures"
        / capture_name
    )
    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(fixture_path.read_bytes()), capture_name)
    resp = client.post("/upload", data=form, content_type="multipart/form-data")
    assert resp.status_code == 200, resp.get_json()
    assert (tmp_upload_dir / capture_name).exists()


def test_serve_image_404s_log_json_sidecar(client, tmp_upload_dir: Path, upload_env):
    """`GET /images/<name>.log.json` must 404 even when the file exists on
    disk — the sidecar stays reachable only via the admin-gated
    `GET /modules/<mac>/logs` (SEC-4)."""
    sidecar = tmp_upload_dir / "cap.jpg.log.json"
    sidecar.write_text('{"mac": "aabbccddeeff"}', encoding="utf-8")
    resp = client.get("/images/cap.jpg.log.json")
    assert resp.status_code == 404


def test_serve_image_sets_image_jpeg_content_type(
    client, tmp_upload_dir: Path, upload_env
):
    resp = client.post(
        "/upload",
        data=_make_form(filename="ct-check.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    resp = client.get("/images/ct-check.jpg")
    assert resp.status_code == 200
    assert resp.content_type == "image/jpeg"


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


def test_upload_no_logs_field_writes_no_sidecar(
    client, tmp_upload_dir: Path, upload_env
):
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
    # Parse-error markers live inside the nested payload now.
    assert data["payload"].get("parse_error") is True
    assert data["payload"].get("raw") == "this is not json {{"
    assert data["mac"] == TEST_MAC
    assert data["image"] == "bad.jpg"


# --------------------------- duckdb-service integration ---------------------------


def test_upload_first_upload_triggers_discord(client, upload_env):
    """When progress_count returns 0, this is the first upload — Discord fires."""
    upload_env["duckdb_http"]["progress_count"] = 0

    resp = client.post(
        "/upload",
        data=_make_form(filename="first.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    assert len(upload_env["discord"]) == 1
    assert "First image received" in upload_env["discord"][0]


def test_upload_non_first_upload_does_not_trigger_discord(client, upload_env):
    """When progress_count > 0, Discord stays silent."""
    upload_env["duckdb_http"]["progress_count"] = 7

    resp = client.post(
        "/upload",
        data=_make_form(filename="not-first.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    assert upload_env["discord"] == []


def test_upload_heartbeat_called_with_battery_value(client, upload_env):
    """Heartbeat receives the exact integer battery value."""
    resp = client.post(
        "/upload",
        data=_make_form(battery="42", filename="batt.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200

    heartbeats = [
        p for p in upload_env["duckdb_posts"] if p["url"].endswith("/heartbeat")
    ]
    assert len(heartbeats) == 1
    assert heartbeats[0]["json"] == {"battery": 42}


def test_upload_survives_progress_count_failure(client, upload_env, monkeypatch):
    """A duckdb-service hiccup on /progress_count must not fail the upload."""
    import services.duckdb as duckdb_svc_mod
    from requests import ConnectionError as RequestsConnectionError

    def boom_get(url, **kwargs):
        raise RequestsConnectionError("duckdb-service down")

    monkeypatch.setattr(duckdb_svc_mod.requests, "get", boom_get)

    resp = client.post(
        "/upload",
        data=_make_form(filename="survives.jpg"),
        content_type="multipart/form-data",
    )
    # Upload still succeeds even though progress_count blew up.
    assert resp.status_code == 200
    # And no Discord (we couldn't determine first-upload status).
    assert upload_env["discord"] == []


def test_upload_survives_record_image_failure(client, upload_env, monkeypatch, capsys):
    """A duckdb-service hiccup on /record_image must not fail the upload, and
    the failure MUST be logged so the on-call can see an orphaned file."""
    import services.duckdb as duckdb_svc_mod
    from requests import ConnectionError as RequestsConnectionError

    posts = upload_env["duckdb_posts"]

    def selective_post(url, json=None, **kwargs):
        posts.append({"url": url, "json": json, "kwargs": kwargs})
        if url.endswith("/record_image"):
            raise RequestsConnectionError("record_image boom")

        class _R:
            status_code = 200

            def json(self_inner):
                return {"ok": True}

            def raise_for_status(self_inner):
                return None

        return _R()

    monkeypatch.setattr(duckdb_svc_mod.requests, "post", selective_post)

    resp = client.post(
        "/upload",
        data=_make_form(filename="orphan.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    captured = capsys.readouterr()
    assert "[record_image]" in captured.out
    assert "orphan.jpg" in captured.out


def test_upload_survives_heartbeat_failure(client, upload_env, monkeypatch):
    """A duckdb-service hiccup on /heartbeat must not fail the upload."""
    import services.duckdb as duckdb_svc_mod
    from requests import ConnectionError as RequestsConnectionError

    posts = upload_env["duckdb_posts"]

    def selective_post(url, json=None, **kwargs):
        posts.append({"url": url, "json": json, "kwargs": kwargs})
        if url.endswith("/heartbeat"):
            raise RequestsConnectionError("heartbeat boom")

        class _R:
            status_code = 200

            def json(self_inner):
                return {"ok": True}

            def raise_for_status(self_inner):
                return None

        return _R()

    monkeypatch.setattr(duckdb_svc_mod.requests, "post", selective_post)

    resp = client.post(
        "/upload",
        data=_make_form(filename="hb-fail.jpg"),
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200


# ---------------- size cap + rate guard (2026-07 audit, for #203) ----------------


def test_upload_oversize_body_returns_413_and_persists_nothing(
    app, client, tmp_upload_dir: Path, upload_env
):
    app.app.config["MAX_CONTENT_LENGTH"] = 1024  # shrink for the test
    form = _make_form(include_image=False)
    form["image"] = (io.BytesIO(b"X" * 4096), "big.jpg")
    resp = client.post(
        "/upload",
        data=form,
        content_type="multipart/form-data",
    )
    assert resp.status_code == 413
    assert resp.get_json()["error"] == "Request body too large"
    assert list(tmp_upload_dir.glob("*.jpg")) == [], "nothing may be persisted"


def test_upload_over_throttle_discards_with_200(
    app, client, tmp_upload_dir: Path, upload_env
):
    """Accept-and-discard, deliberately NOT 429: a non-2xx would count
    toward the firmware's 5-failure circuit breaker (client.cpp) and
    reboot a storming module, making the storm worse."""
    app.upload_throttle.max_per_window = 1

    first = client.post(
        "/upload", data=_make_form(), content_type="multipart/form-data"
    )
    assert first.status_code == 200
    persisted_after_first = sorted(p.name for p in tmp_upload_dir.glob("*"))

    second = client.post(
        "/upload", data=_make_form(), content_type="multipart/form-data"
    )
    assert second.status_code == 200
    assert second.get_json()["message"] == "Upload rate exceeded — discarded"
    assert sorted(p.name for p in tmp_upload_dir.glob("*")) == persisted_after_first, (
        "a discarded upload must not persist anything"
    )


def test_upload_throttle_is_per_mac(app, client, tmp_upload_dir: Path, upload_env):
    app.upload_throttle.max_per_window = 1
    assert (
        client.post(
            "/upload", data=_make_form(), content_type="multipart/form-data"
        ).status_code
        == 200
    )
    other = client.post(
        "/upload",
        data=_make_form(mac="ccddeeff0011"),
        content_type="multipart/form-data",
    )
    assert other.status_code == 200
    assert (
        "message" not in (other.get_json() or {})
        or other.get_json().get("message") != "Upload rate exceeded — discarded"
    )

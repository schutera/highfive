"""Tests for DELETE /images/<filename> (issue #30 — atomicity gaps)."""

from __future__ import annotations

from pathlib import Path

import pytest


class _Resp:
    """Minimal stand-in for ``requests.Response``."""

    def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


@pytest.fixture
def installed_image(tmp_upload_dir: Path) -> Path:
    """Materialise a fake image file at the upload path."""
    target = tmp_upload_dir / "img-001.jpg"
    target.write_bytes(b"\x89PNG\r\n\x1a\n")
    return target


def _patch_duckdb_delete(app_module, monkeypatch, response: _Resp | Exception):
    """Wire app.http_requests.delete to return ``response`` (or raise it)."""
    calls: list[dict] = []

    def fake_delete(url, **kwargs):
        calls.append({"url": url, "kwargs": kwargs})
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(app_module.http_requests, "delete", fake_delete)
    return calls


# --------------------------- 2xx path ---------------------------


def test_delete_2xx_removes_file_and_returns_200(
    app, client, installed_image, monkeypatch
):
    _patch_duckdb_delete(
        app, monkeypatch, _Resp(200, {"message": "Image record deleted"})
    )

    resp = client.delete(f"/images/{installed_image.name}")

    assert resp.status_code == 200
    assert resp.get_json() == {"message": "Image deleted"}
    assert not installed_image.exists(), "file should have been removed after 2xx"


# --------------------------- 404 path ---------------------------


def test_delete_404_is_idempotent_cleans_orphan_file(
    app, client, installed_image, monkeypatch
):
    """Row already gone → still clean the on-disk file (recovers from a
    previous failed delete that left an orphan)."""
    _patch_duckdb_delete(app, monkeypatch, _Resp(404, {"error": "Image not found"}))

    resp = client.delete(f"/images/{installed_image.name}")

    assert resp.status_code == 404
    assert resp.get_json() == {"error": "Image not found"}
    assert not installed_image.exists(), "404 should still clean up the orphan file"


def test_delete_404_with_no_file_returns_404(app, client, tmp_upload_dir, monkeypatch):
    _patch_duckdb_delete(app, monkeypatch, _Resp(404, {"error": "Image not found"}))

    resp = client.delete("/images/never-existed.jpg")

    assert resp.status_code == 404


# --------------------------- 5xx path (the #30 regression) ---------------------------


def test_delete_5xx_leaves_file_in_place_and_forwards_status(
    app, client, installed_image, monkeypatch, capsys
):
    """The bug from #30: previously the file was removed even when duckdb
    returned 500, leaving an orphaned DB row pointing at nothing. Now we
    forward the upstream status and leave the file."""
    _patch_duckdb_delete(
        app,
        monkeypatch,
        _Resp(500, {"error": "duckdb broke"}, text='{"error": "duckdb broke"}'),
    )

    resp = client.delete(f"/images/{installed_image.name}")

    assert resp.status_code == 500
    assert installed_image.exists(), "file MUST remain when duckdb returned 5xx"
    body = resp.get_json()
    assert "duckdb-service returned 500" in body["error"]
    # And the failure must be logged for on-call debugging.
    captured = capsys.readouterr().out
    assert "[delete_image]" in captured
    assert "500" in captured


def test_delete_503_also_leaves_file_in_place(
    app, client, installed_image, monkeypatch
):
    _patch_duckdb_delete(app, monkeypatch, _Resp(503, {"error": "unavailable"}, text="x"))

    resp = client.delete(f"/images/{installed_image.name}")

    assert resp.status_code == 503
    assert installed_image.exists()


# --------------------------- network exception path ---------------------------


def test_delete_network_exception_returns_502_and_leaves_file(
    app, client, installed_image, monkeypatch, capsys
):
    """A connection timeout must NOT remove the file (previous bug: it did)."""
    import requests

    _patch_duckdb_delete(app, monkeypatch, requests.Timeout("connect timeout"))

    resp = client.delete(f"/images/{installed_image.name}")

    assert resp.status_code == 502
    assert installed_image.exists(), "network failure must not orphan the file"
    body = resp.get_json()
    assert body["error"] == "duckdb-service unreachable"
    captured = capsys.readouterr().out
    assert "[delete_image] duckdb-service unreachable" in captured
    assert "connect timeout" in captured

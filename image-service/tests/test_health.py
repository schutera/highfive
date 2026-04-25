"""Tests for GET /health."""

from __future__ import annotations


def test_health_returns_200_and_expected_body(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True, "service": "image-service"}


def test_health_is_get_only(client):
    resp = client.post("/health")
    # Flask returns 405 Method Not Allowed for unsupported verbs.
    assert resp.status_code == 405

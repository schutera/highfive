"""Pytest fixtures for image-service tests.

Sets IMAGE_STORE_PATH env var to a per-test temp path BEFORE importing app,
then mocks the outbound HTTP calls to duckdb-service (POST + GET) and the
Discord webhook so tests run hermetically.
"""

from __future__ import annotations

import os
import sys
import importlib
from pathlib import Path

import pytest


# Make the image-service package root importable when pytest is launched
# from inside image-service/ (so `import app` and `from services...` work).
SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


@pytest.fixture
def tmp_upload_dir(tmp_path: Path) -> Path:
    """Per-test upload directory."""
    d = tmp_path / "images"
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def app(tmp_upload_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """Import (or reload) the Flask app with env vars pointing at tmp dirs.

    app.py reads IMAGE_STORE_PATH at import time and calls os.makedirs on it,
    so the env var must be set before the (re)import. We reload the module on
    every test to guarantee UPLOAD_FOLDER points at this test's tmp dir.
    """
    monkeypatch.setenv("IMAGE_STORE_PATH", str(tmp_upload_dir))
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "")  # disable real webhook

    # Force a fresh import so module-level globals see the env vars.
    if "app" in sys.modules:
        del sys.modules["app"]
    app_module = importlib.import_module("app")

    app_module.app.config.update(TESTING=True)
    return app_module


@pytest.fixture
def client(app):
    """Flask test client bound to the freshly-imported app."""
    return app.app.test_client()


@pytest.fixture
def mocked_duckdb_http(app, monkeypatch: pytest.MonkeyPatch):
    """Capture all outbound HTTP traffic to duckdb-service.

    Patches `requests.post` (used by /add_progress_for_module and
    /modules/<id>/heartbeat) and `requests.get` (used by
    /modules/<id>/progress_count). All outbound calls now route through
    `services.duckdb.DuckDBService`, so we patch the requests binding in
    that module.

    Returns a dict with:
        - "posts": list of {"url", "json", "kwargs"}
        - "gets":  list of {"url", "kwargs"}
        - "progress_count": int returned by GET /progress_count (mutable)
        - "heartbeat_status": int returned by POST /heartbeat (mutable)
    """
    state = {
        "posts": [],
        "gets": [],
        "progress_count": 0,
        "heartbeat_status": 200,
    }

    class _Resp:
        def __init__(self, status_code: int = 200, payload: dict | None = None):
            self.status_code = status_code
            self._payload = payload or {"ok": True}

        def json(self):
            return self._payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

    def fake_post(url, json=None, **kwargs):
        state["posts"].append({"url": url, "json": json, "kwargs": kwargs})
        if url.endswith("/heartbeat"):
            return _Resp(state["heartbeat_status"], {"ok": True} if state["heartbeat_status"] < 400 else {"error": "x"})
        # /add_progress_for_module and any other POST
        return _Resp(200, {"ok": True})

    def fake_get(url, **kwargs):
        state["gets"].append({"url": url, "kwargs": kwargs})
        if url.endswith("/progress_count"):
            return _Resp(200, {"count": state["progress_count"]})
        return _Resp(200, {"ok": True})

    # All outbound HTTP from image-service now routes through
    # services.duckdb.DuckDBService, so we only need to patch its `requests`.
    import services.duckdb as duckdb_svc_mod
    monkeypatch.setattr(duckdb_svc_mod.requests, "post", fake_post)
    monkeypatch.setattr(duckdb_svc_mod.requests, "get", fake_get)
    return state


@pytest.fixture
def no_op_discord(app, monkeypatch: pytest.MonkeyPatch):
    """Replace send_discord_message with a no-op that records calls."""
    sent: list[str] = []

    def fake_send(content: str):
        sent.append(content)

    # app.py imports send_discord_message into its own namespace.
    monkeypatch.setattr(app, "send_discord_message", fake_send)
    return sent


@pytest.fixture
def upload_env(mocked_duckdb_http, no_op_discord):
    """Composite fixture wiring all upload-path mocks for convenience."""
    return {
        "duckdb_http": mocked_duckdb_http,
        "duckdb_posts": mocked_duckdb_http["posts"],
        "duckdb_gets": mocked_duckdb_http["gets"],
        "discord": no_op_discord,
    }

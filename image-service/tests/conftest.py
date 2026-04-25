"""Pytest fixtures for image-service tests.

Sets IMAGE_STORE_PATH and DUCKDB_PATH env vars to per-test temp paths
BEFORE importing app, then mocks the outbound HTTP call to duckdb-service,
the direct duckdb.connect calls (update_module + first-upload count query),
and the Discord webhook so tests run hermetically.
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
def tmp_duckdb_path(tmp_path: Path) -> Path:
    """Per-test DuckDB file path (file is never actually created — duckdb is mocked)."""
    return tmp_path / "app.duckdb"


@pytest.fixture
def app(tmp_upload_dir: Path, tmp_duckdb_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Import (or reload) the Flask app with env vars pointing at tmp dirs.

    app.py reads IMAGE_STORE_PATH at import time and calls os.makedirs on it,
    so the env var must be set before the (re)import. We reload the module on
    every test to guarantee UPLOAD_FOLDER points at this test's tmp dir.
    """
    monkeypatch.setenv("IMAGE_STORE_PATH", str(tmp_upload_dir))
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_duckdb_path))
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
def mocked_duckdb_post(app, monkeypatch: pytest.MonkeyPatch):
    """Capture POSTs to the duckdb-service /add_progress_for_module endpoint."""
    calls: list[dict] = []

    class _Resp:
        status_code = 200

        def json(self):
            return {"ok": True}

    def fake_post(url, json=None, **kwargs):
        calls.append({"url": url, "json": json, "kwargs": kwargs})
        return _Resp()

    # app.py does `import requests; requests.post(...)` — patch the binding
    # in the app module's namespace.
    monkeypatch.setattr(app.requests, "post", fake_post)
    return calls


@pytest.fixture
def mocked_duckdb_connect(app, monkeypatch: pytest.MonkeyPatch):
    """Mock duckdb.connect used by update_module + first-upload count query.

    Returns a list of executed (sql, params) tuples for assertion if needed.
    """
    executed: list[tuple] = []

    class _FakeCursor:
        def execute(self, sql, params=None):
            executed.append((sql, params))
            return self

        def fetchone(self):
            # First-upload count query expects a tuple; default to "no prior rows".
            return (0,)

        def close(self):
            pass

    class _FakeConn:
        def cursor(self):
            return _FakeCursor()

        def execute(self, sql, params=None):
            return _FakeCursor().execute(sql, params)

        def commit(self):
            pass

        def close(self):
            pass

    def fake_connect(path, *args, **kwargs):
        return _FakeConn()

    monkeypatch.setattr(app.duckdb, "connect", fake_connect)
    return executed


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
def upload_env(mocked_duckdb_post, mocked_duckdb_connect, no_op_discord):
    """Composite fixture wiring all upload-path mocks for convenience."""
    return {
        "duckdb_posts": mocked_duckdb_post,
        "duckdb_sql": mocked_duckdb_connect,
        "discord": no_op_discord,
    }

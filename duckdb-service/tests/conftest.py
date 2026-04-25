"""Pytest fixtures for duckdb-service.

Key challenge: ``db.connection`` reads ``DUCKDB_PATH`` at import time and
``app.py`` calls ``init_db()`` at import time. To get a clean per-test
DuckDB file we:

1. Make sure the duckdb-service directory is on ``sys.path`` so that the
   service modules import the same way they do under ``flask run``.
2. Set ``DUCKDB_PATH`` (and clear ``SEED_DATA``) on a fresh tmp file
   *before* importing or reloading any service module.
3. ``importlib.reload`` ``db.connection`` so its ``DB_PATH`` module-level
   constant picks up the new env value, then reload every module that
   captured ``DB_PATH``/``get_conn`` at import time (``db.schema``,
   ``routes.health``, ``routes.modules``, ``routes.nests``,
   ``routes.progress``, and finally ``app``).
4. Patch out ``services.discord.send_discord_message`` (and the version
   already imported into ``routes.modules``) to a no-op spy so tests
   never hit the network.
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

import pytest

# Make duckdb-service the root for imports (mirrors how the Flask app runs).
SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


def _purge_service_modules() -> None:
    """Drop cached service modules so the next import re-reads env vars."""
    for name in [
        "app",
        "routes.progress",
        "routes.nests",
        "routes.modules",
        "routes.health",
        "routes",
        "services.discord",
        "services",
        "db.schema",
        "db.connection",
        "db",
        "models.module",
        "models.progress",
        "models",
    ]:
        sys.modules.pop(name, None)


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    """Per-test fresh DuckDB file + freshly imported service modules.

    Returns a ``types.SimpleNamespace`` with handles to the reloaded
    modules and the spy list capturing Discord messages.
    """
    db_file = tmp_path / "test.duckdb"
    monkeypatch.setenv("DUCKDB_PATH", str(db_file))
    monkeypatch.delenv("SEED_DATA", raising=False)
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)

    _purge_service_modules()

    # Import in dependency order so each module captures the new env.
    connection = importlib.import_module("db.connection")
    schema = importlib.import_module("db.schema")
    discord = importlib.import_module("services.discord")

    # Replace the discord webhook with a spy BEFORE routes.modules imports
    # ``send_discord_message`` from it.
    discord_calls: list[str] = []

    def _fake_send(content: str) -> None:
        discord_calls.append(content)

    monkeypatch.setattr(discord, "send_discord_message", _fake_send)

    # Now import route modules (they do ``from services.discord import
    # send_discord_message`` so we must also patch the bound name there).
    routes_modules = importlib.import_module("routes.modules")
    monkeypatch.setattr(routes_modules, "send_discord_message", _fake_send)
    importlib.import_module("routes.health")
    importlib.import_module("routes.nests")
    importlib.import_module("routes.progress")

    # init_db on the fresh file.
    schema.init_db()

    import types

    ns = types.SimpleNamespace(
        db_path=str(db_file),
        connection=connection,
        schema=schema,
        discord=discord,
        discord_calls=discord_calls,
    )
    return ns


@pytest.fixture
def app(fresh_db):
    """Flask app bound to the fresh DB."""
    app_module = importlib.import_module("app")
    app_module.app.config.update(TESTING=True)
    return app_module.app


@pytest.fixture
def client(app):
    return app.test_client()

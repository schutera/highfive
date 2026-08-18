"""Discord notifier credential handling (2026-07 audit, for #201).

The webhook URL is a bearer credential. There must be no baked-in
default, and an empty URL must mean "notifications disabled" — a clean
skip with zero HTTP attempts, never an exception on a caller's path
(registration, first image, silence watcher all call through here).
"""

from __future__ import annotations

import sys

import services.discord as discord


def _forbid_http(monkeypatch):
    def _fail(*args, **kwargs):  # pragma: no cover - only fires on regression
        raise AssertionError("HTTP attempted with empty DISCORD_WEBHOOK_URL")

    monkeypatch.setattr(discord.requests, "post", _fail)


def test_default_is_empty_when_env_unset(monkeypatch):
    # Fresh import (not reload): the shared conftest purges service modules
    # between tests, and reload on a purged module object raises ImportError.
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    sys.modules.pop("services.discord", None)
    import services.discord as fresh

    assert fresh.DISCORD_WEBHOOK_URL == ""


def test_send_message_skips_http_when_unset(monkeypatch):
    monkeypatch.setattr(discord, "DISCORD_WEBHOOK_URL", "")
    _forbid_http(monkeypatch)
    discord.send_discord_message("module registered")  # must not raise


def test_send_file_skips_http_when_unset(tmp_path, monkeypatch):
    monkeypatch.setattr(discord, "DISCORD_WEBHOOK_URL", "")
    _forbid_http(monkeypatch)
    sample = tmp_path / "capture.jpg"
    sample.write_bytes(b"\xff\xd8\xff\xd9")
    assert discord.send_discord_file(str(sample), "first image") is False

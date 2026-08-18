"""Discord notifier credential handling (2026-07 audit, for #201).

Twin of duckdb-service/tests/test_discord.py — image-service carries its
own copy of the notifier module, and it shipped the same committed
webhook default. Empty URL must mean "disabled": no HTTP attempt, no
exception on the upload path that calls it.
"""

from __future__ import annotations

import importlib

import services.discord as discord


def test_default_is_empty_when_env_unset(monkeypatch):
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    reloaded = importlib.reload(discord)
    assert reloaded.DISCORD_WEBHOOK_URL == ""


def test_send_message_skips_http_when_unset(monkeypatch):
    monkeypatch.setattr(discord, "DISCORD_WEBHOOK_URL", "")

    def _fail(*args, **kwargs):  # pragma: no cover - only fires on regression
        raise AssertionError("HTTP attempted with empty DISCORD_WEBHOOK_URL")

    monkeypatch.setattr(discord.requests, "post", _fail)
    discord.send_discord_message("first image for module")  # must not raise

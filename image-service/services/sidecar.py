"""Typed envelope for the on-disk `.log.json` sidecar.

The sidecar is written next to each uploaded image by /upload and read back
by /modules/<mac>/logs. Historically it was a flat dict that mixed
service-injected metadata (`_mac`, `_received_at`, `_image`) with the raw
ESP telemetry payload at the top level. That made the contract between
producer and consumer an untyped string-keyed bag.

This module defines a Pydantic model so the producer and consumer share a
single schema. The new on-disk shape nests the ESP telemetry under
`payload`:

    {
        "mac": "...",
        "received_at": "...",
        "image": "...",
        "payload": {...}        # original ESP telemetry, possibly with
                                # parse_error/raw on malformed input
    }

`get_module_logs` retains read-only backward compatibility with the legacy
flat schema (see `from_disk` below) so existing volumes keep working
during the transition.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class LogSidecarEnvelope(BaseModel):
    """Typed envelope persisted as `<image>.log.json`."""

    mac: str
    received_at: str = Field(
        description="ISO-8601 timestamp (seconds precision) when the upload was received."
    )
    image: str = Field(description="Original uploaded image filename.")
    payload: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Original ESP telemetry. On malformed input, contains "
            "{'parse_error': True, 'raw': <str>} instead of parsed fields."
        ),
    )

    def to_json_string(self) -> str:
        """Serialize to a single JSON object string."""
        return self.model_dump_json()

    @staticmethod
    def now_iso() -> str:
        """Helper so callers don't reach for datetime themselves."""
        return datetime.now().isoformat(timespec="seconds")

    @classmethod
    def from_disk(cls, data: dict[str, Any]) -> LogSidecarEnvelope | None:
        """Build an envelope from a sidecar dict, supporting both formats.

        New format: {"mac": ..., "received_at": ..., "image": ..., "payload": {...}}
        Legacy format (read-only compat): flat dict with `_mac`, `_received_at`,
        `_image`, plus arbitrary other ESP telemetry keys at the top level.

        Returns None if the dict has neither shape (e.g. corrupt file).
        """
        if not isinstance(data, dict):
            return None

        # New format: presence of nested `payload` (or just `mac` at top level
        # without the `_mac` legacy key).
        if "mac" in data and "_mac" not in data:
            try:
                return cls.model_validate(data)
            except Exception:
                return None

        # Legacy format: flat dict with underscore-prefixed metadata.
        if "_mac" in data:
            mac = str(data.get("_mac", ""))
            received_at = str(data.get("_received_at", ""))
            image = str(data.get("_image", ""))
            payload = {
                k: v
                for k, v in data.items()
                if k not in ("_mac", "_received_at", "_image")
            }
            return cls(mac=mac, received_at=received_at, image=image, payload=payload)

        return None

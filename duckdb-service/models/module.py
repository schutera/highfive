from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from models.geo import coarsen_coord
from models.module_id import ModuleId


class ModuleData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # Inbound payloads call this field ``esp_id``; the canonical name is
    # ``mac``. The value is canonicalised via ``ModuleId`` regardless of
    # which alias was used, so downstream code always sees the
    # 12-hex-char form.
    mac: ModuleId = Field(validation_alias="esp_id")
    # Cap at 100 chars to match `module_configs.name VARCHAR(100)` and
    # the dashboard's truncate-on-overflow CSS. DuckDB does NOT actually
    # enforce VARCHAR(N) lengths (verified by direct insert), so this
    # is the only place that bounds the value at the front door. Round-2
    # senior-review nit on PR-I: previously the truncation only fired
    # in the collision path of `_resolve_unique_firmware_name`, so a
    # non-colliding 200-char name still reached the DB. Moving it
    # here makes the cap unconditional.
    module_name: str = Field(max_length=100)
    # Range constraints mirror `hf::isPlausibleFix` (firmware) and
    # `heartbeats.py::_is_plausible_fix` (server) — defence in depth at
    # the registration entry point. The (0,0) sentinel is NOT rejected
    # here: a module that fails its boot-time geolocation retry still
    # needs to register so it appears in the operator UI with a
    # "Location pending" pill; the heartbeat-side recovery path patches
    # the lat/lng once a fix lands. Out-of-range values (lat>90,
    # lng>180) are a parser glitch and ARE rejected.
    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)
    battery: int = Field(ge=0, le=100, validation_alias="battery_level")
    email: Optional[str] = None

    # Generalize coordinates to ~1 km at the registration front door (issue
    # #145, ADR-020). Runs in ``mode="after"`` so the range constraints above
    # have already validated; this is the single chokepoint for the
    # registration path, so the stored row, the ``add_module`` UPSERT, AND the
    # Discord "Location" message all see the coarsened value — no precise
    # coordinate is persisted or echoed. The ``(0,0)`` sentinel is preserved.
    @field_validator("latitude", "longitude", mode="after")
    @classmethod
    def _coarsen(cls, v: float) -> float:
        return coarsen_coord(v)

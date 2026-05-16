from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

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
    latitude: float
    longitude: float
    battery: int = Field(ge=0, le=100, validation_alias="battery_level")
    email: Optional[str] = None

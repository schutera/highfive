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
    module_name: str
    latitude: float
    longitude: float
    battery: int = Field(ge=0, le=100, validation_alias="battery_level")
    email: Optional[str] = None

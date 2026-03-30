from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class ModuleData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    mac: str = Field(validation_alias="esp_id")
    module_name: str
    latitude: float
    longitude: float
    battery: int = Field(ge=0, le=100, validation_alias="battery_level")
    email: Optional[str] = None

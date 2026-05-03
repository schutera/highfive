from typing import Dict

from pydantic import AliasChoices, BaseModel, Field

from models.module_id import ModuleId


class ClassificationOutput(BaseModel):
    """Inbound classification payload from image-service.

    Accepts both the canonical key ``module_id`` and the legacy typo
    ``modul_id`` via ``AliasChoices`` — this is the deprecation window for
    the historical wire-format misspelling. New code should send
    ``module_id``; the alias will be removed in a future cleanup once all
    producers have been updated.
    """

    module_id: ModuleId = Field(
        validation_alias=AliasChoices("module_id", "modul_id"),
    )
    classification: Dict[str, Dict[int, float]]


BEE_TYPE_MAP = {
    "black_masked_bee": "blackmasked",
    "leafcutter_bee": "leafcutter",
    "orchard_bee": "orchard",
    "resin_bee": "resin",
}

TARGET_NESTS_PER_TYPE = 4

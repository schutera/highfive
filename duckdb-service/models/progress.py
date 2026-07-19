from typing import Dict

from pydantic import BaseModel

from models.module_id import ModuleId


class ClassificationOutput(BaseModel):
    """Inbound classification payload from image-service.

    Only the canonical key ``module_id`` is accepted. The legacy typo
    ``modul_id`` (missing "e") was tolerated as a Pydantic
    ``AliasChoices`` deprecation window until the 2026-07 audit verified
    no emitter remained (for #207); a payload using the typo now fails
    validation → clean 400. Do not reintroduce the alias — see
    chapter 11 "Field-name drift".
    """

    module_id: ModuleId
    classification: Dict[str, Dict[int, float]]


BEE_TYPE_MAP = {
    "black_masked_bee": "blackmasked",
    "leafcutter_bee": "leafcutter",
    "orchard_bee": "orchard",
    "resin_bee": "resin",
}

TARGET_NESTS_PER_TYPE = 4

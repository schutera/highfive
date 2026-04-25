from typing import Dict
from pydantic import BaseModel


class ClassificationOutput(BaseModel):
    modul_id: str
    classification: Dict[str, Dict[int, float]]


BEE_TYPE_MAP = {
    "black_masked_bee": "blackmasked",
    "leafcutter_bee": "leafcutter",
    "orchard_bee": "orchard",
    "resin_bee": "resin",
}

TARGET_NESTS_PER_TYPE = 4

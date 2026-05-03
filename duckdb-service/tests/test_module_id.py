"""Unit tests for the ``ModuleId`` Pydantic root model.

Covers canonicalization (uppercase, colons, dashes, mixed/whitespace) and
the rejection of malformed input (wrong length, non-hex, empty, None,
non-string types).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from models.module_id import ModuleId


# ---------------- canonicalization ----------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("AA:BB:CC:DD:EE:FF", "aabbccddeeff"),
        ("aa-bb-cc-dd-ee-ff", "aabbccddeeff"),
        ("AABBCCDDEEFF", "aabbccddeeff"),
        ("aabbccddeeff", "aabbccddeeff"),
        ("  AA:BB:CC:DD:EE:FF  ", "aabbccddeeff"),
        ("Aa:bB:Cc:dD:Ee:fF", "aabbccddeeff"),
    ],
)
def test_module_id_canonicalises(raw: str, expected: str) -> None:
    mid = ModuleId.model_validate(raw)
    assert mid.root == expected
    assert str(mid) == expected


# ---------------- rejection ----------------


@pytest.mark.parametrize(
    "raw",
    [
        "",  # empty
        "abc",  # too short
        "aabbccddeeff00",  # too long
        "ZZ:BB:CC:DD:EE:FF",  # non-hex char
        "hive-001",  # legacy seed shape, non-hex chars
        "test-mac-aabbccddeeff",  # mock harness shape
        "12345",  # numeric but wrong length
        "aabbccddeefg",  # 'g' is non-hex
    ],
)
def test_module_id_rejects_invalid_strings(raw: str) -> None:
    with pytest.raises(ValidationError):
        ModuleId.model_validate(raw)


def test_module_id_rejects_none() -> None:
    with pytest.raises(ValidationError):
        ModuleId.model_validate(None)


def test_module_id_rejects_non_string() -> None:
    with pytest.raises(ValidationError):
        ModuleId.model_validate(12345)


# ---------------- ClassificationOutput dual-name acceptance ----------------


def test_classification_output_accepts_module_id() -> None:
    """Canonical field name ``module_id`` must work."""
    from models.progress import ClassificationOutput

    out = ClassificationOutput.model_validate(
        {
            "module_id": "AA:BB:CC:DD:EE:FF",
            "classification": {"leafcutter_bee": {"0": 0.5}},
        }
    )
    assert out.module_id.root == "aabbccddeeff"


def test_classification_output_accepts_legacy_modul_id_typo() -> None:
    """Legacy field name ``modul_id`` must still work via ``AliasChoices``."""
    from models.progress import ClassificationOutput

    out = ClassificationOutput.model_validate(
        {
            "modul_id": "aabbccddeeff",
            "classification": {"leafcutter_bee": {"0": 0.5}},
        }
    )
    assert out.module_id.root == "aabbccddeeff"

"""Unit tests for the ``ModuleId`` Pydantic root model.

Mirrors ``duckdb-service/tests/test_module_id.py`` — the two services
ship identical implementations so we test both copies independently.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from services.module_id import ModuleId

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

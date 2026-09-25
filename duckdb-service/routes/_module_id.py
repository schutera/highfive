"""Shared inbound module-id normalisation for duckdb-service routes (for #246).

``_canonicalize_or_400`` lived as two identical private copies in
``routes/modules.py`` and ``routes/detections.py``; ``routes/heartbeats.py``
needed a third. One copy here, imported by all three — a fourth inline
copy is how the next malformed-id inconsistency ships.
"""

from flask import jsonify
from models.module_id import ModuleId
from pydantic import ValidationError


def _canonicalize_or_400(raw: str):
    """Normalise an inbound module-id URL param via ``ModuleId``.

    Returns the canonical 12-hex string on success, or a Flask ``(json,
    status)`` tuple on failure that the route can return verbatim.

    Pydantic v2 ``ValidationError.errors()`` includes a ``ctx`` field
    containing the underlying ``ValueError`` instance, which is not JSON
    serialisable. We strip that out before returning.
    """
    try:
        return ModuleId.model_validate(raw).root, None
    except ValidationError as e:
        cleaned = [
            {
                "msg": err.get("msg"),
                "type": err.get("type"),
                "loc": list(err.get("loc", [])),
            }
            for err in e.errors()
        ]
        return None, (
            jsonify({"error": "invalid module id", "detail": cleaned}),
            400,
        )

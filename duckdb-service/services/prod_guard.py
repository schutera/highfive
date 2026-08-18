"""Production boot guard for the admin-key fallback (2026-07 audit, #204).

`backend/src/auth.ts` refuses to boot in production when
`HIGHFIVE_API_KEY` is unset or is the public dev fallback — the Flask
services fell back silently, so their `/logs` gates could ship guarded
by a key printed in every fork's docs. This mirrors the backend guard's
exact edge cases (whitespace-only counts as unset; the dev fallback is
refused case-insensitively).

Production is signalled by `HIGHFIVE_ENV=production` — there is no
`NODE_ENV` here, and modern Flask dropped `FLASK_ENV`. The marker is
set in `docker-compose.prod.yml`; a PM2/bare-metal host must set it in
the server-side process config (see auth.md → "The secret").

Twin module: `image-service/services/prod_guard.py` (kept in sync the
same way the two `log_ring.py` copies are).
"""

from __future__ import annotations

import os

_DEV_FALLBACK_KEY = "hf_dev_key_2026"
_DOCS = "docs/08-crosscutting-concepts/auth.md"


def require_prod_key(environ=os.environ) -> None:
    """Raise ``RuntimeError`` iff production is declared but the admin key
    is unset, blank, or (case-insensitively) the public dev fallback.

    A no-op outside production: the dev fallback stays byte-identical.
    """
    env = (environ.get("HIGHFIVE_ENV") or "").strip().lower()
    if env != "production":
        return
    key = (environ.get("HIGHFIVE_API_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "HIGHFIVE_ENV=production but HIGHFIVE_API_KEY is unset or blank. "
            f"Refusing to boot with the public dev fallback as the admin "
            f"gate — set a real key (see {_DOCS})."
        )
    if key.lower() == _DEV_FALLBACK_KEY:
        raise RuntimeError(
            "HIGHFIVE_ENV=production but HIGHFIVE_API_KEY is the public dev "
            f"fallback '{_DEV_FALLBACK_KEY}' (any casing). Set a real key "
            f"(see {_DOCS})."
        )

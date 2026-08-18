"""Production boot-guard matrix (2026-07 audit, for #204).

Mirrors the edge cases backend/tests pin for auth.ts: blank and
whitespace-only count as unset; the dev fallback is refused in any
casing; dev mode is untouched.
"""

from __future__ import annotations

import pytest

from services.prod_guard import require_prod_key


def _env(**kv):
    return {k: v for k, v in kv.items() if v is not None}


@pytest.mark.parametrize("key", [None, "", "   ", "\t"])
def test_production_refuses_unset_or_blank_key(key):
    with pytest.raises(RuntimeError, match="unset or blank"):
        require_prod_key(_env(HIGHFIVE_ENV="production", HIGHFIVE_API_KEY=key))


@pytest.mark.parametrize(
    "key",
    ["hf_dev_key_2026", "HF_DEV_KEY_2026", "Hf_Dev_Key_2026", "  hf_dev_key_2026  "],
)
def test_production_refuses_dev_fallback_any_casing(key):
    with pytest.raises(RuntimeError, match="dev.*fallback"):
        require_prod_key(_env(HIGHFIVE_ENV="production", HIGHFIVE_API_KEY=key))


def test_production_accepts_real_key():
    require_prod_key(_env(HIGHFIVE_ENV="production", HIGHFIVE_API_KEY="a-real-key"))


@pytest.mark.parametrize("env", [None, "", "development", "Production "])
def test_non_production_is_a_noop_even_with_dev_key(env):
    # "Production " with trailing space IS production after strip — split it out.
    if env == "Production ":
        with pytest.raises(RuntimeError):
            require_prod_key(_env(HIGHFIVE_ENV=env, HIGHFIVE_API_KEY="hf_dev_key_2026"))
        return
    require_prod_key(_env(HIGHFIVE_ENV=env, HIGHFIVE_API_KEY="hf_dev_key_2026"))
    require_prod_key(_env(HIGHFIVE_ENV=env))

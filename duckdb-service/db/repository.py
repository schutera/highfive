"""Thin repository helpers for DuckDB read/write boilerplate.

Centralises the ``with lock: con = get_conn(); ...; con.close()`` lifecycle
that every route used to repeat, plus the dict-zipping of cursor results.

The helpers resolve ``lock`` and ``get_conn`` via the ``db.connection`` module
at *call time* (rather than capturing them at import time). This keeps the
test fixture's ``importlib.reload(db.connection)`` swap working without
needing to also purge ``db.repository`` from ``sys.modules``.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator


def _conn_module():
    # Imported lazily so the test fixture's reload of ``db.connection`` is
    # reflected the next time a helper runs.
    from db import connection as _c

    return _c


def _rows_as_dicts(cur) -> list[dict]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def query_all(sql: str, params: tuple = ()) -> list[dict]:
    """Run a SELECT and return rows as dicts (col -> value)."""
    c = _conn_module()
    with c.lock:
        con = c.get_conn()
        try:
            cur = con.execute(sql, params)
            return _rows_as_dicts(cur)
        finally:
            con.close()


def query_one(sql: str, params: tuple = ()) -> dict | None:
    """Run a SELECT expected to return 0-1 rows; None if empty."""
    c = _conn_module()
    with c.lock:
        con = c.get_conn()
        try:
            cur = con.execute(sql, params)
            cols = [d[0] for d in cur.description]
            row = cur.fetchone()
            return dict(zip(cols, row)) if row is not None else None
        finally:
            con.close()


def query_scalar(sql: str, params: tuple = ()) -> Any:
    """Run a SELECT expected to return one cell. None if no row."""
    c = _conn_module()
    with c.lock:
        con = c.get_conn()
        try:
            row = con.execute(sql, params).fetchone()
            return row[0] if row is not None else None
        finally:
            con.close()


@contextmanager
def write_transaction() -> Iterator[Any]:
    """Acquire lock, open conn, yield it, commit on success / rollback on exception, close.

    Yields the live DuckDB connection so callers can run multiple statements
    in the same transaction (e.g. ``add_progress_for_module`` which inserts
    nests and progress rows together).
    """
    c = _conn_module()
    with c.lock:
        con = c.get_conn()
        try:
            yield con
            con.commit()
        except Exception:
            try:
                con.rollback()
            except Exception:
                # No active transaction (e.g. DDL auto-committed) — nothing to roll back.
                pass
            raise
        finally:
            con.close()

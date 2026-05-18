"""Unit tests for db.repository helpers.

Uses the existing ``fresh_db`` fixture so the helpers run against a real
DuckDB file with the schema initialised.
"""

import importlib


def _seed_module(fresh_db, module_id="hive-001"):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online) "
            "VALUES (?, 'Seed', 47.8, 9.6, '2024-01-01')",
            (module_id,),
        )
        con.commit()
    finally:
        con.close()


def test_query_scalar_returns_none_for_empty_result(fresh_db):
    repo = importlib.import_module("db.repository")
    result = repo.query_scalar(
        "SELECT id FROM module_configs WHERE id = ?", ("missing",)
    )
    assert result is None


def test_query_scalar_returns_value(fresh_db):
    _seed_module(fresh_db, "hive-xyz")
    repo = importlib.import_module("db.repository")
    name = repo.query_scalar(
        "SELECT name FROM module_configs WHERE id = ?", ("hive-xyz",)
    )
    assert name == "Seed"


def test_query_one_returns_none_for_empty(fresh_db):
    repo = importlib.import_module("db.repository")
    assert (
        repo.query_one("SELECT id, name FROM module_configs WHERE id = ?", ("missing",))
        is None
    )


def test_query_all_returns_dicts(fresh_db):
    _seed_module(fresh_db, "hive-a")
    _seed_module(fresh_db, "hive-b")
    repo = importlib.import_module("db.repository")
    rows = repo.query_all("SELECT id, name FROM module_configs ORDER BY id")
    assert rows == [
        {"id": "hive-a", "name": "Seed"},
        {"id": "hive-b", "name": "Seed"},
    ]


def test_write_transaction_commits_on_success(fresh_db):
    repo = importlib.import_module("db.repository")
    with repo.write_transaction() as con:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online) "
            "VALUES ('hive-tx', 'Txn', 47.8, 9.6, '2024-01-01')"
        )
    rows = repo.query_all("SELECT id FROM module_configs WHERE id = ?", ("hive-tx",))
    assert rows == [{"id": "hive-tx"}]


def test_write_transaction_propagates_exception_and_closes(fresh_db):
    """Exceptions inside the block must propagate; the connection must still close."""
    repo = importlib.import_module("db.repository")
    raised = False
    try:
        with repo.write_transaction() as con:
            # Trigger an exception *before* any statement runs so there is
            # nothing to commit. The context manager must still release the
            # lock and close the connection cleanly.
            assert con is not None
            raise RuntimeError("boom")
    except RuntimeError:
        raised = True
    assert raised
    # Lock must have been released — a follow-up read must not hang/block.
    assert repo.query_all("SELECT id FROM module_configs WHERE id = 'nope'") == []


def test_write_transaction_rolls_back_partial_writes(fresh_db):
    """Pins the multi-statement atomicity contract. PR B's senior-review
    caught that the helper was missing an explicit ``BEGIN`` — DuckDB
    defaults to autocommit, so the first INSERT below would have been
    committed before the second INSERT's PK collision raised. The
    rollback in the helper's exception handler would then have failed
    with ``cannot rollback - no transaction is active`` and the stray
    row would have been left in the table.

    After the fix (the helper now issues ``BEGIN`` before yielding),
    the rollback restores the empty state. ``set_display_name``'s
    temp-table-dance (#105) depends on this contract — if the
    re-insert phase ever raises, the helper must roll back the parent
    UPDATE AND the child DELETEs together, restoring the row's
    original state."""
    repo = importlib.import_module("db.repository")

    raised = False
    try:
        with repo.write_transaction() as con:
            con.execute(
                "INSERT INTO module_configs (id, name, lat, lng, first_online) "
                "VALUES ('rollback-test', 'First', 47.8, 9.6, '2024-01-01')"
            )
            # PK collision on second insert — must raise.
            con.execute(
                "INSERT INTO module_configs (id, name, lat, lng, first_online) "
                "VALUES ('rollback-test', 'Second', 47.8, 9.6, '2024-01-01')"
            )
    except Exception:
        raised = True

    assert raised, "PK collision must propagate out of the with-block"
    rows = repo.query_all(
        "SELECT id, name FROM module_configs WHERE id = 'rollback-test'"
    )
    assert rows == [], (
        f"write_transaction must roll back partial writes on exception; "
        f"found stranded row(s): {rows!r}. If this fires, the helper "
        f"likely lost its explicit BEGIN — see PR B chapter-11 entry."
    )

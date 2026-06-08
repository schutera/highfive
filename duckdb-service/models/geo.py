"""Coordinate generalization — privacy control for served/stored locations.

Module coordinates are a privacy/safety concern: the read endpoints went
public in issue #142 / ADR-019, so exact nest locations would otherwise be
readable by anyone (vandalism, disturbance, collection). Every coordinate is
generalized to ``PUBLIC_COORD_DECIMALS`` decimal places (~1.1 km grid cells).

This is the **enforcement boundary**: the duckdb-service rounds on every write
(registration + heartbeat geo-patch) and a one-shot migration coarsens
already-stored rows, so after this layer **no precise coordinate is persisted
anywhere**. The transform is a constant, irreversibly lossy round — it cannot
be statistically averaged back to the true point (unlike re-randomized
per-request jitter) and cannot be reversed even if this code leaks.

Mirrored at four layers — the ESP firmware rounds before reporting
(``hf::roundCoord`` in ``ESP32-CAM/lib/geolocation/``), the backend re-rounds at
the response boundary (``coarsenLocation`` in ``@highfive/contracts``), the SQL
migration below coarsens existing rows, and this module is the server-side
persistence guarantee. What is shared across all four is the **precision
constant** ``PUBLIC_COORD_DECIMALS`` (2 dp) — keep it in sync everywhere. NOT
the tie-break: this module's ``round`` is half-to-even while the other three
round half-away-from-zero, so they diverge only on an exact ``x.xx5`` third
decimal, which a real GPS fix never produces (so live data is identical at every
layer — never compare layers on a contrived half-way value). See ADR-020, #145.
"""

from __future__ import annotations

PUBLIC_COORD_DECIMALS = 2


def coarsen_coord(value: float) -> float:
    """Round one coordinate to ``PUBLIC_COORD_DECIMALS``.

    Preserves the ``(0, 0)`` "no fix yet" sentinel (rounding 0 stays 0), so the
    geo-retention ``CASE`` logic in ``add_module`` and the plausibility checks
    are unaffected. ``round`` is Python's half-to-even (banker's) rounding; the
    other layers round half-away-from-zero (see the module docstring) — the
    difference only shows on an exact ``x.xx5`` input, which a live fix never
    yields, so the generalization is identical for real data.

    Edge case: a *plausible* fix within ~0.005 deg of Null Island (e.g.
    ``0.004, 0.004`` — passes ``isPlausibleFix`` because it is not exactly
    ``(0, 0)``) rounds to ``(0.0, 0.0)`` and so becomes indistinguishable from
    the sentinel, which would then trip the geo-retention guard and the
    "Location pending" filter. The blast radius is open ocean in the Gulf of
    Guinea with no Wi-Fi APs to geolocate against, so it cannot occur for a real
    wild-bee module — not worth guarding in code, but noted so it isn't a
    surprise.
    """
    return round(float(value), PUBLIC_COORD_DECIMALS)

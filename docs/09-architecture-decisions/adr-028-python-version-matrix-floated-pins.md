# ADR-028: Python services CI-tested across 3.10–3.14; native deps floated to `>=` bounds

## Status

Accepted

## Context

The two Python services (`duckdb-service`, `image-service`) were CI-tested on a
single interpreter, Python 3.11, while the production host runs Python 3.10. That
mismatch is invisible until a version-specific API slips through: commit `8938899`
(via #180) added `from datetime import UTC` to `services/log_ring.py` (duplicated in
both services). `datetime.UTC` exists only on 3.11+, and `log_ring.install()` runs at
import time in `app.py`, so deploying `main` to the 3.10 host raised `ImportError`
before either service could serve traffic. #191 fixed the symptom; nothing in CI would
have caught it. We want the pytest lanes to run on the whole supported range — 3.10
(prod floor) through 3.14 (forward ceiling).

The obstacle is wheel availability for the exact-pinned native dependencies. No single
release of `numpy` ships both a cp310 and a cp314 wheel (cp310 ≤ 2.2.6, cp314 ≥ 2.4.0),
and `onnxruntime==1.27.0` has no cp310 wheel at all (cp310 ≤ 1.23.2, cp314 ≥ 1.24). With
`==` pins, a 3.10–3.14 matrix is therefore unsatisfiable. The pattern used elsewhere in
the ecosystem (e.g. `bnsreenu/digitalsreeni-image-annotator`) is to express these deps
as `>=` lower bounds and let pip resolve the newest interpreter-compatible wheel
independently in each matrix cell.

## Decision

CI runs `duckdb-unit` and `image-unit` across `python-version: [3.10, 3.11, 3.12, 3.13,
3.14]` with `fail-fast: false`. The native dependencies whose wheel-support windows
cannot span that range are constrained by a `>=` **lower bound** instead of an exact
`==` pin — `numpy>=2.0.0` and `onnxruntime>=1.23.2` (image-service) and `pydantic>=2.12.5`
(both services, so 3.14 resolves a `pydantic-core` with a cp314 wheel). Everything that
already spans the range stays exact-pinned (`duckdb==1.4.4` ships cp310–cp314;
`opencv-python-headless==4.10.0.84` is abi3; Flask/requests/APScheduler are pure-Python).
The floor of each lower bound is chosen so the oldest interpreter (3.10) still resolves a
real wheel.

## Consequences

- **Closes the prod/CI version gap.** A reintroduced 3.11-only API now fails the
  `duckdb-unit (3.10)` cell at PR time instead of on deploy.
- **Production's resolved dependency set moves.** A fresh install now pulls `numpy` 2.x
  (was 1.26.4) and, on a 3.10 interpreter, `onnxruntime` 1.23.2 (was 1.27.0). image-service
  uses numpy only for basic array math in `services/hole_detection.py`, none of it on the
  numpy-2.0 breaking-change surface, so the bump is low-risk — but it is a real prod change,
  which is why it is recorded here rather than buried in a CI tweak.
- **Reproducibility is slightly looser for the floated deps.** Exact pins guarantee an
  identical install everywhere; a `>=` bound lets the resolved version drift forward as new
  wheels publish. We accept this only for the deps that cannot be single-pinned across the
  matrix, and only those — the rest of the lock surface stays exact. If drift ever bites, the
  fix is to raise the lower bound or add a `<` ceiling, not to re-pin and lose the matrix.
- **No new CI jobs.** The job count stays nine; each pytest job fans into five version cells.

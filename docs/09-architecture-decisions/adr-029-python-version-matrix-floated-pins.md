# ADR-029: Python services CI-tested across 3.10–3.14; native deps floated to `>=` bounds

## Status

Accepted

## Context

The two Python services (`duckdb-service`, `image-service`) were CI-tested on a
single interpreter, Python 3.11. The repo specifies its actual runtime
**inconsistently** — the container path builds and runs `python:3.12-slim` (the only
Dockerfile, reused in `docker-compose.prod.yml`), the deployment-docs prose still says
3.11, and the bare-metal PM2 host that crashed (#180) ran 3.10 — so no single version is
authoritative, and pinning CI to any one of them hides version-specific breakage in
the others. Commit `8938899` (via #180) added `from datetime import UTC` to
`services/log_ring.py` (duplicated in both services). `datetime.UTC` exists only on
3.11+, and `log_ring.install()` runs at import time in `app.py`, so deploying `main`
raised `ImportError` before either service could serve traffic — an ImportError on
that symbol is itself proof the runtime was < 3.11. #191 addressed the symptom;
nothing in CI would have caught it. We want the pytest lanes to run on the whole
plausible range — a conservative **3.10 floor** through a **3.14 forward ceiling** —
rather than betting on one version the repo can't even agree on.

The obstacle is wheel availability for the exact-pinned native dependencies. No single
release of `numpy` ships both a cp310 and a cp314 wheel (cp310 ≤ 2.2.6, cp314 ≥ 2.4.0),
and `onnxruntime==1.27.0` has no cp310 wheel at all (cp310 ≤ 1.23.2, cp314 ≥ 1.24.1). With
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
  which is why it is recorded here rather than buried in a CI tweak. That "low-risk" rests on
  the existing `tests/test_hole_detection.py` inference assertions, which run the real model
  end-to-end once the import succeeds (the new guard test only proves the stack _imports_); the
  box-math behaviour under numpy 2.x is covered there, not assumed.
- **Reproducibility is slightly looser for the floated deps.** Exact pins guarantee an
  identical install everywhere; a `>=` bound lets the resolved version drift forward as new
  wheels publish. We accept this only for the deps that cannot be single-pinned across the
  matrix, and only those — the rest of the lock surface stays exact. If drift ever bites, the
  fix is to raise the lower bound or add a `<` ceiling, not to re-pin and lose the matrix.
- **No new CI jobs.** The job count stays nine; each pytest job fans into five version cells.
- **The ruff floor is image-service-only, by design.** `image-service/pyproject.toml` opts into
  the `UP` (pyupgrade) rule, so its `target-version` must be pinned to `py310` or a local
  `ruff --fix` would rewrite `timezone.utc` back to the 3.11-only `UTC`. `duckdb-service` has no
  ruff config at all, so it runs ruff's default rule set (E/F, no `UP`) and is not exposed to
  that rewrite — no floor needed. Neither service runs ruff in CI; this guards local/editor use.
- **A non-skipping guard backs the float.** `image-service/tests/test_native_runtime.py`
  asserts `hole_detection._RUNTIME_AVAILABLE is True` and never `importorskip`s, so a
  floated wheel that installs-but-won't-import on a cell turns it **red** instead of
  silently skipping the detection tests green — the matrix would otherwise give false
  confidence for exactly the deps it was added to de-risk.
- **This branch folds in #191.** PR #191 makes the identical `UTC` → `timezone.utc`
  swap in both `log_ring.py` copies; this branch carries it too, so the new 3.10 cells
  pass instead of failing on the still-unfixed import. Whichever lands second is a
  no-op / trivial conflict on those lines — the integrator should rebase or close one
  against the other.

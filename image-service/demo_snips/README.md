# Demo nest snips (seed data for #166)

Five **synthetic** per-nest snip crops showing one leafcutter hole progressing
`empty → undetermined → sealed` across June 2026. They exist so the per-nest
time-lapse (#166 phase 3) and its Playwright spec have something to scrub on a
freshly-seeded dev stack — `nest_detections` is **not** populated by real
uploads in CI/dev.

These are **not** real captures and **not** model output. They are drawn by
[`generate.py`](generate.py) (deterministic, `random.seed`-pinned). The matching
`nest_detections` rows are seeded in `duckdb-service/db/schema.py` (module
`000000000002` / Garten 12, `leafcutter`, `nest_index=1`) and reference these
filenames; on startup `image-service/app.py` copies this folder into the shared
`SNIP_FOLDER` when `SEED_DATA=true`. Keep the filenames here in sync with the
seed rows — they are the only contract between the two services.

Regenerate with `python image-service/demo_snips/generate.py` (needs Pillow).

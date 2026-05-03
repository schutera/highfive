# Pull Request

## What changed

<!-- A short summary of the change. Bullet points are fine. -->

## Why

<!-- Motivation / linked issue (e.g. Closes #123). What problem does this solve? -->

## How tested

Mark each suite that was run locally and passed. Leave unchecked if not applicable
(but explain why in a comment).

- [ ] ESP32-CAM native (`pio test -e native`)
- [ ] End-to-end (`pytest tests/e2e`)
- [ ] Backend unit (Node 22 + TS)
- [ ] image-service unit (Python 3.11)
- [ ] duckdb-service unit (Python 3.11)
- [ ] Homepage unit (React 19 + Vite)
- [ ] Manual / hardware-in-the-loop verification (describe below)

<!-- Notes on test environment, fixtures, or manual steps. -->

## Checklist

- [ ] Tests added or updated to cover the change
- [ ] Documentation updated where applicable (README, ARCHITECTURE, service-level docs)
- [ ] No secrets, credentials, or large binaries committed
- [ ] CI is green on this branch
- [ ] Breaking changes called out in the description (API, schema, env vars, hardware)

## Screenshots / logs (optional)

<!-- UI changes, before/after, or relevant log excerpts. -->

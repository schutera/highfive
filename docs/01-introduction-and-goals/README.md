# 1. Introduction and Goals

## What is HiveHive?

HiveHive is an automated wild-bee monitoring pipeline. ESP32-CAM
modules deployed in the field capture images of nesting tubes, a
Python image-service ingests them, and a React dashboard renders nest
activity over time. The whole stack runs from a single
`docker compose up`, on a developer laptop or a self-hosted server.
No cloud account is required.

## Goals

| # | Goal | Why it matters |
|---|------|----------------|
| G1 | **Cheap edge hardware** | A single ESP32-CAM module (€10–20) plus a battery is enough to deploy a node. Researchers and hobbyists can build many. |
| G2 | **Self-hostable, no-cloud** | The full stack runs in Docker Compose against local DuckDB. No vendor account, no API key from a third party. |
| G3 | **Resilient firmware** | A module in a garden can lose Wi-Fi, run on a flaky power supply, or sit in extreme heat. The firmware has independent recovery layers (see [ADR-002](../09-architecture-decisions/adr-002-esp-host-testable-lib.md) and [esp-reliability](../06-runtime-view/esp-reliability.md)). |
| G4 | **Accessible UI for non-developers** | A beekeeper or biologist should see today's activity without learning the schema. The dashboard hides the data model behind an at-a-glance map and per-module panels. |
| G5 | **Contributor-friendly stack** | Five small services (React, Express, two Flasks, Arduino/PlatformIO) with a shared TypeScript contracts package and host-testable C++. New contributors find one service they know and can ship a useful PR. |

## Stakeholders / personas

| Persona | What they need |
|---------|----------------|
| **Field deployer** (hobbyist beekeeper, citizen scientist) | Onboard a module without reading code. Sees the dashboard, knows whether a hive is reporting. See [docs/troubleshooting.md](../troubleshooting.md) and [esp32-onboarding](../../.claude/skills/esp32-onboarding/skill.md). |
| **Researcher** (entomologist, ecologist) | Stable historic data on nesting/hatching counts per species per site over months. Cares about Daily Progress rows in DuckDB and CSV-export potential. |
| **Contributor** (developer) | Clear service boundaries, runnable tests, a place to put new code that's obvious. Cares about [building-block view](../05-building-block-view/README.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md). |
| **Operator** (admin of a deployed instance) | A way to inspect telemetry without exposing it to users. Uses the `?admin=1` flag and admin-key gate (see [auth](../08-crosscutting-concepts/auth.md)). |

## What HiveHive is NOT

- Not a real-time service. The pipeline is best-effort, eventually
  consistent. A few minutes of delay is fine.
- Not multi-tenant. One deployment serves one beekeeper / site.
- Not a generic image-classification platform. The image-service
  classifier is a stub today; MaskRCNN integration is planned but the
  data shape (cell counts per nest per day) is fixed.

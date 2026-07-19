# Roadmap

Active and planned work is tracked via GitHub Issues and Milestones on
[schutera/highfive](https://github.com/schutera/highfive/issues).

## Audit-derived work tracks (2026-07)

A full-repo audit (2026-07) filed a structured backlog as issues
[#201](https://github.com/schutera/highfive/issues/201)–[#221](https://github.com/schutera/highfive/issues/221),
grouped into five tracks. Each issue is self-contained (file/symbol
citations, test plan, doc targets) and sized for a single PR. The
primary track label (issues may carry additional labels) makes each
group roughly filterable; this table is a 2026-07 snapshot — the
issues themselves are authoritative.

| Track                     | Label         | Issues                             | Theme                                                                                                      |
| ------------------------- | ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Security & Data Integrity | `security`    | #201 #202 #203 #204 #205 #206 #207 | Webhook rotation, path containment, write-surface hardening, prod key guards, progress-route robustness     |
| CI & Tooling              | `ci`          | #208 #209 #210 #211                | ESLint + typecheck gates, ruff in CI (+ the missing py310 config), guard-script backstop, Dependabot/audit  |
| Production Ops            | `hardening`   | #212 #213 #214 #215                | WSGI + non-root Dockerfiles, measurements retention, signed-OTA-manifest ADR + implementation               |
| Science Data Product      | `enhancement` | #216 #217 #218 #219                | Real empty/sealed classification, hatch derivation, CSV export, activity/weather chart re-enable            |
| Docs & DX                 | `dx`          | #220 #221 (+ a checklist on #200)  | Project skills (release-firmware, add-endpoint), Python↔TS wire-schema snapshot, docs truth pass            |

Suggested ordering: #201 (secret rotation) first; the CI track early
(it protects every later PR); #214 before #215 and #216 before #217
(explicit dependencies); the rest are independent.

The pre-audit feature chain (#112–#118: ML pipeline, notifications
channel, cell timeline, baselines, anomaly push, hatching prediction,
species ID) remains the product north star — the Science Data Product
track above clears its prerequisites (#216/#217 feed #114/#117).

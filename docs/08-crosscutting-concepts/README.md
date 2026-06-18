# 8. Crosscutting Concepts

Concerns that span multiple services. Don't fit neatly into one
building block, so they live here.

| Topic                                                                                                                     | Document                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Authentication & authorisation** — API key, admin gate, dev fallback, third-party API keys (Geolocation)                | [auth.md](auth.md)                                   |
| **API contracts** — `@highfive/contracts` workspace, field-name drift, mitigations                                        | [api-contracts.md](api-contracts.md)                 |
| **ESP32-CAM hardware notes** — AP credentials, browser, Wi-Fi band, firewall, reconfigure/reset                           | [hardware-notes.md](hardware-notes.md)               |
| **Measurement retention** — when to revisit the "keep forever" default for `measurements` rows                            | [measurement-retention.md](measurement-retention.md) |
| **Feature flags** — the two flavours (homepage build-time `VITE_*` vs backend runtime gate), which to use, how to add one | [feature-flags.md](feature-flags.md)                 |

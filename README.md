<h1 align="center">🙌 HighFive</h1>

<p align="center">
  <img src="docs/_images/highfive-logo.svg" alt="HighFive logo" width="120"/>
</p>

<p align="center">
  <em>An open monitoring pipeline for wild-bee nesting activity.</em>
</p>

<p align="center">
  <a href="https://github.com/schutera/highfive/actions/workflows/tests.yml"><img src="https://github.com/schutera/highfive/actions/workflows/tests.yml/badge.svg" alt="tests" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB?logo=react&logoColor=white" alt="React + Vite" />
  <img src="https://img.shields.io/badge/backend-Node.js%20%2B%20Express-339933?logo=node.js&logoColor=white" alt="Node.js + Express" />
  <img src="https://img.shields.io/badge/services-Python%20%2B%20Flask-3776AB?logo=python&logoColor=white" alt="Python + Flask" />
  <img src="https://img.shields.io/badge/database-DuckDB-FFC107?logoColor=white" alt="DuckDB" />
  <img src="https://img.shields.io/badge/hardware-ESP32--CAM-E7352C?logoColor=white" alt="ESP32-CAM" />
  <img src="https://img.shields.io/badge/deploy-Docker%20Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose" />
</p>

<br>

HighFive captures images of wild-bee hotels with solar-powered ESP32-CAM modules,
analyzes nest activity, and renders the results on an interactive dashboard, map,
and setup wizard. Everything runs locally under Docker Compose.

<p align="center">
  <img src="docs/_images/dashboard.png" alt="HighFive dashboard" width="640"/>
</p>

<br>

## Quick start

```bash
git clone https://github.com/schutera/highfive.git
cd highfive
cp .env.example .env       # then edit if needed
docker compose up --build  # homepage on http://localhost:5173
```

Full setup, ports, and service map: **[Deployment Guide](docs/07-deployment-view/docker-compose.md)**.

<br>

## Where to go next

| If you want to…              | Start here                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| **Contribute**               | [CONTRIBUTING.md](CONTRIBUTING.md) — setup, conventions, branch & test workflow |
| Understand the architecture  | [Architecture (arc42)](docs/05-building-block-view/README.md)                   |
| Flash an ESP32-CAM module    | [ESP Deployment](docs/07-deployment-view/esp-flashing.md)                       |
| Call the API                 | [API Reference](docs/api-reference.md)                                          |
| Fix a setup problem          | [Troubleshooting](docs/troubleshooting.md)                                      |
| See what's planned / changed | [Roadmap](docs/roadmap.md) · [Changelog](CHANGELOG.md)                          |

<br>

## License

HighFive is **source-available, not open source**: free for any **noncommercial**
use under the [PolyForm Noncommercial License 1.0.0](LICENSE). **Commercial use
requires a separate license** — contact <mark.schutera@mailbox.org>.

Contributions are welcome under our [Contributor License Agreement](CLA.md).

<br>

<sub>Built for citizen science. 🐝</sub>

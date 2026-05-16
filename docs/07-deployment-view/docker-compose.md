# Deployment Guide (development)

This guide describes how to run the server-side components of the
HighFive system on a developer laptop using Docker Compose.

For production, see [production-deployment.md](production-deployment.md)
(Docker Compose with `docker-compose.prod.yml` + host-Nginx for the API
subdomain, frontend container handles its own 80/443) or
[production-runbook.md](production-runbook.md) (Nginx + PM2 bare-metal).

The system consists of four services:

- **backend** — Node 20 + Express + TypeScript API
- **homepage** — React 19 + Vite + TypeScript frontend
- **image-service** — Python 3.11 + Flask image ingestion / classification
- **duckdb-service** — Python 3.11 + Flask database service (sole writer of `app.duckdb`)

All services are orchestrated using **Docker Compose** on the shared
bridge network `net`.

<br>

## 1. Requirements

Make sure the following software is installed:

- Docker
- Docker Compose
- Git

Verify installation:

```bash
docker --version
docker compose version
```

## 2. Clone the Repository

```bash
git clone https://github.com/schutera/highfive.git
cd hivehive
```

## 3. Environment Configuration

Create a `.env` file in the root directory.

Example:

```bash
## Debug mode for development
DEBUG=<boolean>

## DuckDB service URL
## (used by the classification backend to connect to the DuckDB service)
## Keep as is then running with docker-compose
DUCKDB_SERVICE_URL="http://duckdb-service:8000"

## Optional: Additional environment variables can be added here as needed
```

The `.env` file is used by the **image service** and the
**DuckDB service**.

## 4. Start the Services

Run the following command in the root directory:

```bash
docker compose up --build
```

Docker will build and start all services defined in the
`docker-compose.yml` file.

## 5. Running Services

After startup the services are available on the following ports:

| Service        | Port   | Description                  |
| -------------- | ------ | ---------------------------- |
| Homepage       | `5173` | React + Vite frontend        |
| Backend API    | `3002` | Express + TS backend         |
| Image Service  | `8000` | Image ingestion and analysis |
| DuckDB Service | `8002` | Database API                 |

The web-interface itself is reachable under: http://localhost:5173

> **Backend port — 3002 by default.** `backend/src/server.ts` reads
> the `PORT` env var through `backend/src/port.ts`'s `resolvePort()`,
> which falls back to `3002` when `PORT` is unset, empty, or
> non-numeric. The dev compose stack maps host `3002 → container 3002`
> and the homepage API client targets `:3002`, so the binding lines
> up with the host map even when nobody touches `PORT`. The backend
> service in `docker-compose.yml` still sets `PORT=3002` explicitly —
> it documents the dev-stack intent and silences the unset-fallback
> warning that `server.ts` emits on `npm run dev` workflows. Removing
> it now is a no-op for the dashboard (default matches), but the
> startup warning will fire — that's the signal to ask whether the
> drop was intentional. The earlier `3001` default plus the original
> incident (host port unbound → silent dashboard breakage) is
> captured in chapter 11's lessons-learned register.

## 6. Persistent Storage

The DuckDB database is stored in the Docker volume:

    duckdb_data

This volume is shared between the **image service** and the
**DuckDB service** to persist the database and images across container restarts.

During development it may be necessary to reset the database, for example
when **primary key conflicts** occur due to previously inserted test data.

To reset the database, the Docker volume must be removed.

```bash
# When already stopped
docker volume rm duckdb_data
```

Alternatively, the containers and volumes can be removed together using:

```bash
docker compose down -v
```

## 7. Stopping the System

To stop all running services:

```bash
docker compose down
```

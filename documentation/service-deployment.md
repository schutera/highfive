# Deployment Guide

This guide describes how to deploy the server-side components of the
HiveHive system using Docker.

The system consists of four services:

- **backend** - Next.js API backend
- **homepage** - Next.js frontend application
- **image-service** - image classification service
- **duckdb-service** - database service

All services are orchestrated using **Docker Compose**.

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

| Service                | Port   | Description                  |
| ---------------------- | ------ | ---------------------------- |
| Homepage               | `5173` | Web frontend                 |
| Backend API            | `3002` | Next.js backend              |
| Image Service          | `8000` | Image ingestion and analysis |
| DuckDB Service         | `8002` | Database API                 |

The web-interface itself is reachable under: http://localhost:5173

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

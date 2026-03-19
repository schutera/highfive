# HighFive Architecture

## 1. System Purpose

HighFive monitors wild-bee nesting activity with camera-enabled edge modules (ESP32-CAM), classifies nesting images, persists progress data in DuckDB, and visualizes module status and nest progress in a web dashboard.

The platform follows a microservice architecture with clear responsibility boundaries between UI, API aggregation, image classification, and persistence.

## 2. Runtime Components

| Component                | Tech                           | Host Port -> Container Port | Responsibility                                                             |
| ------------------------ | ------------------------------ | --------------------------- | -------------------------------------------------------------------------- |
| `homepage`               | React + Vite + TypeScript      | `5173 -> 5173`              | Dashboard UI, map view, module detail UI, setup pages                      |
| `backend`                | Node.js + Express + TypeScript | `3002 -> 3002`              | Authenticated API for frontend, aggregation of module/nest/progress data   |
| `classification-backend` | Python + Flask + OpenCV        | `8000 -> 4444`              | Image upload endpoint, circle detection/classification, progress writeback |
| `duckdb-service`         | Python + Flask + DuckDB        | `8002 -> 8000`              | Persistent storage API (`modules`, `nests`, `progress`)                    |
| `ESP32-CAM`              | C++/Arduino firmware           | n/a (edge device)           | Captures images and uploads to classification endpoint                     |

## 3. Deployment Topology (Docker Compose)

- All services run in one shared Docker bridge network: `net`.
- Persistent DB file is stored in Docker volume `duckdb_data`.
- Shared volume mount for stateful services:
  - `classification-backend` mounts `duckdb_data:/data`
  - `duckdb-service` mounts `duckdb_data:/data`
- Inter-service communication inside Docker uses service DNS names, not `localhost`:
  - `backend` -> `http://duckdb-service:8000`
  - `classification-backend` -> `http://duckdb-service:8000`

## 4. Architecture Diagram

<img src="doc_images/HiveHiveArch.png" width="600">

## 5. Core Data Flows

### 5.1 Dashboard Read Flow

1. Browser loads `homepage`.
2. Frontend calls `backend` (`/api/modules`, `/api/modules/:id`) with `X-API-Key`.
3. `backend` refreshes in-memory view by reading from `duckdb-service` endpoints:
   - `GET /modules`
   - `GET /nests`
   - `GET /progress`
4. `backend` maps/normalizes raw DB payload into frontend DTOs.
5. Frontend renders module map, status, battery and nest progress.

### 5.2 Edge Ingestion + Classification Flow

0. ESP32-CAM captures image on interval.
1. Device uploads form data (`image`, `mac`, `battery`) to `classification-backend /upload`.
2. Classification service runs detection pipeline and sends json Object `duckdb-service /add_progress_for_module`. At the same time it updates the module's battery and last-online Date in the database.
3. The `duckdb-service` endpoint:
   - Validates the module exists
   - transforms the classification result into a progress entry for the current date
   - If the referenced nest does not exist, it creates it
   - Inserts the progress entry with the classification result and timestamp.

   The `backend` reads the updated progress data on the next frontend request, so there is no direct notification mechanism from the `duckdb-service` to the `backend`. This design choice keeps the services decoupled and allows for a simple pull-based data refresh strategy. (here the read flow from the dashboard is described in 5.1)

4. The frontend reflects the updated progress data on the next dashboard load or refresh.

### 5.3 Sequence Diagram (Ingestion)

<img src="doc_images/IngestionHiveHive.png" width="600">

## 9. Fault Tolerance and Operational Notes

- `backend` tries DuckDB health check on startup; if unavailable, it logs a warning and still starts.
- DB persistence survives container recreation via `duckdb_data` volume.
- Classification and persistence are decoupled over HTTP APIs, allowing independent evolution.
- Internal container requests must use Docker service names, not host loopback.

## 10. Known Trade-offs

- Current backend read path refreshes full module/nest/progress snapshots on demand, which is simple but not optimized for high scale.
- Classification currently combines heuristic image processing with fixed geometry assumptions.
- Some write paths currently update DuckDB directly from classification service (fast, but tighter coupling than API-only writes).

## 11. Recommended Next Architecture Steps

1. Route all DB writes through `duckdb-service` for a single persistence boundary.
2. Add asynchronous queue (e.g. Redis stream/RabbitMQ) between upload and classification for burst handling.
3. Add structured observability (central logs + trace IDs across services).
4. Harden secrets handling by removing dev fallback API keys in production builds.
5. Add migration/versioning strategy for DuckDB schema evolution.

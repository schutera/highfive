# highfive

High five or [hive hive] is a project that aims to gain insights into wild bees.

![alt text](assets/668909c7-7b5f-44f9-869e-af19c2efa7bf.png)

## Project Overview

This project consists of hardware modules that monitor wild bee activity and a web-based dashboard for visualizing and analyzing the collected data.

## Next Steps

### Frontend Development

#### Parts List & Assembly Guide Page

- Create a dedicated page on the homepage with a comprehensive parts list
- Include step-by-step assembly guide with images/diagrams
- Add "Buy" button that links to `mailto:` for purchase inquiries

#### Web Installer & Setup Guide

- Launch Web Installer should lead to a complete setup guide page
- Full user flow documentation:
  1. Connecting the ESP32 to the computer
  2. Flashing the firmware via web installer
  3. WiFi configuration and network setup
  4. Backend connection and API configuration
  5. Module placement instructions (south-facing outdoor installation)
- Interactive troubleshooting section

### Backend Development

#### Image Storage & Data Processing

- Implement image upload and storage system for captured bee photos
- Extract and quantify data from images (bee counts, species identification, nest activity)
- Store processed data in database following the current mock database structure
- API endpoints for:
  - Image upload from ESP32 modules
  - Image retrieval and processing status
  - Quantified data queries
- Educated improvements to data schema are welcome based on real-world requirements
- See [ML_ARCHITECTURE.md](ML_ARCHITECTURE.md) for neural network integration details

### Hardware Development

#### Power Management

- **Battery Integration**: Add rechargeable battery to ESP32 module
  - Select appropriate battery capacity for 24/7 operation
  - Implement battery management circuit
  - Add low-power sleep modes for efficiency on ESP
- **Solar Panel Addition**: Enable year-round self-sufficient deployment
  - Size solar panel for continuous operation in outdoor conditions
  - Implement MPPT or basic solar charging circuit
  - Weatherproof enclosure for all components
  - South-facing orientation optimization for maximum solar gain

#### Deployment Specifications

- South-facing installation for optimal solar charging
- Mounting hardware for secure outdoor placement (optional)
- Temperature-resistant components (-20°C to +50°C operation)
- All-year (Winter and Summer deployment)

## Current Status

- ✅ Backend API with Express + TypeScript
- ✅ Mock database with 5 German modules (Weingarten/Ravensburg area)
- ✅ Swagger/OpenAPI documentation
- ✅ Frontend dashboard with React + Leaflet maps
- ✅ Module visualization with privacy protection (1km fuzzing)
- ✅ Real-time status monitoring and battery indicators
- ✅ Comprehensive test suite

## Development

### Backend

```bash
cd backend
npm install
npm run dev        # Development server
```

### Frontend

```bash
cd homepage
npm install
npm run dev        # Development server on port 5173
```

## Deployment (Docker Compose)

This project can be run fully containerized using Docker Compose. All services: frontend, backend, ML/classification backend, and DuckDB persistence are started together and communicate over an internal Docker network.

### Prerequisites

- Docker
- Docker Compose

---

### 1. Create environment file

Create a `.env` file in the project root (next to `docker-compose.yml`):

```env
# Enable debug mode for Flask services
DEBUG=true

# Optional Internal DuckDB service URL (container-to-container)
# IMPORTANT: use the container port (8000), not the host port
DUCKDB_SERVICE_URL=http://duckdb-service:8000

# Optional AWS configuration (classification backend uploads)
# AWS_ENDPOINT=http://...
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
```

### 2. Start all services

```bash
docker compose up --build
```

### 3. Available services

- Service URL Description
- Frontend dashboard http://localhost:5173 React/Vite UI
- Backend API http://localhost:3002 Express API
- API docs http://localhost:3002/api-docs Swagger docs
- Classification backend http://localhost:8000 Flask ML service
- DuckDB http://localhost:8002/ Flask Database service

### 🌐 Networking model

Containers communicate using Docker DNS:

- backend → http://duckdb-service:8000
- classification-backend → http://duckdb-service:8000

Never use localhost for inter-container calls.

### 💽 Persistence

DuckDB data is stored in a Docker volume:

- duckdb_data → /data/app.duckdb

This ensures database persistence across container restarts and rebuilds.

### 4. Stopping services

```bash
docker compose down

To also remove database data:

docker compose down -v
```

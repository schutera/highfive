# HighFive Backend API

Mock backend server for the HighFive bee monitoring system.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Server will run on `http://localhost:3001`

## API Endpoints

### Get All Modules
```
GET /api/modules
```
Returns array of all modules with basic information (location, status, battery).

### Get Module Details
```
GET /api/modules/:id
```
Returns detailed information for a specific module including all nest data.

### Update Module Status
```
PATCH /api/modules/:id/status
Body: { "status": "online" | "offline" }
```
Updates the online/offline status of a module.

### Health Check
```
GET /api/health
```
Returns server health status.

## Mock Data

The database is initialized with 5 modules:
- hive-001: Garden View (online)
- hive-002: Meadow View (offline)
- hive-003: Forest Edge (online)
- hive-004: River Side (online)
- hive-005: Mountain Peak (online)

Each module has 12 nests (3 per bee species) with daily progress data spanning a full year.

# HiveHive API Documentation

This document describes the available API endpoints used by the HiveHive
system. The project consists of multiple services:

| Service                | Port   | Description                  |
| ---------------------- | ------ | ---------------------------- |
| Homepage               | `5173` | Web frontend                 |
| Backend API            | `3002` | Next.js backend              |
| Classification Backend | `8000` | Image classification service |
| DuckDB Service         | `8002` | Database API                 |

The web-interface itself is reachable under: http://localhost:5173

However, the APIs only two relevant services are:

- **Classification Backend** (`http://localhost:8000`)
- **DuckDB Service** (`http://localhost:8002`)

<br>

# 1. DuckDB Service API

Base URL

    http://localhost:8002

The DuckDB service manages persistent storage of modules, nests and
brood progress.

---

## 1.1 Health Check

### Endpoint

    GET /health

### Description

Checks whether the DuckDB service and database file are available.

### Request

    http://localhost:8002/health

### Response

```json
{
  "ok": true,
  "db": "/data/app.duckdb"
}
```

---

## 1.2 Initialize Example Data

### Endpoint

    GET /initial_insert

### Description

Inserts development example data into the database.

### Request

    http://localhost:8002/initial_insert

### Response

```json
{
  "success": true
}
```

---

## 1.3 Register a Hive Module

### Endpoint

    POST /new_module

### Description

Registers a new Hive module in the system.

If a module with the same identifier already exists it will be replaced.

### Request

    http://localhost:8002/new_module

Request Body

```json
{
  "mac": "esp-9081726354",
  "module_name": "Garden-Hive",
  "latitude": 48.52137,
  "longitude": 9.05891,
  "battery": 72
}
```

### Response

```json
{
  "id": "esp-9081726354",
  "message": "Module added successfully"
}
```

---

## 1.4 Get All Modules _[used internally]_

### Endpoint

    GET /modules

### Description

Returns all registered Hive modules.

### Request

    http://localhost:8002/modules

### Response

```json
{
  "modules": [
    {
      "battery_level": 72,
      "first_online": "Wed, 11 Mar 2026 00:00:00 GMT",
      "id": "esp-9081726354",
      "lat": "48.52137",
      "lng": "9.05891",
      "name": "Garden-Hive",
      "status": "online"
    }
  ]
}
```

---

## 1.5 Get All Nests _[used internally]_

### Endpoint

    GET /nests

### Description

Returns all nests stored in the system.

### Request

    http://localhost:8002/nests

### Response

```json
{
  "nests": [
    {
      "nest_id": "nest-028",
      "module_id": "esp-9081726354",
      "beeType": "blackmasked"
    },
    {
      "nest_id": "nest-029",
      "module_id": "esp-9081726354",
      "beeType": "blackmasked"
    },
    {
      "nest_id": "nest-030",
      "module_id": "esp-9081726354",
      "beeType": "blackmasked"
    },
    ...
  ]
}
```

---

## 1.6 Get Progress Data _[used internally]_

### Endpoint

    GET /progress

### Description

Returns stored brood progress entries.

### Request

    http://localhost:8002/progress

### Response

```json
{
    "progress": [
        {
            "date": "Sat, 01 Jun 2024 00:00:00 GMT",
            "empty": 5,
            "hatched": 0,
            "nest_id": "nest-030",
            "progress_id": "prog-001",
            "sealed": 100
        },
        {
            "date": "Sat, 01 Jun 2024 00:00:00 GMT",
            "empty": 3,
            "hatched": 0,
            "nest_id": "nest-029",
            "progress_id": "prog-002",
            "sealed": 0
        },
        ...
    ]
}
```

---

## 1.7 Store Classification Result _[used internally]_

### Endpoint

    POST /add_progress_for_module

### Description

Stores classification results for a specific module.

### Request

    http://localhost:8002/add_progress_for_module

Request Body

```json
{
  "modul_id": "esp-9081726354",
  "classification": {
    "black_masked_bee": {
      "1": 1,
      "2": 1,
      "3": 0
    },
    "orchard_bee": {
      "1": 0,
      "2": 1,
      "3": 1
    }
  }
}
```

### Response

```json
{
  "success": true
}
```

<br>
<br>

# 2. Classification Backend API

Base URL

    http://localhost:8000

The classification backend receives images from Hive modules and
classifies nest cells.

---

## 2.1 Upload Image

### Endpoint

    POST /upload

### Description

Uploads a hive image and performs nest cell classification.

### Request

    http://localhost:8000/upload

Form Data:

Field Type Description

| Field   | Type | Description                     |
| ------- | ---- | ------------------------------- |
| image   | File | Captured hive image             |
| mac     | Text | Module identifier               |
| battery | Text | Battery level between 0 and 100 |

Example Values

    image = hive_image.png
    mac = esp-9081726354
    battery = 67

### Response

```json
{
  "message": "Image hive_image.png uploaded successfully",
  "mac": "esp-9081726354",
  "battery": 67,
  "classification": {
    "black_masked_bee": {
      "1": "filled",
      "2": "filled",
      "3": "unfilled"
    },
    "leafcutter_bee": {
      "1": "filled",
      "2": "unfilled",
      "3": "filled"
    },
    "orchard_bee": {
      "1": "unfilled",
      "2": "unfilled",
      "3": "filled"
    },
    "resin_bee": {
      "1": "filled",
      "2": "filled",
      "3": "filled"
    }
  }
}
```

---

## 2.2 Debug Dashboard

### Endpoint

    GET /debug/dashboard

### Description

Displays the developer dashboard showing the latest processed image and
classification results.

### Request

    http://localhost:8000/debug/dashboard

### Response

HTML dashboard page displaying:

- live image preview
- classification results
- automatic updates

---

## 2.3 Preview Stream _[used internally]_

### Endpoint

    GET /debug/preview

### Description

Shows the most recently processed image frame.

### Request

    http://localhost:8000/debug/preview

### Response

HTML page displaying the latest captured image.

---

## 2.4 Classification Result

### Endpoint

    GET /debug/result

### Description

Returns the latest classification result.

### Request

    http://localhost:8000/debug/result

### Response

```json
{
  "classification": {
    "black_masked_bee": {
      "1": "filled",
      "2": "filled",
      "3": "filled"
    },
    "leafcutter_bee": {
      "1": "unfilled",
      "2": "unfilled",
      "3": "filled"
    },
    "orchard_bee": {
      "1": "unfilled",
      "2": "unfilled",
      "3": "unfilled"
    },
    "resin_bee": {
      "1": "filled",
      "2": "unfilled",
      "3": "filled"
    }
  }
}
```

<br>
<br>

# 3. Typical System Workflow

The normal workflow of the system is:

1.  Initialize the database (`/initial_insert`) -- development and first deployment only
2.  Register a new Hive module (`/new_module`)
3.  Upload images from the module (`/upload`)
4.  Data can be inspected using `/modules`, `/nests`, and `/progress` or in the web-interface http://localhost:5173

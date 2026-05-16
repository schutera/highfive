# DuckDB Service

The service documented here is the DuckDB service, which performs the following tasks:

- Management of modules (ESP32 devices)
- Management of nesting sites (nests)
- Recording of daily brood progress
- Processing of AI classification results
- Provision of data via a REST API

## Technologies Used

- Python: Backend development
- Flask: For REST API
- DuckDB: Database

## Reasons for Using DuckDB

DuckDB was selected as the database for this project. DuckDB is an in-process SQL database designed specifically for analytics that can be run without a server.

### 1. Single-File Database

DuckDB stores all data in a single file. This offers the following advantages:

- Easy backups
- Easy deployment
- No additional server required

As a result, DuckDB provides a practical and simple solution for Docker-based microservices.

### 2. Easy Integration with Python

There is a library available for using the database in Python. This makes it easy to use DuckDB with Python.

```python
con = duckdb.connect(“./data/app.duckdb”)
```

### 3. Excellent Performance

DuckDB is optimized for analytical operations.
Typical benefits include:

- Column-based storage
- Very fast aggregations

This is particularly relevant for future analyses of nest development over extended periods of time.

### 4. Simple Local Development

Unlike traditional databases such as PostgreSQL, DuckDB requires:

- no server
- no configuration
- no administration

This enables lightweight development.

### 5. Previous Experience with DuckDB

We have already worked with DuckDB as part of the Data Engineering course. We can draw on the experience gained during that course, which simplifies and accelerates the development process. Overall, DuckDB was chosen because it offers a good combination of easy integration, performance, and simple setup.

## Data Model

The data model consists of three main tables:

- `module`
- `nest_data`
- `daily_progress`

The tables form a hierarchical structure:

A module can have multiple nests, and each nest can have multiple daily progress entries.
Cardinality:

- one module -> many nests
- one nest -> many daily progress entries

---

# Table: module_configs

Stores information about the registered **ESP32 modules**.

| Attribute     | Data Type    | Required | Description                |
| ------------- | ------------ | -------- | -------------------------- |
| id            | VARCHAR(20)  | Yes      | unique module-ID           |
| name          | VARCHAR(100) | Yes      | name of module             |
| lat           | DECIMAL(9,6) | Yes      | latitude of location       |
| lng           | DECIMAL(9,6) | Yes      | longitude of location      |
| first_online  | DATE         | Yes      | date of first registration |
| battery_level | INTEGER      | No       | current battery level      |

---

# Table: nest_data

Saves individual **nests within a module**.

| Attribute | Data Type   | Required | Description         |
| --------- | ----------- | -------- | ------------------- |
| nest_id   | VARCHAR(20) | Yes      | unique nest-ID      |
| module_id | VARCHAR(20) | Yes      | reference to module |
| beeType   | VARCHAR(20) | No       | classified beetype  |

Possible values for `beeType`:

- `blackmasked`
- `resin`
- `leafcutter`
- `orchard`

---

# Table: daily_progress

Speichert den **täglichen Fortschritt eines Nestes**.

| Feld        | Datentyp    | Pflichtfeld | Beschreibung                    |
| ----------- | ----------- | ----------- | ------------------------------- |
| progress_id | VARCHAR(20) | Yes         | Unique ID of the progress entry |
| nest_id     | VARCHAR(20) | Yes         | Reference to the Nest           |
| date        | DATE        | Yes         | Date of entry                   |
| empty       | INTEGER     | Yes         | Number of empty cells           |
| sealed      | INTEGER     | Yes         | percentage of sealed cells      |
| hatched     | INTEGER     | Yes         | Number of hatched cells         |

The value `sealed` is stored as a percentage between 0 and 100 for one nest.

One possible extension for data storage would be to implement a layered model with bronze, silver, and gold layers. In the bronze layer, the images and JSON objects from the various modules could be stored in raw format. The Silver layer remains unchanged due to the existing relational schema. The Gold layer then comprises a star schema, where nests and modules could represent dimensions. The fact table could consist of the daily progress data. A star schema allows analytical processes and evaluations to be designed for higher performance and makes the data model efficient even for large data volumes.

## API Documentation

### GET /health

Checks whether the service and the database are accessible.

### POST /new_module

Registers a new module in the system.

- Existing modules with the same ID will be overwritten
- The time of registration is saved (`first_online`); `updated_at` is bumped on every call via the `ON CONFLICT DO UPDATE` branch
- The firmware-reported `module_name` is checked against other modules' `name` before insert; on collision the value is auto-suffixed (`-2`, `-3`, …) so two modules cannot share a label even before an operator runs the rename flow. Response body echoes the actually-stored name. See [ADR-011](../09-architecture-decisions/adr-011-module-display-name-override.md).
- The dashboard's `Module.status` is **derived** from `lastSeenAt` in `backend/src/database.ts`'s `fetchAndAssemble` (2 h offline threshold); duckdb-service does not store a `status` column (dropped in [#69](https://github.com/schutera/highfive/issues/69))

### GET /modules

Returns all registered modules. Each row includes both `name` (firmware-reported, mutable) and `display_name` (admin-settable override, UNIQUE; null by default). The homepage coalesces `display_name ?? name`. See [ADR-011](../09-architecture-decisions/adr-011-module-display-name-override.md).

### PATCH /modules/&lt;module_id&gt;/display_name

Sets or clears the admin-settable display-name override. Body: `{"display_name": "Garden Bee"}` to set, `{"display_name": null}` to clear. UNIQUE-enforced at the DB layer; HTTP 409 with the conflicting MAC on collision. Network-internal endpoint only — public access goes through the backend's `PATCH /api/modules/:id/name`, which adds the `X-Admin-Key` gate.

### GET /nests

Returns all nests

### GET /progress

Returns all saved progress data.

### POST /add_progress_for_module

This endpoint is used by the AI model to save classification results.

- There are three nests per bee species per module
- Missing nests are automatically generated
- Progress values are saved for the current date

### POST /modules/<module_id>/heartbeat — post-upload aggregate

Called by `image-service` after every accepted upload
(`image-service/services/duckdb.py`'s `heartbeat`). Implementation:
`duckdb-service/routes/modules.py`'s `heartbeat`.

Body: `{"battery": <int 0-100>}` → returns `{"ok": true}`.

Side effects (single `UPDATE` on `module_configs`, see
`routes/modules.py`'s `heartbeat`):

- Sets `battery_level` to the supplied value.
- Increments `image_count` by 1.
- `first_online` is `COALESCE`-guarded — left intact when already
  set (the common path; `add_module` writes it on registration),
  filled with today's date only on the first call after a NULL
  (defensive against legacy / manually-inserted rows; the schema
  declares `NOT NULL` so the branch is unreachable in current
  production). Resolved in
  [#75](https://github.com/schutera/highfive/issues/75) — the
  previous unconditional write was the source of the "first
  online today" drift this column used to advertise.

Does **not** insert into `module_heartbeats` and does **not** touch
the telemetry-heartbeat path. Despite the shared name, the two
endpoints are wholly separate.

### POST /heartbeat — telemetry heartbeat

Called by ESP32-CAM firmware directly, hourly (`sendHeartbeat` in
`ESP32-CAM/client.cpp`). Implementation in
`duckdb-service/routes/heartbeats.py` (`heartbeat` route).

Body (form-encoded): `mac`, `battery`, `rssi`, `uptime_ms`,
`free_heap`, `fw_version` → returns `{"ok": true}`.

Side effect: a single `INSERT` into `module_heartbeats`
(`routes/heartbeats.py:45-52`). The handler does **not** update
`module_configs` — liveness derivation in the backend reads
`module_configs.updated_at`, the latest `module_heartbeats.received_at`,
and the latest `image_uploads.uploaded_at` separately and takes the
freshest (`backend/src/database.ts`'s `fetchAndAssemble`). The most recent
`module_heartbeats` row is materialised on the wire as
`Module.latestHeartbeat`
(shape: [`HeartbeatSnapshot`](../08-crosscutting-concepts/api-contracts.md))
per [ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md).

> ⚠️ **Endpoint naming hazard.** Two endpoints share the word
> "heartbeat" but do different things and write different tables.
> See the [glossary](../12-glossary/README.md) entries
> "Heartbeat (telemetry)" and "Heartbeat (post-upload aggregate)".
> Don't add a third heartbeat endpoint without renaming.

### GET /modules/<module_id>/progress_count

Returns `{"count": <int>}` — the number of `daily_progress` rows
associated with the given module. Used by `image-service` to detect
first-upload events without opening a direct DuckDB connection.

## Internal services (no HTTP surface)

| Module                        | Role                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/silence_watcher.py` | Periodic Discord alert when a module goes silent for >3 h, recovery message on return — see [ADR-005](../09-architecture-decisions/adr-005-silence-watcher-in-duckdb-service.md) |
| `services/backup.py`          | Periodic snapshot of `app.duckdb` to a sibling backup file under `/data`                                                                                                         |
| `services/discord.py`         | Thin webhook wrapper used by the silence watcher and the AI-classification flow                                                                                                  |

## References:

- Lecture Data Engineering + Folien
- Dixon, J. (2010, Oktober). Pentaho, Hadoop, and Data Lakes. In James Dixon’s Blog. https://jamesdixon.wordpress.com/2010/10/14/pentaho-hadoop-and-data-lakes/
- Kosinski, M. (2025, Januar 16). Was ist ein Data Lake? | IBM. https://www.ibm.com/de-de/think/topics/data-lake
- Laurent, A., Laurent, D., & Madera, C. (Hrsg.). (2019). Data lakes. ISTE Ltd / John Wiley and Sons Inc.
- Microsoft. (o. J.). Worum handelt es sich bei der Medallion Lakehouse-Architektur? – Azure Databricks. Abgerufen 2. Februar 2026, von https://learn.microsoft.com/de-de/azure/databricks/lakehouse/medallion
- Schmitz, U. (2025). Data Lakes: Grundlagen, Architektur, Instrumente und Einsatzmöglichkeiten. Springer Berlin Heidelberg. https://doi.org/10.1007/978-3-662-70332-8
- Serra, J. (2024). Datenarchitekturen. https://content-select.com/de/portal/media/view/66cc3b99-83f8-4082-94e8-425bac1b0006?forceauth=1
- Strengholt, P. (2025). Building Medallion Architectures: Designing with Delta Lake and Spark. O’Reilly Media, Inc.
- the_agile_brand_guide. (2025, November 11). Bronze, Silver, and Gold Data Layers. The Agile Brand Guide®. https://agilebrandguide.com/wiki/data/bronze-silver-and-gold-data-layers/
- User, G. (o. J.). Documentation. DuckDB. Abgerufen 2. Februar 2026, von https://duckdb.org/docs/stable/
- Was versteht man unter Medallion-Architektur? (2022, März 9). Databricks. https://www.databricks.com/de/glossary/medallion-architecture
- What is a Medallion Architecture? (2022, September 3). Databricks. https://www.databricks.com/glossary/medallion-architecture

## Translation

This file was translated from German to English using DeepL.

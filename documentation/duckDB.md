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

| Attribute     | Data Type    | Required | Description                            |
| ------------- | ------------ | -------- | -------------------------------------- |
| id            | VARCHAR(20)  | Yes      | unique module-ID                       |
| name          | VARCHAR(100) | Yes      | name of module                         |
| lat           | DECIMAL(9,6) | Yes      | latitude of location                   |
| lng           | DECIMAL(9,6) | Yes      | longitude of location                  |
| status        | VARCHAR(10)  | Yes      | status of module (`online`, `offline`) |
| first_online  | DATE         | Yes      | date of first registration             |
| battery_level | INTEGER      | No       | current battery level                  |

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

### GET /initial_insert

Inserts sample modules, nests, and progress data. This endpoint is intended for development and testing purposes.

### POST /test_insert

Inserts a test module into the database.

### POST /remove_test

Removes the test module from the database.

### POST /new_module

Registers a new module in the system.

- Existing modules with the same ID will be overwritten
- Status is automatically set to `online`
- The time of registration is saved

### GET /modules

Returns all registered modules.

### GET /nests

Returns all nests

### GET /progress

Returns all saved progress data.

### POST /add_progress_for_module

This endpoint is used by the AI model to save classification results.

- There are three nests per bee species per module
- Missing nests are automatically generated
- Progress values are saved for the current date

### POST /modules/<module_id>/heartbeat

Called by `image-service` on every accepted upload. Body:
`{"battery": <int>}` → returns `{"ok": true}`.

- Updates `battery_level` on `module_configs`
- Sets `first_online` to today if it has not been set yet
- Increments `image_count`

### GET /modules/<module_id>/progress_count

Returns `{"count": <int>}` — the number of `daily_progress` rows
associated with the given module. Used by `image-service` to detect
first-upload events without opening a direct DuckDB connection.

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

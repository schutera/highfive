# DuckDB Service

Beim hier dokumentierte Service handelt es sich um den DuckDB-Service, welcher folgende Aufgaben übernimmt:

- Verwaltung von Modulen (ESP32 Geräte)
- Verwaltung von Nistplätzen (Nests)
- Speicherung des täglichen Fortschritts der Brut
- Verarbeitung von KI-Klassifikationsergebnissen
- Bereitstellung von Daten über eine REST API

## Verwendete Technologien

- Python: Backend Entwicklung
- Flask: Für REST-API
- DuckDB: Datenbank

## Gründe für die Verwendung der DuckDB

Im Rahmen des Projekts wurde die DuckDB als Datenbank ausgewählt. DuckDB ist eine analytische In-Process SQL Datenbank, die speziell für Analysen entwickelt wurde und ohne einen Server betrieben werden kann.

### 1. Single File Datenbank

DuckDB speichert alle Daten in einer einzelnen Datei. Dadurch werden folgende Vorteile möglich:

- einfache Backups
- einfaches Deployment
- kein zusätzlicher Server nötig

Dementsprechend liefert DuckDB eine praktische und einfache Lösung für Docker-basierte Microservices.

### 2. Einfache Integration in Python

Für die Verwendung der Datenbank in Python existiert eine Bibliothek. So kann die DuckDB einfach mit Python verwendet werden.

```python
con = duckdb.connect("./data/app.duckdb")
```

### 3. Sehr gute Performance

DuckDB ist auf analytische Vorgänge optimiert.
Typische Vorteile sind dabei:

- spaltenbasierte Speicherung
- sehr schnelle Aggregationen

Dies ist besonders relevant für zukünftige Auswertungen der Nestentwicklung über längere Zeiträume.

### 4. Einfache Lokale Entwicklung

Im Gegensatz zu klassischen Datenbanken wie PostgreSQL benötigt DuckDB:

- keinen Server
- keine Konfiguration
- keine Verwaltung

Dadurch kann eine leichtgewichtige Entwicklung ermöglicht werden.

### 5. Vorerfahrungen mit DuckDB

Im Rahmen der Vorlesung Data Engineering wurde bereits mit der DuckDB gearbeitet. Dabei kann auf Erfahrungen basierend auf der Vorlesung zurückgegriffen werden. Das erleichtert und beschleunigt den Entwicklungsprozess. Insgesamt wurde die DuckDB gewählt, da sie eine gute Kombination aus einfacher Integration, Performance und einfachem Setup bietet.

###

Quellen:

- Data Engineering Vorlesung + Folien
- DuckDB Dokumentation: `https://duckdb.org/docs/stable/`

## Datenmodell

Das Datenmodell besteht aus drei zentralen Tabellen:

- `module`
- `nest_data`
- `daily_progress`

Die Tabellen bilden eine hierarchische Struktur:

Ein Modul kann mehrere Nester besitzen und jedes Nest kann mehrere tägliche Fortschrittseinträge haben.

---

# Tabelle: module_configs

Speichert Informationen über die registrierten **ESP32 Module**.

| Feld          | Datentyp     | Pflichtfeld | Beschreibung                            |
| ------------- | ------------ | ----------- | --------------------------------------- |
| id            | VARCHAR(20)  | Ja          | Eindeutige Modul-ID                     |
| name          | VARCHAR(100) | Ja          | Name des Moduls                         |
| lat           | DECIMAL(9,6) | Ja          | Breitengrad des Standorts               |
| lng           | DECIMAL(9,6) | Ja          | Längengrad des Standorts                |
| status        | VARCHAR(10)  | Ja          | Status des Moduls (`online`, `offline`) |
| first_online  | DATE         | Ja          | Datum der ersten Registrierung          |
| battery_level | INTEGER      | Ja          | Aktueller Batteriestand                 |

---

# Tabelle: nest_data

Speichert einzelne **Nester innerhalb eines Moduls**.

| Feld      | Datentyp    | Pflichtfeld | Beschreibung             |
| --------- | ----------- | ----------- | ------------------------ |
| nest_id   | VARCHAR(20) | Ja          | Eindeutige Nest-ID       |
| module_id | VARCHAR(20) | Ja          | Referenz auf das Modul   |
| beeType   | VARCHAR(20) | Nein        | Klassifizierte Bienenart |

Mögliche Werte für `beeType`:

- `blackmasked`
- `resin`
- `leafcutter`
- `orchard`

---

# Tabelle: daily_progress

Speichert den **täglichen Fortschritt eines Nestes**.

| Feld        | Datentyp    | Pflichtfeld | Beschreibung                           |
| ----------- | ----------- | ----------- | -------------------------------------- |
| progress_id | VARCHAR(20) | Ja          | Eindeutige ID des Fortschrittseintrags |
| nest_id     | VARCHAR(20) | Ja          | Referenz auf das Nest                  |
| date        | DATE        | Ja          | Datum des Eintrags                     |
| empty       | INTEGER     | Ja          | Anzahl leerer Zellen                   |
| sealed      | INTEGER     | Ja          | Anteil versiegelter Zellen             |
| hatched     | INTEGER     | Ja          | Anzahl geschlüpfter Zellen             |

Der Wert `sealed` wird als Prozentwert zwischen 0 und 100 gespeichert.

Eine Mögliche Erweiterung für die Datenhaltung, wäre die Umsetzung eines Schichtenmodells mit Bronze, Silber und Gold Layer. In der Bronzeschicht könnten so die Bilder und JSON-Objekte der verschiedenen Module im Rohformat gespeichert werden können. Die Silberschicht bleibt durch das oben bestehende relationale Schema erhalten. Die Goldschicht umfasst dann ein Star-Schema, wobei Nester und Module Dimensionen darstellen könnten. Die Faktentabelle könnte besteht aus den Daily Progress Daten. Durch ein Star Schema können Analytische Prozesse und Auswertungen performanter gestalten werden und machen das Datenmodell auch für große Datenmengen effizient.

## API Dokumentation

### GET /health

Prüft, ob der Service und die Datenbank erreichbar sind.

### GET /initial_insert

Fügt Beispielmodule, Nester und Fortschrittsdaten ein. Dieser Endpunkt dient zu Entwicklungs- und Testzwecken.

### POST /test_insert

Fügt ein Testmodul in die Datenbank ein.

### POST /remove_test

Entfernt das Testmodul wieder aus der Datenbank.

### POST /new_module

Registriert ein neues Modul im System.

- vorhandene Module mit gleicher ID werden überschrieben
- Status wird automaitsch auf `online` gesetzt
- Zeitpunkt der Registrierung wird gespeichert

### GET /modules

Gibt alle registrierten Module zurück.

### GET /nests

Gibt alle Nester Zurück

### GET /progress

Gibt alle gespeicherten Fortschritssdaten ab.

### POST /add_progress_for_moduel

Dieser Endpunkt wird vom KI-Modell verwendet um Klassifikationsergebnisse zu speichern.

- pro Modul existieren drei Nester pro Bienenart
- fehlende Nester werden automatisch erzeugt
- Fortschrittswerte werden für das aktuelle Datum gespeichert

## Quellen:

- Vorlesung Data Engineering + Folien
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

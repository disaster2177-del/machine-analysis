# Radar Analysis: offline Q&A over crores of radar plots

Ask questions about your radar data in plain English from a React UI. For example: *"probability of detection by sensor yesterday"*, *"registration bias between sensors"*, *"any emergency squawks?"*, *"coverage of Mumbai radar"* or *"plots below FL 50 within 30 km of 19.09, 72.87"*. Each answer comes with a chart, the table and the SQL that was run.

- **Radar data standard.** Plots follow **EUROCONTROL ASTERIX Category 048** (monoradar target reports). The field list is in [docs/RADAR_DATA_FORMAT.md](docs/RADAR_DATA_FORMAT.md).
- **Multiple sensors** in one table. Every analysis can be broken down by sensor or compared across sensors.
- **Works on your live DuckDB file.** The app reads the database your ingest pipeline writes and picks up new data automatically. Answers marked *Live* re-run on their own.
- **Fully offline.** No cloud APIs, map tiles, CDNs or web fonts.
- **Fast.** DuckDB, an embedded columnar engine, holds the data. See [Performance](#performance).
- **React** frontend and **Node.js (Express)** backend, served together on one port.

Non-radar tables (for example the machine readings sample) still work with the general question engine. See [Other data](#other-data).

## Quick start

Requires Node.js 18 or newer (tested on Node 22).

```bash
npm run install:all                 # dependencies (one time, needs internet)

# Try it with simulated radar data: 5 sensors, ~44 lakh plots per simulated day (~90 s per day)
npm run generate:radar              # 1 day
npm run generate:radar -- --days 11 # ~5 crore plots

npm run build                       # build the React app
npm start                           # → http://127.0.0.1:3001
```

**Using your own DuckDB file:**

```bash
DB_PATH=/path/to/radar.duckdb TABLE=radar_plots npm start
```

If your column names differ from the standard ones, create a view once. You don't need to copy any data. See [docs/RADAR_DATA_FORMAT.md](docs/RADAR_DATA_FORMAT.md#your-table-has-different-column-names).

## What you can ask

### Radar surveillance analyses

| Ask… | What you get |
|---|---|
| *Sensor status* · *which sensors are active?* | last plot per sensor, seconds since, plots in the last 5 min, ACTIVE / SILENT |
| *Probability of detection by sensor* · *missed detections for Pune yesterday* | Pd % per sensor (track-based), missed updates, sensors below the target (`PD_TARGET`, default 97%) |
| *Scan period of each radar* · *update rate* | median scan period, rpm, 5th/95th percentile update interval |
| *Data gaps longer than 2 minutes* · *outages of Hyderabad last week* | every period a sensor was silent, longest first, total silent time per sensor |
| *Registration bias between sensors* | relative azimuth (°) and range (m) bias for every pair of sensors that saw the same aircraft at the same time, and the sensor most likely to be misaligned |
| *Any emergency squawks?* · *7700 today* | 7500 / 7600 / 7700 events with aircraft, callsign, first/last seen, sensors, last position |
| *Which aircraft changed their squawk code?* | Mode 3/A code changes per aircraft |
| *Altitude jumps* · *altitude jumps faster than 6000 ft/min* | implausible Mode C changes between updates, with the levels before and after |
| *Coverage of Mumbai radar* · *coverage in 5° sectors* | range by azimuth sector, drawn as a polar coverage diagram |
| *Track statistics per sensor* · *dropped tracks* | track count, median/average duration, short tracks, tracks dropped without the end flag |
| *Latency by sensor* | average / 95th percentile / maximum delay between detection and reception |
| *Clutter and false plots by sensor* | ghost plots, unassociated primary plots, false-plot % |

All of these accept filters in the same question: a sensor (*"for Nagpur"*), a period (*"yesterday"*, *"last 6 hours"*, *"between 2026-09-21 and 2026-09-23"*), an aircraft (*"callsign AIC1452"*, *"aircraft 800C4A"*) or an area (*"within 50 km of 19.09, 72.87"*).

Without a period, radar analyses cover the **last 24 hours of data** so they stay fast on crores of plots. Say *"all time"* to cover everything.

### General questions on the same data

The general engine handles everything else:

- *How many plots per sensor?* · *Hourly plot count by sensor* · *Count by report type for each sensor*
- *How many aircraft did Mumbai radar see yesterday?* · *How many PSR only plots by sensor?*
- *Average SSR amplitude by sensor* · *Distribution of ground speed* · *Highest flight level recorded*
- *Show track 1234 of Pune* · *Show latest plots for callsign AIC1452* · *Plots with squawk 2304*
- *Plots below FL 50 within 30 km of 19.09, 72.87* · *How many aircraft above flight level 300 in Nagpur*
- *Where was the lowest altitude for Hyderabad* (returns the full record)

The engine knows radar vocabulary. *Squawk* means `mode3a`, *range* means `range_nm`, *altitude* or *FL* means `flight_level`, *aircraft* means `aircraft_address`, *speed* means `ground_speed_kt`, and so on. Every value it has seen in the data also acts as a filter word: sensor names, report types such as *PSR* or *MODES_ROLLCALL*, and climb modes.

Each answer shows **"Understood as …"**, so you can check how the question was read. You can edit and re-run the SQL in the SQL tab.

## How it works

```
React UI ──► POST /api/ask ──► radar analysis? (Pd, gaps, bias, …) ──► SQL on DuckDB
                                   │ no
                                   ▼
                          rule-based NL→SQL engine (≈1 ms) ──► SQL on DuckDB
                                   │ not sure?
                                   ▼
                          optional local LLM (Ollama / llama.cpp) ──► SQL guard ──► DuckDB
```

- `backend/src/radar/fields.js`: the ASTERIX CAT048 field definitions and their question vocabulary.
- `backend/src/radar/analytics.js`: the radar analyses, written as DuckDB SQL (window functions, time-bucketed matching of the same aircraft across sensors).
- `backend/src/nlq/ruleParser.js`: the general question engine for time ranges, filters, grouping, aggregates and location.
- Safety: the database is opened **read-only**, with file and network access disabled and settings locked. SQL from the LLM or the SQL editor must also pass a guard that allows only a single `SELECT`.

## Live data and DuckDB locking

DuckDB lets **only one process at a time** open a database file, even for reading. So by default the app opens the file only while a question runs and closes it after 2 s idle, which leaves room for your ingest process to write. I tested a separate writer appending batches while questions ran: both kept working, and new rows appeared in answers within seconds.

For this to work, your **writer must open, append and close the file per batch**, for example every few seconds, rather than holding it open permanently. If it holds the file open, readers wait up to `LOCK_WAIT_MS` and then report that the file is locked. If nothing else writes the file, set `HOLD_DB_OPEN=true` for the best speed.

The app checks the file every `RELOAD_CHECK_MS` (15 s). When the file has changed it clears cached answers and refreshes row counts, the time range and the sensor list. Large value lists such as aircraft addresses are rescanned every 10 minutes.

## Optional: local LLM for free-form questions

```bash
ollama pull qwen2.5-coder:7b       # once, while online; the backend detects it at http://127.0.0.1:11434
# or any OpenAI-compatible local server:
LLM_PROVIDER=openai LLM_BASE_URL=http://127.0.0.1:8080 LLM_MODEL=my-model npm start
```

The model receives the table definition, including each column's ASTERIX meaning. Set `LLM_PROVIDER=none` to use the rule engine only.

## Configuration

Set these as environment variables, or copy `backend/config.example.json` to `backend/config.json`.

| Setting | Default | Meaning |
|---|---|---|
| `DB_PATH` | `data/radar.duckdb` | DuckDB file |
| `TABLE` | `radar_plots` | table or view to analyse; if it doesn't exist, the first table in the file is used |
| `PD_TARGET` | `97` | probability-of-detection target (%) used to flag sensors |
| `TRACK_GAP_S` | `60` | a track silent this long counts as ended (used for Pd and track statistics) |
| `RADAR_DEFAULT_WINDOW_H` | `24` | hours covered by radar analyses when no period is given |
| `RELOAD_CHECK_MS` | `15000` | how often to check the file for new data |
| `HOLD_DB_OPEN` | `false` | keep the file open (only if no other process writes it) |
| `IDLE_CLOSE_MS` / `LOCK_WAIT_MS` | `2000` / `20000` | close after idle; how long to wait for the writer's lock |
| `COLUMN_ALIASES` | — | extra question words, e.g. `{"snr_db": ["snr"]}` |
| `RELATIVE_TIME_ANCHOR` | `data` | "last 6 hours" counts back from the newest plot (`data`) or the clock (`now`) |
| `DATE_ORDER` | `dmy` | how `05/03/2026` is read |
| `DUCKDB_THREADS` / `DUCKDB_MEMORY_LIMIT` | all cores / 75% RAM | query resources |
| `MAX_RESULT_ROWS` / `QUERY_TIMEOUT_MS` | `5000` / `60000` | result size and time limits |
| `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL` | `ollama` / … / `qwen2.5-coder:7b` | optional local LLM |

## Performance

PERFORMANCE_TABLE

## Other data

The general engine works on any DuckDB table, such as the machine-readings sample:

```bash
npm run generate:machine            # 5 crore machine readings → backend/data/machine.duckdb
DB_PATH=data/machine.duckdb TABLE=readings npm start
```

Use `npm run ingest` to import CSV, Parquet, Postgres, MySQL or SQLite into a DuckDB file. Run `node backend/scripts/ingest.js` without arguments for usage.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/ask` `{question, engine: "auto"\|"rules"\|"llm"}` | answer a question |
| `POST /api/sql` `{sql}` | run a read-only SELECT (the SQL tab) |
| `GET /api/schema` | columns with ASTERIX meaning, ranges, example questions, LLM status |
| `GET /api/status` | row count, time range, data version (changes when new data arrives) |

## Tests

```bash
npm test     # parser + radar analyses (runs each analysis on a small in-memory radar table)
```

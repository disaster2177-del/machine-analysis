# Machine Analysis: offline Q&A over crores of readings

Ask questions about your machine data in plain English from a React UI, for example *"average max value by site last month"*, *"which machine had the most errors in June"* or *"readings within 5 km of 18.52, 73.85"*. You get an answer, a chart, the table and the SQL that was run.

- **Fully offline.** Nothing leaves the machine: no cloud APIs, map tiles, CDNs or web fonts.
- **Fast.** The data lives in [DuckDB](https://duckdb.org), an embedded columnar engine. On a 5 crore (50,000,000) row table on a 4-core machine, typical questions take 5–400 ms and repeated questions are served from cache.
- **React** frontend and **Node.js (Express)** backend. Both run on one port in production.

## How it answers questions

```
React UI ──► POST /api/ask ──► rule-based NL→SQL engine (≈1 ms, no model needed)
                                     │ confidence high? ──► DuckDB (read-only) ──► answer + chart + table + SQL
                                     │ not sure?
                                     └──► optional local LLM (Ollama / llama.cpp / LM Studio) writes SQL
                                           └─► SQL guard ──► DuckDB ──► answer
```

1. **Rule engine** (`backend/src/nlq/ruleParser.js`). It reads your schema at startup. It learns column names, synonyms ("max value" → `max_value`, "machine" → `machine_id`) and every value of the low-cardinality text columns ("Pune", "ERROR", "temperature"). It understands:
   - aggregations: count, average, sum, min, max, median, std deviation, percentiles, distinct counts
   - grouping: *by site*, *per machine*, *status wise*, *for each sensor*, *which machine…*, *top 10 machines…*
   - time: *daily / hourly / monthly*, *trend*, *last 7 days*, *yesterday*, *this month*, *in March 2025*, *between 2025-02-01 and 2025-02-15*, *since 1st June*, *Q2 2025*, *05/03/2025*
   - filters: values anywhere in the question, *excluding Delhi*, *max value above 90*, *between 10 and 20*, *machine M-0012*, *contains 'abc'*
   - location: *within 5 km of lat, lon*, *nearest 10 readings to lat, lon*
   - analysis: summary statistics, distribution / histogram, correlation, *when was the highest …* (returns the full record), *machines with more than 100 errors* (HAVING)

   Each answer shows **"Understood as …"** and a confidence level, so you can check how the question was read. Words it did not understand are listed.
2. **Local LLM (optional).** If the rule engine is unsure and a local model is running, the question goes to the model with the schema. If the SQL fails, the model gets one chance to fix it. Choose *Rules*, *Local LLM* or *Auto* in the UI.
3. **Safety.** The database is opened **read-only**, with external file and network access disabled and the configuration locked. SQL from the LLM or the SQL editor must also pass a guard that allows only a single `SELECT`.

## Quick start

Requires Node.js 18 or newer (tested on Node 22).

```bash
npm run install:all          # backend + frontend dependencies (one time, needs internet)

# Option A: try it with 5 crore synthetic rows (~2.5 min, ~870 MB)
npm run generate
#   smaller: npm run generate -- --rows 1000000

# Option B: import your own data (see "Your data" below)

npm run build                # build the React app
npm start                    # → http://127.0.0.1:3001
```

After `npm run install:all`, everything runs without internet. To move the app to an air-gapped machine, copy the whole folder, including `node_modules`, the built `frontend/dist` and `backend/data/`.

Development mode with hot reload: run `npm run dev:backend` and `npm run dev:frontend`, then open http://localhost:5173.

## Your data

The importer copies your data into `backend/data/machine.duckdb`. Sorting by the timestamp makes time filters much faster.

```bash
# CSV / Parquet exports (no extra downloads)
npm run ingest -- --csv "/path/to/export/*.csv" --time-column ts
npm run ingest -- --parquet "/path/to/*.parquet" --time-column ts

# Straight from a database
npm run ingest -- --postgres "host=localhost dbname=plant user=me password=secret" --source-table public.readings --time-column ts
npm run ingest -- --mysql "host=localhost database=plant user=me password=secret" --source-table readings --time-column ts
npm run ingest -- --sqlite /data/plant.db --source-table readings --time-column ts

# Rename columns while importing
npm run ingest -- --csv data.csv --rename "Timestamp:ts,Latitude:lat,Longitude:lon,MinValue:min_value,MaxValue:max_value"
```

> The `--postgres`, `--mysql` and `--sqlite` options use DuckDB extensions, which are downloaded the first time they are used. Run that import once while online, or copy `~/.duckdb/extensions` from a machine that has them. CSV and Parquet need no extensions.

No column names are hard-coded. The schema is detected automatically:

| Role | Auto-detected from | Override |
|---|---|---|
| time | first `TIMESTAMP`/`DATE` column (prefers `ts`, `timestamp`, `time`, …) | `TIME_COLUMN` |
| latitude / longitude | `lat`/`latitude`, `lon`/`lng`/`longitude` | `LAT_COLUMN`, `LON_COLUMN` |
| categories | text columns with ≤ 20,000 distinct values (their values become filter words) | `MAX_CATEGORY_VALUES` |
| measures | every numeric column | — |

The schema scan runs once (a few seconds on 5 crore rows). The result is cached in `machine.duckdb.meta.json` and rebuilt when the database file changes. Restart the server after re-importing.

## Optional: local LLM for free-form questions

The rule engine covers most analytical questions. For anything else, such as complex conditions, unusual wording or multi-step logic, run a local model:

```bash
# Ollama (https://ollama.com). Pull while online, then it works offline
ollama pull qwen2.5-coder:7b
# the backend detects it automatically at http://127.0.0.1:11434
```

Or point the app at any OpenAI-compatible local server (llama.cpp `llama-server`, LM Studio, vLLM):

```bash
LLM_PROVIDER=openai LLM_BASE_URL=http://127.0.0.1:8080 LLM_MODEL=my-model npm start
```

Set `LLM_PROVIDER=none` to use the rule engine only. Good SQL models: `qwen2.5-coder:7b` (on CPU), `qwen2.5-coder:14b` or `sqlcoder` (if you have a GPU).

## Configuration

Set these as environment variables, or copy `backend/config.example.json` to `backend/config.json`.

| Setting | Default | Meaning |
|---|---|---|
| `DB_PATH` | `data/machine.duckdb` | DuckDB file |
| `TABLE` | `readings` | table to analyse |
| `RELATIVE_TIME_ANCHOR` | `data` | "last 7 days" counts back from the newest row (`data`) or from the clock (`now`) |
| `DATE_ORDER` | `dmy` | how `05/03/2025` is read (`dmy` or `mdy`) |
| `DUCKDB_THREADS` | all cores | query parallelism |
| `DUCKDB_MEMORY_LIMIT` | 75% of RAM | e.g. `8GB` |
| `MAX_RESULT_ROWS` | `5000` | rows returned to the UI per answer |
| `QUERY_TIMEOUT_MS` | `60000` | queries are cancelled after this |
| `CACHE_SIZE` | `500` | cached query results |
| `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL` | `ollama` / `http://127.0.0.1:11434` / `qwen2.5-coder:7b` | local LLM |

## Performance notes

Measured on the 5 crore row sample (4 vCPU, 16 GB RAM):

| Question | Time |
|---|---|
| how many records are there | 3 ms |
| daily average max value in Pune last 30 days | 16 ms |
| top 5 machines with the most errors | 66 ms |
| average max value by site | 90 ms |
| correlation between min_value and max_value | 153 ms |
| summary of max_value | 353 ms |
| readings within 5 km of 18.52, 73.85 (+ total count) | 359 ms |
| 95th percentile of max value for vibration sensors | 426 ms |

To make it faster: use more CPU cores (DuckDB scales almost linearly), import sorted by time with `--time-column`, and store data on an SSD.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/ask` `{question, engine: "auto"\|"rules"\|"llm"}` | answer a question |
| `POST /api/sql` `{sql}` | run a read-only SELECT (used by the SQL tab) |
| `GET /api/schema` | columns, ranges, example questions, LLM status |
| `GET /api/llm/status` | re-check the local LLM |

## Project layout

```
backend/
  src/server.js            Express API + serves the built UI
  src/db.js                DuckDB (read-only), connection pool, timeout, result cache
  src/schema.js            schema detection + cached metadata
  src/nlq/ruleParser.js    offline natural-language → SQL engine
  src/nlq/time.js          date parsing / relative ranges
  src/nlq/narrate.js       plain-English answers, chart inference
  src/nlq/llm.js           optional local LLM (Ollama / OpenAI-compatible)
  src/nlq/sqlGuard.js      read-only SQL guard
  scripts/generate-sample-data.js, scripts/ingest.js
  test/ruleParser.test.js  npm test
frontend/
  src/App.jsx              chat-style question/answer UI
  src/components/          answer cards, SVG charts (line, bar, histogram, lat/long map), table + CSV export
```

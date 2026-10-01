# Radar data format (ASTERIX CAT048)

The app analyses radar **target reports (plots)** stored in a DuckDB table. The columns follow
**EUROCONTROL ASTERIX Category 048, "Monoradar Target Reports"**. This is the open, international
standard format in which primary and secondary (SSR / Mode S) surveillance radars output plots.
Each column below records the ASTERIX data item it comes from, so a CAT048 decoder can write
straight into this table.

- One row = one plot from one sensor.
- Several sensors share one table; `sensor_id` (plus `sac`/`sic`) says which sensor reported it.
- Only `ts`, `sensor_id`, `range_nm` and `azimuth_deg` are required. When a column is missing,
  the analyses that need it say so, and everything else keeps working.
- Units: range in nautical miles, angles in degrees (0 = north, clockwise), flight level in
  hundreds of feet, speed in knots, times in UTC.

## Columns

| Column | Type | ASTERIX item | Meaning | Words you can use in questions |
|---|---|---|---|---|
| `ts` | TIMESTAMP | I048/140 | Time of day of the detection (UTC), combined with the date | time, detection time |
| `received_at` | TIMESTAMP | — | When the report reached the processing system (optional, used for latency) | reception time, arrival time |
| `sac` | SMALLINT | I048/010 SAC | System Area Code of the sensor | system area code |
| `sic` | SMALLINT | I048/010 SIC | System Identification Code of the sensor | system identification code |
| `sensor_id` | VARCHAR | I048/010 | Sensor name (from SAC/SIC) | sensor, radar, station, radar station, radar site |
| `report_type` | VARCHAR | I048/020 TYP | PSR, SSR, SSR+PSR, MODES_ALLCALL, MODES_ROLLCALL, MODES_ALLCALL+PSR, MODES_ROLLCALL+PSR | detection type, plot type, target type |
| `simulated` | BOOLEAN | I048/020 SIM | Simulated target report | — |
| `spi` | BOOLEAN | I048/020 SPI | Special Position Identification (ident pressed) | ident |
| `range_nm` | DOUBLE | I048/040 RHO | Measured slant range in nautical miles | range, distance, rho, slant range |
| `azimuth_deg` | DOUBLE | I048/040 THETA | Measured azimuth in degrees (0 = north, clockwise) | azimuth, bearing, theta |
| `mode3a` | VARCHAR | I048/070 | Mode 3/A code (4 octal digits) | squawk, mode 3a, mode a, mode 3/a, ssr code, code |
| `mode3a_valid` | BOOLEAN | I048/070 V | Mode 3/A code validated | — |
| `mode3a_garbled` | BOOLEAN | I048/070 G | Mode 3/A code garbled | — |
| `flight_level` | DOUBLE | I048/090 | Mode C flight level (1 FL = 100 ft) | fl, altitude, level, mode c, height |
| `fl_valid` | BOOLEAN | I048/090 V | Flight level validated | — |
| `ssr_replies` | SMALLINT | I048/130 SRR | Number of SSR replies received | replies, reply count |
| `ssr_amplitude_dbm` | DOUBLE | I048/130 SAM | Amplitude of SSR replies (dBm) | amplitude, ssr amplitude, signal strength, signal |
| `psr_amplitude_dbm` | DOUBLE | I048/130 PAM | Amplitude of primary plot (dBm) | psr amplitude, primary amplitude |
| `aircraft_address` | VARCHAR | I048/220 | Mode S 24-bit aircraft address (hex) | aircraft, icao address, icao, mode s address, target address, target |
| `callsign` | VARCHAR | I048/240 | Aircraft identification (callsign) | call sign, flight, flight id, flight number, aircraft identification, ident code |
| `track_number` | INTEGER | I048/161 | Track number (0-4095) | track, track no, track id |
| `x_nm` | DOUBLE | I048/042 X | Calculated position X (east of sensor), NM | — |
| `y_nm` | DOUBLE | I048/042 Y | Calculated position Y (north of sensor), NM | — |
| `ground_speed_kt` | DOUBLE | I048/200 | Calculated ground speed (knots) | speed, ground speed, velocity, gs |
| `heading_deg` | DOUBLE | I048/200 | Calculated heading (degrees) | heading, course, direction |
| `track_status` | VARCHAR | I048/170 CNF | CONFIRMED or TENTATIVE | track state |
| `climb_mode` | VARCHAR | I048/170 CDM | MAINTAINING, CLIMBING, DESCENDING, UNKNOWN | vertical status, climb descent mode, vertical mode |
| `track_end` | BOOLEAN | I048/170 TRE | Last report of a track | — |
| `ghost` | BOOLEAN | I048/170 GHO | Ghost (false) target track | — |
| `lat` | DOUBLE | derived (WGS-84) | Latitude computed from sensor position + range/azimuth | latitude |
| `lon` | DOUBLE | derived (WGS-84) | Longitude computed from sensor position + range/azimuth | longitude |

Values used for coded fields:

| Column | Values |
|---|---|
| `report_type` (I048/020 TYP) | `PSR`, `SSR`, `SSR+PSR`, `MODES_ALLCALL`, `MODES_ROLLCALL`, `MODES_ALLCALL+PSR`, `MODES_ROLLCALL+PSR` |
| `track_status` (I048/170 CNF) | `CONFIRMED`, `TENTATIVE` |
| `climb_mode` (I048/170 CDM) | `MAINTAINING`, `CLIMBING`, `DESCENDING`, `UNKNOWN` |
| `mode3a` (I048/070) | 4 octal digits as text, e.g. `'2304'`, `'7700'` |
| `aircraft_address` (I048/220) | 6 hex digits, e.g. `'800C4A'` |

Create the table with the same definition the app uses:

```sql
CREATE TABLE radar_plots (
  ts TIMESTAMP, received_at TIMESTAMP, sac SMALLINT, sic SMALLINT, sensor_id VARCHAR,
  report_type VARCHAR, simulated BOOLEAN, spi BOOLEAN, range_nm DOUBLE, azimuth_deg DOUBLE,
  mode3a VARCHAR, mode3a_valid BOOLEAN, mode3a_garbled BOOLEAN, flight_level DOUBLE, fl_valid BOOLEAN,
  ssr_replies SMALLINT, ssr_amplitude_dbm DOUBLE, psr_amplitude_dbm DOUBLE, aircraft_address VARCHAR,
  callsign VARCHAR, track_number INTEGER, x_nm DOUBLE, y_nm DOUBLE, ground_speed_kt DOUBLE,
  heading_deg DOUBLE, track_status VARCHAR, climb_mode VARCHAR, track_end BOOLEAN, ghost BOOLEAN,
  lat DOUBLE, lon DOUBLE
);
```

Converting raw CAT048 values: RHO LSB = 1/256 NM; THETA LSB = 360/2^16 °; flight level LSB = 1/4 FL;
X/Y LSB = 1/128 NM; ground speed LSB = 2^-14 NM/s (× 3600 for knots); heading LSB = 360/2^16 °;
time of day LSB = 1/128 s since midnight UTC.

## Your table has different column names?

You don't need to copy or re-import anything. Create a **view** once that renames your columns to
the names above, then point the app at the view:

```sql
-- run once with the DuckDB CLI:  duckdb /path/to/your.duckdb
CREATE VIEW radar_plots AS
SELECT
  event_time            AS ts,
  radar_name            AS sensor_id,
  sac, sic,
  rho / 256.0           AS range_nm,      -- if you stored raw ASTERIX units
  theta * 360 / 65536.0 AS azimuth_deg,
  squawk                AS mode3a,
  fl                    AS flight_level,
  icao24                AS aircraft_address,
  track_no              AS track_number,
  latitude              AS lat,
  longitude             AS lon
  -- ...add whichever other columns you have
FROM my_radar_table;
```

```bash
DB_PATH=/path/to/your.duckdb TABLE=radar_plots npm start
```

Any extra columns you keep are queryable too. To add your own words for them, use
`COLUMN_ALIASES='{"snr_db": ["snr", "signal to noise"]}'`.

## Live data

The app opens the database **read-only**. Every `RELOAD_CHECK_MS` (default 15 s) it checks whether
the file has changed, and if so re-opens it, clears its cache and refreshes row counts and the
sensor list. Answers marked **Live** in the UI re-run automatically.

DuckDB allows only one process to hold a database file open for writing, and readers cannot open
the file while that process holds it. If your ingest process keeps the file open all the time,
use one of these:

- have the writer open, append and close the file per batch (for example every few seconds), or
- point the app at a snapshot/copy that the writer refreshes (copy, then rename into place, so the app never sees a half-written file).

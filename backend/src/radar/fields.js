// Radar plot schema based on EUROCONTROL ASTERIX Category 048
// ("Monoradar Target Reports"), the open international standard for radar surveillance data.
//
// One row = one target report (plot) from one sensor. Column names are readable, and each
// one records the ASTERIX data item it comes from, so a decoder or ingest pipeline can map
// straight into this table. `aliases` are the words people use in questions.

export const RADAR_TABLE = 'radar_plots';

export const RADAR_FIELDS = [
  { name: 'ts', type: 'TIMESTAMP', item: 'I048/140', desc: 'Time of day of the detection (UTC), combined with the date', aliases: ['time', 'detection time'] },
  { name: 'received_at', type: 'TIMESTAMP', item: '—', desc: 'When the report reached the processing system (optional, used for latency)', aliases: ['reception time', 'arrival time'] },
  { name: 'sac', type: 'SMALLINT', item: 'I048/010 SAC', desc: 'System Area Code of the sensor', aliases: ['system area code'] },
  { name: 'sic', type: 'SMALLINT', item: 'I048/010 SIC', desc: 'System Identification Code of the sensor', aliases: ['system identification code'] },
  { name: 'sensor_id', type: 'VARCHAR', item: 'I048/010', desc: 'Sensor name (from SAC/SIC)', aliases: ['sensor', 'radar', 'station', 'radar station', 'radar site'] },
  { name: 'report_type', type: 'VARCHAR', item: 'I048/020 TYP', desc: 'PSR, SSR, SSR+PSR, MODES_ALLCALL, MODES_ROLLCALL, MODES_ALLCALL+PSR, MODES_ROLLCALL+PSR', aliases: ['detection type', 'plot type', 'target type'] },
  { name: 'simulated', type: 'BOOLEAN', item: 'I048/020 SIM', desc: 'Simulated target report', aliases: [] },
  { name: 'spi', type: 'BOOLEAN', item: 'I048/020 SPI', desc: 'Special Position Identification (ident pressed)', aliases: ['ident'] },
  { name: 'range_nm', type: 'DOUBLE', item: 'I048/040 RHO', desc: 'Measured slant range in nautical miles', aliases: ['range', 'distance', 'rho', 'slant range'] },
  { name: 'azimuth_deg', type: 'DOUBLE', item: 'I048/040 THETA', desc: 'Measured azimuth in degrees (0 = north, clockwise)', aliases: ['azimuth', 'bearing', 'theta'] },
  { name: 'mode3a', type: 'VARCHAR', item: 'I048/070', desc: 'Mode 3/A code (4 octal digits)', aliases: ['squawk', 'mode 3a', 'mode a', 'mode 3/a', 'ssr code', 'code'] },
  { name: 'mode3a_valid', type: 'BOOLEAN', item: 'I048/070 V', desc: 'Mode 3/A code validated', aliases: [] },
  { name: 'mode3a_garbled', type: 'BOOLEAN', item: 'I048/070 G', desc: 'Mode 3/A code garbled', aliases: [] },
  { name: 'flight_level', type: 'DOUBLE', item: 'I048/090', desc: 'Mode C flight level (1 FL = 100 ft)', aliases: ['fl', 'altitude', 'level', 'mode c', 'height'] },
  { name: 'fl_valid', type: 'BOOLEAN', item: 'I048/090 V', desc: 'Flight level validated', aliases: [] },
  { name: 'ssr_replies', type: 'SMALLINT', item: 'I048/130 SRR', desc: 'Number of SSR replies received', aliases: ['replies', 'reply count'] },
  { name: 'ssr_amplitude_dbm', type: 'DOUBLE', item: 'I048/130 SAM', desc: 'Amplitude of SSR replies (dBm)', aliases: ['amplitude', 'ssr amplitude', 'signal strength', 'signal'] },
  { name: 'psr_amplitude_dbm', type: 'DOUBLE', item: 'I048/130 PAM', desc: 'Amplitude of primary plot (dBm)', aliases: ['psr amplitude', 'primary amplitude'] },
  { name: 'aircraft_address', type: 'VARCHAR', item: 'I048/220', desc: 'Mode S 24-bit aircraft address (hex)', aliases: ['aircraft', 'icao address', 'icao', 'mode s address', 'target address', 'target'] },
  { name: 'callsign', type: 'VARCHAR', item: 'I048/240', desc: 'Aircraft identification (callsign)', aliases: ['call sign', 'flight', 'flight id', 'flight number', 'aircraft identification', 'ident code'] },
  { name: 'track_number', type: 'INTEGER', item: 'I048/161', desc: 'Track number (0-4095)', aliases: ['track', 'track no', 'track id'] },
  { name: 'x_nm', type: 'DOUBLE', item: 'I048/042 X', desc: 'Calculated position X (east of sensor), NM', aliases: [] },
  { name: 'y_nm', type: 'DOUBLE', item: 'I048/042 Y', desc: 'Calculated position Y (north of sensor), NM', aliases: [] },
  { name: 'ground_speed_kt', type: 'DOUBLE', item: 'I048/200', desc: 'Calculated ground speed (knots)', aliases: ['speed', 'ground speed', 'velocity', 'gs'] },
  { name: 'heading_deg', type: 'DOUBLE', item: 'I048/200', desc: 'Calculated heading (degrees)', aliases: ['heading', 'course', 'direction'] },
  { name: 'track_status', type: 'VARCHAR', item: 'I048/170 CNF', desc: 'CONFIRMED or TENTATIVE', aliases: ['track state'] },
  { name: 'climb_mode', type: 'VARCHAR', item: 'I048/170 CDM', desc: 'MAINTAINING, CLIMBING, DESCENDING, UNKNOWN', aliases: ['vertical status', 'climb descent mode', 'vertical mode'] },
  { name: 'track_end', type: 'BOOLEAN', item: 'I048/170 TRE', desc: 'Last report of a track', aliases: [] },
  { name: 'ghost', type: 'BOOLEAN', item: 'I048/170 GHO', desc: 'Ghost (false) target track', aliases: [] },
  { name: 'lat', type: 'DOUBLE', item: 'derived (WGS-84)', desc: 'Latitude computed from sensor position + range/azimuth', aliases: ['latitude'] },
  { name: 'lon', type: 'DOUBLE', item: 'derived (WGS-84)', desc: 'Longitude computed from sensor position + range/azimuth', aliases: ['longitude'] },
];

export const RADAR_DDL = `CREATE TABLE IF NOT EXISTS ${RADAR_TABLE} (\n${RADAR_FIELDS.map((f) => `  ${f.name} ${f.type}`).join(',\n')}\n)`;

const byName = new Map(RADAR_FIELDS.map((f) => [f.name, f]));
export const radarField = (name) => byName.get(name);

/** A table counts as "radar" when it has the core CAT048 columns. */
export function isRadarSchema(schema) {
  const names = new Set(schema.columns.map((c) => c.name));
  return ['ts', 'sensor_id', 'range_nm', 'azimuth_deg'].every((n) => names.has(n));
}

export const EMERGENCY_CODES = { '7500': 'unlawful interference (hijack)', '7600': 'radio communication failure', '7700': 'general emergency' };

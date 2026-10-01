// Example questions built from the actual schema, shown in the UI as one-click prompts.
// Midpoint of the lat/lon range: a reasonable default location to ask about.
function busiestPoint(schema) {
  const lat = schema.columns.find((c) => c.name === schema.latColumn);
  const lon = schema.columns.find((c) => c.name === schema.lonColumn);
  return `${((Number(lat.min) + Number(lat.max)) / 2).toFixed(2)}, ${((Number(lon.min) + Number(lon.max)) / 2).toFixed(2)}`;
}

function radarQuestions(schema) {
  const sensors = schema.columns.find((c) => c.name === 'sensor_id')?.values ?? [];
  const s1 = sensors[0] ?? 'Mumbai';
  const s2 = sensors[1] ?? 'Pune';
  const has = (n) => schema.columns.some((c) => c.name === n);
  return [
    'Sensor status',
    'Probability of detection by sensor',
    'Scan period of each radar',
    'Data gaps longer than 60 seconds',
    has('aircraft_address') && 'Registration bias between sensors',
    has('mode3a') && 'Any emergency squawks?',
    `Coverage of ${s1} radar`,
    'Track statistics per sensor',
    has('flight_level') && 'Altitude jumps',
    has('mode3a') && 'Which aircraft changed their squawk code?',
    has('received_at') && 'Latency by sensor',
    'Clutter and false plots by sensor',
    'Hourly plot count by sensor',
    has('aircraft_address') && `How many aircraft did ${s2} radar see?`,
    'Count by report type for each sensor',
    has('flight_level') && has('lat') && `Plots below FL 50 within 30 km of ${busiestPoint(schema)}`,
  ].filter(Boolean);
}

export function suggestQuestions(schema) {
  if (schema.radar) return radarQuestions(schema);
  const cols = schema.columns;
  const geo = [schema.latColumn, schema.lonColumn];
  const nums = cols.filter((c) => c.kind === 'numeric' && !geo.includes(c.name)).map((c) => c.name);
  const cats = cols.filter((c) => c.kind === 'category');
  const metric = nums.find((n) => /max/i.test(n)) ?? nums[0];
  const metric2 = nums.find((n) => /min/i.test(n)) ?? nums[1];
  const cat = cats.find((c) => c.values.length > 2 && c.values.length <= 50) ?? cats[0];
  const entity = cats.find((c) => /id$|machine|device|asset|sensor/i.test(c.name) && c.values.length > 20) ?? cats.at(-1);
  const status = cats.find((c) => /status|state|level/i.test(c.name));
  const bad = status?.values.find((v) => /err|fail|fault|alarm|crit/i.test(v)) ?? status?.values.at(-1);
  const out = ['How many records are there?'];
  if (metric && cat) out.push(`Average ${metric} by ${cat.name}`);
  if (metric && schema.timeColumn) out.push(`Daily trend of ${metric} in the last 30 days`);
  if (metric && entity) out.push(`Which ${entity.name} has the highest ${metric}?`);
  if (status && bad && entity) out.push(`Top 10 ${entity.name} with the most ${bad} ${status.name}`);
  if (metric && cat?.values[0]) out.push(`${metric} summary for ${cat.values[0]} last month`);
  if (metric) out.push(`When was the highest ${metric} recorded?`);
  if (metric) out.push(`Distribution of ${metric}`);
  if (metric && metric2) out.push(`Correlation between ${metric2} and ${metric}`);
  if (schema.latColumn && schema.lonColumn) {
    const lat = cols.find((c) => c.name === schema.latColumn);
    const lon = cols.find((c) => c.name === schema.lonColumn);
    const midLat = ((Number(lat.min) + Number(lat.max)) / 2).toFixed(2);
    const midLon = ((Number(lon.min) + Number(lon.max)) / 2).toFixed(2);
    out.push(`Readings within 50 km of ${midLat}, ${midLon}`);
  }
  if (status && schema.timeColumn) out.push(`Monthly count by ${status.name}`);
  if (metric && cat && cat.values.length >= 2) out.push(`Compare ${cat.values[0]} and ${cat.values[1]} average ${metric} per week`);
  return out;
}

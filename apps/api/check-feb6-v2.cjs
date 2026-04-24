// Check Feb 6 NIFTY 5m candles - verify SL evaluation for DAY_REVERSAL signal
const Database = require('better-sqlite3');
const db = new Database('./dev.db');

// 1. Discover schema
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

const instrCols = db.prepare('PRAGMA table_info(Instrument)').all();
console.log('Instrument cols:', instrCols.map(c => c.name).join(', '));

const cacheTblName = tables.find(t => /cache|candle/i.test(t.name));
if (cacheTblName) {
  const cols = db.prepare(`PRAGMA table_info("${cacheTblName.name}")`).all();
  console.log(cacheTblName.name + ' cols:', cols.map(c => c.name).join(', '));
}

// 2. Find NIFTY 50 token
const tokenCol = instrCols.find(c => /token/i.test(c.name));
const symCol   = instrCols.find(c => /symbol/i.test(c.name));
if (!tokenCol || !symCol) {
  console.log('Cannot determine column names'); db.close(); process.exit(1);
}

const inst = db.prepare(
  `SELECT "${tokenCol.name}", "${symCol.name}" FROM Instrument WHERE "${symCol.name}" = 'NIFTY 50' LIMIT 1`
).get();
console.log('\nNIFTY 50 row:', inst);

if (!inst) {
  const samples = db.prepare(`SELECT "${symCol.name}" FROM Instrument WHERE "${symCol.name}" LIKE '%NIFTY%' LIMIT 5`).all();
  console.log('NIFTY-like symbols:', samples);
  db.close(); process.exit(1);
}

const token = inst[tokenCol.name];
console.log('Token:', token);

// 3. Get Feb 6 candles — try both UTC and IST date ranges
if (!cacheTblName) { console.log('No candle/cache table found'); db.close(); process.exit(1); }

const cacheColsInfo = db.prepare(`PRAGMA table_info("${cacheTblName.name}")`).all();
const tokenFld = cacheColsInfo.find(c => /token/i.test(c.name));
const dateFld  = cacheColsInfo.find(c => /date|time/i.test(c.name));
console.log(`\nUsing table ${cacheTblName.name}, tokenField=${tokenFld?.name}, dateField=${dateFld?.name}`);

// First check how data looks (sample row with all columns)
const sample = db.prepare(`SELECT * FROM "${cacheTblName.name}" WHERE "${tokenFld.name}" = ? LIMIT 1`).get(token);
console.log('\nSample row (token='+token+'):', sample);

if (!sample) {
  // Print a few rows regardless
  const anySample = db.prepare(`SELECT * FROM "${cacheTblName.name}" LIMIT 2`).all();
  console.log('Any rows from cache table:', anySample);
  db.close(); process.exit(1);
}
console.log('\nSample row:', sample);

// Infer OHLC column names from sample row
const sampleKeys = sample ? Object.keys(sample) : [];
console.log('All columns in row:', sampleKeys);
const openFld  = sampleKeys.find(k => /^o(pen)?$/i.test(k)) || 'open';
const highFld  = sampleKeys.find(k => /^h(igh)?$/i.test(k)) || 'high';
const lowFld   = sampleKeys.find(k => /^l(ow)?$/i.test(k)) || 'low';
const closeFld = sampleKeys.find(k => /^c(lose)?$/i.test(k)) || 'close';
console.log(`OHLC fields: open=${openFld} high=${highFld} low=${lowFld} close=${closeFld}`);

// Fetch full Feb 6 day (IST Feb 6 = UTC Feb 5 18:30 to Feb 6 10:30)
const candles = db.prepare(
  `SELECT "${dateFld.name}" as date, "${openFld}" as open, "${highFld}" as high, "${lowFld}" as low, "${closeFld}" as close
   FROM "${cacheTblName.name}"
   WHERE "${tokenFld.name}" = ?
     AND "${dateFld.name}" >= '2026-02-05T18:00'
     AND "${dateFld.name}" <  '2026-02-06T10:30'
   ORDER BY "${dateFld.name}" ASC`
).all(token);

console.log('\nFeb 6 total 5m candles:', candles.length);

if (candles.length === 0) {
  // Try without time component
  const candles2 = db.prepare(
    `SELECT "${dateFld.name}" as date, open, high, low, close
     FROM "${cacheTblName.name}"
     WHERE "${tokenFld.name}" = ?
     ORDER BY "${dateFld.name}" DESC LIMIT 20`
  ).all(token);
  console.log('Latest candles in DB:', candles2.map(r => r.date));
  db.close(); process.exit(0);
}

// Signal info
const ENTRY = 25593.95;
const SL = 25662.90;
const T1 = 25524.95;

const toIST = (s) => {
  const d = new Date(s);
  d.setMinutes(d.getMinutes() + 330);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
};

console.log(`\nSignal @ ~12:05 | Entry=${ENTRY} SL=${SL} T1=${T1}`);
console.log('Time  | Open     | High     | Low      | Close    | SL?  | T1?');
console.log('------+----------+----------+----------+----------+------+----');

let outcome = 'OPEN';
let signalPassed = false;

for (const c of candles) {
  const ist = toIST(c.date);
  const [h, mn] = ist.split(':').map(Number);
  const mins = h * 60 + mn;

  // Signal candle is at 12:05 (mins=725); scan starts from 12:10 (mins=730)
  if (mins === 725) { signalPassed = true; }
  if (!signalPassed) continue;
  if (mins === 725) continue; // skip the signal candle itself

  const slHit = c.high >= SL;
  const t1Hit = c.low <= T1;
  const note = slHit ? '*** SL HIT ***' : (t1Hit ? '*** T1 HIT ***' : '');

  console.log(
    `${ist.padStart(5)} | ${String(c.open).padEnd(8)} | ${String(c.high).padEnd(8)} | ${String(c.low).padEnd(8)} | ${String(c.close).padEnd(8)} | ${slHit ? 'YES ' : 'no  '} | ${t1Hit ? 'YES' : ''} ${note}`
  );

  if (slHit) { outcome = 'SL'; break; }
  if (t1Hit) { outcome = 'T1'; break; }
}

console.log('\n=== OUTCOME:', outcome, '===');
db.close();

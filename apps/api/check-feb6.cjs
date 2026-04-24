// Check Feb 6 NIFTY 5m candles - verify SL evaluation for DAY_REVERSAL signal
const Database = require('better-sqlite3');
const db = new Database('./dev.db');

// Discover schema first
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

const instrCols = db.prepare('PRAGMA table_info(Instrument)').all();
console.log('Instrument cols:', instrCols.map(c => c.name).join(', '));

const cacheTbl = tables.find(t => t.name.toLowerCase().includes('cache') || t.name.toLowerCase().includes('candle'));
if (cacheTbl) {
  const cacheCols = db.prepare(`PRAGMA table_info(${cacheTbl.name})`).all();
  console.log(cacheTbl.name + ' cols:', cacheCols.map(c => c.name).join(', '));
}

db.close();
console.log('NIFTY 50:', inst);

if (!inst) {
  console.log('Instrument not found. Listing all instruments...');
  const all = db.prepare("SELECT instrument_token, tradingsymbol FROM Instrument WHERE tradingsymbol LIKE '%NIFTY%' LIMIT 10").all();
  console.log(all);
  db.close();
  process.exit(1);
}

// 2. Get Feb 6 5m candles from CandleCache
// Date stored as ISO string in SQLite; Feb 6 IST = Feb 5 18:15 UTC to Feb 6 09:59 UTC
let candles;
try {
  candles = db.prepare(
    `SELECT date, open, high, low, close
     FROM CandleCache
     WHERE instrumentToken = ?
       AND date >= '2026-02-05T18:00:00'
       AND date <  '2026-02-06T11:00:00'
     ORDER BY date ASC`
  ).all(inst.instrument_token);
} catch(e) {
  console.log('CandleCache query failed:', e.message);
  // Try alternate table name
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables.map(t=>t.name));
  db.close();
  process.exit(1);
}

console.log('\nFeb 6 total 5m candles:', candles.length);

if (candles.length === 0) {
  console.log('No data found for Feb 6.');
  db.close();
  process.exit(0);
}

// Signal from screenshot:
// Entry (signal candle) = 12:05, entryPrice = 25593.95
// SL = 25662.90, Risk = 69.0 pts
// T1 = 25593.95 - 69 = 25524.95
const ENTRY = 25593.95;
const SL = 25662.90;
const T1 = 25524.95;
const T2 = 25455.95;
const T3 = 25386.95;

// Convert UTC stored dates to IST for display
const toIST = (utcStr) => {
  const d = new Date(utcStr);
  d.setMinutes(d.getMinutes() + 330);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0');
};

console.log(`\nSignal @ 12:05 | Entry=${ENTRY} SL=${SL} T1=${T1} T2=${T2} T3=${T3}`);
console.log('Scanning candles AFTER signal candle (12:05):');
console.log('Time  | Open     | High     | Low      | Close    | Note');

let outcome = 'OPEN';
let t1Hit = false;

for (const c of candles) {
  const ist = toIST(c.date);
  const [h, m] = ist.split(':').map(Number);
  const mins = h * 60 + m;

  if (mins <= 725) continue; // skip up to and including 12:05 signal candle

  const notes = [];
  if (!t1Hit && c.low <= T1) { notes.push('T1 HIT'); t1Hit = true; outcome = 'T1'; }
  if (!t1Hit && c.high >= SL)  { notes.push('SL HIT'); outcome = 'SL'; }
  if (t1Hit && c.high >= ENTRY) { notes.push('BE (SL moved to entry)'); outcome = 'BE'; }
  if (t1Hit && c.low <= T2) { notes.push('T2 HIT'); outcome = 'T2'; }
  if (t1Hit && c.low <= T3) { notes.push('T3 HIT'); outcome = 'T3'; }

  console.log(
    `${ist.padStart(5)} | ${String(c.open).padEnd(8)} | ${String(c.high).padEnd(8)} | ${String(c.low).padEnd(8)} | ${String(c.close).padEnd(8)} | ${notes.join(', ')}`
  );

  if (outcome === 'SL' || outcome === 'BE' || outcome === 'T2' || outcome === 'T3') break;
}

console.log('\n=== FINAL OUTCOME:', outcome, '===');

db.close();

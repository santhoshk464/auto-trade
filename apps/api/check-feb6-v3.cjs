// Check Feb 6 NIFTY 5m candles - verify SL evaluation for DAY_REVERSAL signal
// CandleCache stores: instrumentToken, dateStr, interval, candlesJson (JSON array)
const Database = require('better-sqlite3');
const db = new Database('./dev.db');

// NIFTY 50 instrumentToken = 256265 (confirmed from schema)
const TOKEN = 256265;

// Check what dates are available for NIFTY 50
const dates = db.prepare(
  `SELECT dateStr, interval FROM CandleCache WHERE instrumentToken = ? ORDER BY dateStr DESC LIMIT 10`
).all(TOKEN);
console.log('Available NIFTY 50 cache dates:', dates);

// Fetch Feb 6 5-minute candles
const row = db.prepare(
  `SELECT candlesJson FROM CandleCache WHERE instrumentToken = ? AND dateStr = '2026-02-06' AND interval = '5minute' LIMIT 1`
).get(TOKEN);

if (!row) {
  console.log('\nNo 5minute row for Feb 6. Trying other intervals...');
  const rows = db.prepare(
    `SELECT dateStr, interval, length(candlesJson) as jsonLen FROM CandleCache WHERE instrumentToken = ? AND dateStr LIKE '2026-02%'`
  ).all(TOKEN);
  console.log('Feb rows:', rows);
  db.close(); process.exit(0);
}

const candles = JSON.parse(row.candlesJson);
console.log('\nFeb 6 5m candles total:', candles.length);

// Signal details from screenshot
const ENTRY = 25593.95;
const SL = 25662.90;
const RISK = 69.0;
const T1 = ENTRY - RISK;  // 25524.95
const T2 = T1 - RISK;     // 25455.95

const toIST = (utcStr) => {
  const d = new Date(utcStr);
  d.setMinutes(d.getMinutes() + 330);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
};

// Show all candles from 9:25 onwards
console.log('\nAll candles from 9:25 IST:');
console.log('Time  | Open      | High      | Low       | Close     | SL? T1?');
console.log('------+-----------+-----------+-----------+-----------+---------');

for (const c of candles) {
  const ist = toIST(c.date);
  const [h, mn] = ist.split(':').map(Number);
  const mins = h * 60 + mn;
  if (mins < 565) continue; // 9:25 AM

  const slHit = c.high >= SL;
  const t1Hit = c.low <= T1;
  const note = slHit ? ' <<< SL HIT' : (t1Hit ? ' <<< T1 HIT' : '');
  const star = (mins >= 725) ? '' : ''; // after signal time

  console.log(
    `${ist.padStart(5)} | ${String(c.open).padEnd(9)} | ${String(c.high).padEnd(9)} | ${String(c.low).padEnd(9)} | ${String(c.close).padEnd(9)} |${note}`
  );
}

// Also explicitly scan from signal time
console.log('\n--- POST-SIGNAL scan (from 12:10 onwards): SL=' + SL + ' T1=' + T1);
let outcome = 'OPEN';
for (const c of candles) {
  const ist = toIST(c.date);
  const [h, mn] = ist.split(':').map(Number);
  const mins = h * 60 + mn;
  if (mins <= 725) continue; // strictly after 12:05

  if (c.high >= SL)  { console.log(`  ${ist}: HIGH=${c.high} >= SL=${SL} -> SL HIT!`); outcome = 'SL'; break; }
  if (c.low  <= T1)  { console.log(`  ${ist}: LOW=${c.low} <= T1=${T1} -> T1 HIT`);  outcome = 'T1'; break; }
}
console.log('\n=== POST-SIGNAL OUTCOME:', outcome, '===');

db.close();

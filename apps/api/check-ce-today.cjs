// Check today's CE complementary buy - did it reach T1?
const Database = require('better-sqlite3');
const db = new Database('./dev.db');

// Find 5minute CE candles for today
const row = db.prepare(
  "SELECT instrumentToken, tradingsymbol, candlesJson FROM CandleCache WHERE tradingsymbol='NIFTY26APR24350CE' AND dateStr='2026-04-22' AND interval='5minute' LIMIT 1"
).get();

if (!row) {
  console.log('CE candle data not found');
  const all = db.prepare("SELECT tradingsymbol, dateStr, interval FROM CandleCache WHERE dateStr='2026-04-22' LIMIT 10").all();
  console.log('Available today:', all);
  db.close(); process.exit(0);
}

const candles = JSON.parse(row.candlesJson);
console.log('CE total candles today:', candles.length);

// From screenshot: SELL PE signal at 10:25am, CE entry=238, sellRisk=26.95
const ENTRY = 238.00;
const sellRisk = 26.95;
const SL     = ENTRY - sellRisk;          // 211.05
const T1     = ENTRY + sellRisk * 2;      // 291.90
const T2     = ENTRY + sellRisk * 3;      // 318.85
const T3     = ENTRY + sellRisk * 4;      // 345.80

console.log('\nCE entry='+ENTRY+' SL='+SL.toFixed(2)+' T1='+T1.toFixed(2)+' T2='+T2.toFixed(2)+' T3='+T3.toFixed(2));
console.log('\nCandles from 10:25 onwards:');
console.log('Time  | Open    | High    | Low     | Close   | Note');
console.log('------+---------+---------+---------+---------+------');

let signalPassed = false;
let dayHigh = 0;

for (const c of candles) {
  const d = new Date(c.date);
  d.setMinutes(d.getMinutes() + 330);
  const h = d.getHours(), mn = d.getMinutes();
  const mins = h * 60 + mn;
  const t = h + ':' + String(mn).padStart(2, '0');

  if (mins >= 625) signalPassed = true; // 10:25 = 10*60+25=625
  if (!signalPassed) continue;

  if (c.high > dayHigh) dayHigh = c.high;

  const notes = [];
  if (c.high >= T1) notes.push('*** T1 HIT ***');
  if (c.low  <= SL) notes.push('SL hit');

  console.log(
    t.padStart(5) + ' | ' +
    String(c.open).padEnd(7) + ' | ' +
    String(c.high).padEnd(7) + ' | ' +
    String(c.low).padEnd(7) + ' | ' +
    String(c.close).padEnd(7) + ' | ' +
    notes.join(', ')
  );
}

console.log('\nMax CE high after signal:', dayHigh);
console.log('T1 needed:', T1.toFixed(2), '→', dayHigh >= T1 ? 'REACHED' : 'NOT reached (max was '+dayHigh+')');

db.close();

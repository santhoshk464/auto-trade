const Database = require('better-sqlite3');
const { KiteConnect } = require('kiteconnect');
const path = require('path');

const db = new Database(path.join(__dirname, 'dev.db'), { readonly: true });

async function main() {
  // Get broker with access token
  const broker = db
    .prepare(
      'SELECT apiKey, accessToken, name FROM Broker WHERE accessToken IS NOT NULL LIMIT 1',
    )
    .get();

  if (!broker) {
    console.log('No broker with access token found');
    return;
  }
  console.log('Using broker:', broker.name);

  const kc = new KiteConnect({ api_key: broker.apiKey });
  kc.setAccessToken(broker.accessToken);

  // Find NIFTY2631024600PE instrument token
  const instrument = db
    .prepare(
      "SELECT instrumentToken, tradingsymbol FROM Instrument WHERE tradingsymbol = 'NIFTY2631024600PE' LIMIT 1",
    )
    .get();

  if (!instrument) {
    console.log(
      'Instrument NIFTY2631024600PE not found in DB, searching similar...',
    );
    const similar = db
      .prepare(
        "SELECT instrumentToken, tradingsymbol FROM Instrument WHERE tradingsymbol LIKE 'NIFTY2631024600%' LIMIT 10",
      )
      .all();
    console.log('Similar instruments:', similar);
    db.close();
    return;
  }

  console.log('Instrument token:', instrument.instrumentToken);

  // Fetch 5-min candles for March 4 2026
  const candles = await kc.getHistoricalData(
    instrument.instrumentToken,
    '5minute',
    '2026-03-04 09:15:00',
    '2026-03-04 15:30:00',
  );

  if (!candles || candles.length === 0) {
    console.log('No candle data returned');
    db.close();
    return;
  }

  // IST offset: Kite returns UTC, we add 5h30m to display IST
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;

  console.log('\n==== NIFTY2631024600PE - March 4, 2026 - 5min Candles ====');
  console.log(
    'Time '.padEnd(6),
    'Open  '.padEnd(8),
    'High  '.padEnd(8),
    'Low   '.padEnd(8),
    'Close '.padEnd(8),
    'Body '.padEnd(7),
    'UWick'.padEnd(7),
    'LWick'.padEnd(7),
    'Clr   ',
    'Notes',
  );
  console.log('-'.repeat(100));

  const dayHigh915 = candles[0].high;
  let runningHigh = 0;

  candles.forEach((c, i) => {
    const date = c.date instanceof Date ? c.date : new Date(c.date);
    const istDate = new Date(date.getTime() + IST_OFFSET_MS);
    const hhmm = `${String(istDate.getUTCHours()).padStart(2, '0')}:${String(istDate.getUTCMinutes()).padStart(2, '0')}`;

    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const range = c.high - c.low;
    const color = c.close >= c.open ? 'GRN' : 'RED';
    const prevHigh = i > 0 ? candles[i - 1].high : 0;
    const isNewHigh = c.high > runningHigh;
    if (isNewHigh) runningHigh = c.high;

    const flags = [];
    if (i === 0) flags.push('DAY-OPEN');
    if (isNewHigh && i > 0) flags.push('NEW-HIGH');
    if (Math.abs(c.high - dayHigh915) <= 3 || c.high >= dayHigh915 - 5) {
      if (upperWick > body * 1.5 && upperWick > range * 0.35)
        flags.push('** WICK-REJECTION **');
    }
    if (color === 'RED' && body > range * 0.5 && c.high >= dayHigh915 - 5)
      flags.push('** STRONG-RED@HIGH **');
    if (Math.abs(c.high - prevHigh) <= 3 && i > 1)
      flags.push('TESTS-PREV-HIGH');
    const isDoji = body < range * 0.1 && range > 0;
    if (isDoji) flags.push('DOJI');

    console.log(
      hhmm.padEnd(6),
      c.open.toFixed(2).padEnd(8),
      c.high.toFixed(2).padEnd(8),
      c.low.toFixed(2).padEnd(8),
      c.close.toFixed(2).padEnd(8),
      body.toFixed(1).padEnd(7),
      upperWick.toFixed(1).padEnd(7),
      lowerWick.toFixed(1).padEnd(7),
      color.padEnd(6),
      flags.join(' | '),
    );
  });

  console.log('\n--- Summary ---');
  console.log('9:15 AM Open :', candles[0].open.toFixed(2));
  console.log('9:15 AM High :', dayHigh915.toFixed(2), '<-- DAY HIGH at open');
  console.log('All-day High :', runningHigh.toFixed(2));

  db.close();
}

main().catch((e) => {
  console.error(e);
  db.close();
});

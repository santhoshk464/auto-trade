'use strict';
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
    db.close();
    return;
  }
  console.log('Using broker:', broker.name);

  // NIFTY APR 24400 PE - Monthly April 2026 contract (expiry: 2026-04-28)
  const instrument = db
    .prepare(
      "SELECT instrumentToken, tradingsymbol, expiry, strike FROM Instrument WHERE tradingsymbol = 'NIFTY26APR24400PE' LIMIT 1",
    )
    .get();

  if (!instrument) {
    console.log('Instrument NIFTY26APR24400PE not found in DB');
    db.close();
    return;
  }

  console.log(
    `Found: ${instrument.tradingsymbol} -> token=${instrument.instrumentToken}, expiry=${instrument.expiry}`,
  );

  console.log('\nInstrument token:', instrument.instrumentToken);
  console.log('Trading symbol:', instrument.tradingsymbol);
  console.log('Expiry:', instrument.expiry);

  const kc = new KiteConnect({ api_key: broker.apiKey });
  kc.setAccessToken(broker.accessToken);

  // Fetch 5-min candles for today April 22, 2026
  const date = '2026-04-22';
  const from = `${date} 09:15:00`;
  const to = `${date} 15:30:00`;

  console.log(`\nFetching 5-minute candles for ${date}...`);
  let candles;
  try {
    candles = await kc.getHistoricalData(
      instrument.instrumentToken,
      '5minute',
      from,
      to,
    );
  } catch (err) {
    console.error('Error fetching candle data:', err.message || err);
    db.close();
    return;
  }

  if (!candles || candles.length === 0) {
    console.log('No candle data returned from Kite API');
    db.close();
    return;
  }

  // IST = UTC + 5:30
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;

  function toIST(date) {
    const d = new Date(new Date(date).getTime() + IST_OFFSET_MS);
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }

  function candleType(open, close) {
    const body = close - open;
    if (Math.abs(body) < 0.5) return 'DOJI';
    return body > 0 ? 'BULL' : 'BEAR';
  }

  function fmt(n) {
    return n.toFixed(2).padStart(8);
  }

  console.log(
    '\n====================================================================',
  );
  console.log(`  NIFTY APR 24400 PE (${instrument.tradingsymbol})`);
  console.log(`  Date: ${date}  |  Token: ${instrument.instrumentToken}`);
  console.log(
    '====================================================================',
  );
  console.log(
    'IST Time  |  Open   |  High   |  Low    |  Close  |  Body   | UWick  | LWick  | Vol      | Type | Flag',
  );
  console.log('-'.repeat(110));

  const targetTimes = ['10:20', '10:25'];
  const targetCandles = {};

  for (const c of candles) {
    const istTime = toIST(c.date);
    const timeOnly = istTime.slice(11, 16);
    const open = c.open;
    const high = c.high;
    const low = c.low;
    const close = c.close;
    const body = close - open;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const type = candleType(open, close);
    const isTarget = targetTimes.includes(timeOnly);
    const flag = isTarget ? ' <===' : '';

    if (isTarget) {
      targetCandles[timeOnly] = {
        open,
        high,
        low,
        close,
        body,
        upperWick,
        lowerWick,
        type,
        volume: c.volume,
      };
    }

    // Show all candles from 9:15 to 11:00 for context
    const [h, m] = timeOnly.split(':').map(Number);
    if (h < 9 || (h === 9 && m < 15) || h > 11) continue;

    console.log(
      `${timeOnly.padEnd(9)} | ${fmt(open)} | ${fmt(high)} | ${fmt(low)} | ${fmt(close)} | ${fmt(body)} | ${fmt(upperWick)} | ${fmt(lowerWick)} | ${String(c.volume || 0).padStart(8)} | ${type.padEnd(4)} |${flag}`,
    );
  }

  console.log(
    '\n====================================================================',
  );
  console.log('  DETAILED ANALYSIS: 10:20 AM and 10:25 AM Target Candles');
  console.log(
    '====================================================================',
  );

  for (const time of targetTimes) {
    const c = targetCandles[time];
    if (!c) {
      console.log(`\n${time} AM candle: NOT FOUND in data`);
      continue;
    }
    const bodyPct = (Math.abs(c.body) / (c.high - c.low)) * 100;
    const totalRange = c.high - c.low;
    console.log(`\n  [${time} AM Candle]`);
    console.log(`  Type        : ${c.type}`);
    console.log(`  Open        : ${c.open.toFixed(2)}`);
    console.log(`  High        : ${c.high.toFixed(2)}`);
    console.log(`  Low         : ${c.low.toFixed(2)}`);
    console.log(`  Close       : ${c.close.toFixed(2)}`);
    console.log(
      `  Body        : ${c.body.toFixed(2)} (${c.body > 0 ? 'Bullish' : 'Bearish'})`,
    );
    console.log(`  Upper Wick  : ${c.upperWick.toFixed(2)}`);
    console.log(`  Lower Wick  : ${c.lowerWick.toFixed(2)}`);
    console.log(`  Total Range : ${totalRange.toFixed(2)}`);
    console.log(`  Body %      : ${bodyPct.toFixed(1)}% of total range`);
    console.log(`  Volume      : ${c.volume}`);

    // Candle pattern analysis
    const isShootingStar =
      c.upperWick > Math.abs(c.body) * 2 &&
      c.lowerWick < Math.abs(c.body) * 0.5;
    const isHammer =
      c.lowerWick > Math.abs(c.body) * 2 &&
      c.upperWick < Math.abs(c.body) * 0.5;
    const isDojiStar = bodyPct < 10;
    const isStrongBear = c.type === 'BEAR' && bodyPct > 60;
    const isStrongBull = c.type === 'BULL' && bodyPct > 60;
    const hasBearishRejection =
      c.type === 'BEAR' && c.upperWick > Math.abs(c.body);
    const hasLongUpperWick = c.upperWick > totalRange * 0.4;

    console.log(`\n  Pattern Signals:`);
    if (isShootingStar)
      console.log(
        `  >> SHOOTING STAR - Bearish reversal signal (long upper wick)`,
      );
    if (isHammer)
      console.log(`  >> HAMMER - Bullish reversal signal (long lower wick)`);
    if (isDojiStar) console.log(`  >> DOJI - Indecision, potential reversal`);
    if (isStrongBear)
      console.log(`  >> STRONG BEARISH candle (body > 60% of range)`);
    if (isStrongBull)
      console.log(`  >> STRONG BULLISH candle (body > 60% of range)`);
    if (hasBearishRejection)
      console.log(`  >> BEARISH REJECTION - Upper wick exceeds body`);
    if (hasLongUpperWick)
      console.log(`  >> LONG UPPER WICK - Price rejected from high zone`);
    if (
      !isShootingStar &&
      !isHammer &&
      !isDojiStar &&
      !isStrongBear &&
      !isStrongBull &&
      !hasBearishRejection &&
      !hasLongUpperWick
    ) {
      console.log(`  >> Normal candle, no strong pattern`);
    }
  }

  // Reversal context: compare 10:20 and 10:25
  if (targetCandles['10:20'] && targetCandles['10:25']) {
    const c1 = targetCandles['10:20'];
    const c2 = targetCandles['10:25'];
    console.log(
      '\n====================================================================',
    );
    console.log('  REVERSAL CONTEXT (10:20 → 10:25)');
    console.log(
      '====================================================================',
    );
    const priceChange = c2.close - c1.close;
    const highDrop = c2.high - c1.high;
    const twoCandelBodyDir =
      c1.type === 'BEAR' && c2.type === 'BEAR'
        ? 'BOTH BEARISH (strong sell)'
        : c1.type === 'BULL' && c2.type === 'BEAR'
          ? 'BULL→BEAR reversal'
          : c1.type === 'BEAR' && c2.type === 'BULL'
            ? 'BEAR→BULL bounce'
            : 'BOTH BULLISH';
    console.log(`  10:20 close : ${c1.close.toFixed(2)}`);
    console.log(`  10:25 close : ${c2.close.toFixed(2)}`);
    console.log(
      `  Price change: ${priceChange.toFixed(2)} (${priceChange >= 0 ? 'UP' : 'DOWN'})`,
    );
    console.log(`  High change : ${highDrop.toFixed(2)}`);
    console.log(`  Candle combo: ${twoCandelBodyDir}`);

    const isReversalSetup =
      (c1.upperWick > Math.abs(c1.body) * 1.5 || c1.type === 'BEAR') &&
      (c2.type === 'BEAR' || c2.close < c1.open);
    console.log(
      `\n  Day Reversal Setup: ${isReversalSetup ? 'YES - Potential entry signal' : 'NO - Not a clean reversal setup'}`,
    );

    if (isReversalSetup) {
      const entryPrice = c2.close;
      const stopLoss = c1.high;
      const target = entryPrice - (stopLoss - entryPrice) * 2;
      console.log(
        `\n  >> Entry  : ${entryPrice.toFixed(2)} (on close of 10:25 candle)`,
      );
      console.log(`  >> SL     : ${stopLoss.toFixed(2)} (10:20 candle high)`);
      console.log(`  >> Target : ${target.toFixed(2)} (2:1 RR)`);
      console.log(`  >> Risk   : ${(stopLoss - entryPrice).toFixed(2)} pts`);
    }
  }

  console.log(
    '\n====================================================================',
  );
  console.log('  ALL CANDLES LOG (for further analysis)');
  console.log(
    '====================================================================',
  );
  console.log(
    JSON.stringify(
      candles.map((c) => ({
        time: toIST(c.date).slice(11, 16),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
      null,
      2,
    ),
  );

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

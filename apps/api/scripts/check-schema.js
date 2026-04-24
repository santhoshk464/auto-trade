/**
 * Checks all schema columns exist in the DB and reports missing ones.
 * Run: node scripts/check-schema.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'dev.db');
const db = new Database(dbPath);

const expected = {
  TradingSettings: [
    'id',
    'userId',
    'symbol',
    'hedgeLots',
    'sellLots',
    'paperLots',
    'bufferPoints',
    'liveEnabled',
    'minSellRsi',
    'maxSellRiskPts',
    'placeQtyBasedOnSL',
    'perTradeLoss',
    'perDayLoss',
    'enableNiftyTrendFilter',
    'createdAt',
    'updatedAt',
  ],
  StrikeSelection: [
    'id',
    'brokerId',
    'symbol',
    'date',
    'expiry',
    'niftySpotAtOpen',
    'atmStrike',
    'ceTradingSymbol',
    'ceStrike',
    'ceInstrumentToken',
    'peTradingSymbol',
    'peStrike',
    'peInstrumentToken',
    'selectedAt',
  ],
  CandleCache: [
    'id',
    'instrumentToken',
    'tradingsymbol',
    'dateStr',
    'interval',
    'candlesJson',
    'savedAt',
    'createdAt',
  ],
  Signal: [
    'id',
    'userId',
    'brokerId',
    'symbol',
    'optionSymbol',
    'instrumentToken',
    'strike',
    'optionType',
    'expiryDate',
    'signalType',
    'strategy',
    'signalReason',
    'signalTime',
    'signalDate',
    'entryPrice',
    'stopLoss',
    'target1',
    'target2',
    'target3',
    'ltp',
    'marginPoints',
    'interval',
    'targetDate',
    'tradeCreated',
    'paperTradeId',
    'createdAt',
    'updatedAt',
  ],
  PaperTrade: [
    'id',
    'userId',
    'brokerId',
    'symbol',
    'optionSymbol',
    'instrumentToken',
    'strike',
    'optionType',
    'expiryDate',
    'signalType',
    'strategy',
    'signalReason',
    'entryPrice',
    'entryTime',
    'quantity',
    'exitPrice',
    'exitTime',
    'stopLoss',
    'target1',
    'target2',
    'target3',
    't1Hit',
    'status',
    'pnl',
    'pnlPercentage',
    'marginPoints',
    'interval',
    'createdAt',
    'updatedAt',
  ],
};

let allOk = true;
for (const [table, cols] of Object.entries(expected)) {
  let actual;
  try {
    actual = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((r) => r.name);
  } catch (e) {
    console.log(`❌ Table MISSING: ${table}`);
    allOk = false;
    continue;
  }
  const missing = cols.filter((c) => !actual.includes(c));
  if (missing.length > 0) {
    console.log(`❌ ${table} missing columns: ${missing.join(', ')}`);
    allOk = false;
  } else {
    console.log(`✅ ${table} — all columns present`);
  }
}

db.close();
if (allOk) console.log('\n✅ Schema is fully in sync');
else console.log('\n⚠️  Run fix-schema.js to add missing columns');

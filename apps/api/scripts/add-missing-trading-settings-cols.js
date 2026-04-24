const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'dev.db');
const db = new Database(dbPath);

const cols = db.pragma('table_info(TradingSettings)').map((c) => c.name);

const additions = [
  {
    name: 'placeQtyBasedOnSL',
    sql: 'ALTER TABLE "TradingSettings" ADD COLUMN "placeQtyBasedOnSL" BOOLEAN NOT NULL DEFAULT 0',
  },
  {
    name: 'perTradeLoss',
    sql: 'ALTER TABLE "TradingSettings" ADD COLUMN "perTradeLoss" REAL NOT NULL DEFAULT 20000',
  },
  {
    name: 'perDayLoss',
    sql: 'ALTER TABLE "TradingSettings" ADD COLUMN "perDayLoss" REAL NOT NULL DEFAULT 40000',
  },
  {
    name: 'enableNiftyTrendFilter',
    sql: 'ALTER TABLE "TradingSettings" ADD COLUMN "enableNiftyTrendFilter" BOOLEAN NOT NULL DEFAULT 0',
  },
];

for (const col of additions) {
  if (cols.includes(col.name)) {
    console.log(`  SKIP (already exists): ${col.name}`);
  } else {
    db.exec(col.sql);
    console.log(`  ADDED: ${col.name}`);
  }
}

const finalCols = db.pragma('table_info(TradingSettings)').map((c) => c.name);
console.log('\nFinal columns:', finalCols.join(', '));
db.close();

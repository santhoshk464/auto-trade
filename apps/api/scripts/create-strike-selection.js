/**
 * Creates the missing StrikeSelection table in dev.db.
 * Run: node scripts/create-strike-selection.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'dev.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "StrikeSelection" (
      "id"                TEXT    NOT NULL PRIMARY KEY,
      "brokerId"          TEXT    NOT NULL,
      "symbol"            TEXT    NOT NULL,
      "date"              TEXT    NOT NULL,
      "expiry"            TEXT    NOT NULL,
      "niftySpotAtOpen"   REAL    NOT NULL,
      "atmStrike"         INTEGER NOT NULL,
      "ceTradingSymbol"   TEXT    NOT NULL,
      "ceStrike"          INTEGER NOT NULL,
      "ceInstrumentToken" INTEGER NOT NULL,
      "peTradingSymbol"   TEXT    NOT NULL,
      "peStrike"          INTEGER NOT NULL,
      "peInstrumentToken" INTEGER NOT NULL,
      "selectedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "StrikeSelection_brokerId_fkey"
        FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  console.log('✅ StrikeSelection table created');

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS "StrikeSelection_brokerId_symbol_date_key" ON "StrikeSelection"("brokerId","symbol","date")`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS "StrikeSelection_brokerId_idx" ON "StrikeSelection"("brokerId")`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS "StrikeSelection_date_idx" ON "StrikeSelection"("date")`,
  );
  console.log('✅ Indexes created');
} catch (err) {
  if (err.message.includes('already exists')) {
    console.log('⚠️  StrikeSelection already exists — skipping');
  } else {
    console.error('❌ Error:', err.message);
  }
}

db.pragma('foreign_keys = ON');
db.close();
console.log('Done.');

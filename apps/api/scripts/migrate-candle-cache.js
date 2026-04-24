// One-time migration: add tradingsymbol + savedAt columns to CandleCache
// Run: node scripts/migrate-candle-cache.js
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'dev.db');
const db = new Database(dbPath);

try {
  db.exec(
    'ALTER TABLE CandleCache ADD COLUMN tradingsymbol TEXT NOT NULL DEFAULT ""',
  );
  console.log('✅ Added tradingsymbol column');
} catch (e) {
  console.log('tradingsymbol column:', e.message);
}

try {
  db.exec(
    'ALTER TABLE CandleCache ADD COLUMN savedAt DATETIME NOT NULL DEFAULT (datetime("now"))',
  );
  console.log('✅ Added savedAt column');
} catch (e) {
  console.log('savedAt column:', e.message);
}

try {
  db.exec(
    'CREATE INDEX IF NOT EXISTS CandleCache_tradingsymbol_idx ON CandleCache(tradingsymbol)',
  );
  console.log('✅ Added tradingsymbol index');
} catch (e) {
  console.log('index:', e.message);
}

db.close();
console.log('Done.');

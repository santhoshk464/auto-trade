/**
 * export-db.cjs
 * Exports safe, non-sensitive DB data to prisma/seed-data.json.
 *
 * Skipped tables:
 *   - Instrument   (206k+ rows, re-sync via: npx ts-node scripts/sync-instruments.ts)
 *   - CandleCache  (ephemeral cache, not needed)
 *   - Trade / PaperTrade / Signal (session data, starts fresh)
 *   - _prisma_migrations (managed by Prisma)
 *   - sqlite_sequence   (internal)
 *
 * Sensitive fields stripped:
 *   - Broker.accessToken  (must reconnect via Kite OAuth on new machine)
 *   - PasswordResetToken  (transient, not needed)
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '../dev.db'));

// Tables to export (safe, small, useful)
const EXPORT_TABLES = ['User', 'Broker', 'TradingSettings'];

const exportData = {};

EXPORT_TABLES.forEach((table) => {
  try {
    let rows = db.prepare('SELECT * FROM "' + table + '"').all();

    // Strip sensitive fields from Broker
    if (table === 'Broker') {
      rows = rows.map((r) => ({ ...r, accessToken: null }));
    }

    exportData[table] = rows;
    console.log(table + ': ' + rows.length + ' rows exported');
  } catch (e) {
    console.warn('Skipping ' + table + ': ' + e.message);
  }
});

const outFile = path.join(__dirname, '../prisma/seed-data.json');
fs.writeFileSync(outFile, JSON.stringify(exportData, null, 2), 'utf8');

db.close();
console.log('\nExported to prisma/seed-data.json');
console.log(
  'NOTE: Instruments are NOT exported. Run sync-instruments.ts on the new machine.',
);
console.log(
  'NOTE: Broker.accessToken was cleared — reconnect via Kite OAuth after setup.',
);

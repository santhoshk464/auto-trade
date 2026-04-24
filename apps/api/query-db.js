const Database = require('better-sqlite3');
const db = new Database('./prisma/dev.db');

// List tables
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all();
console.log('Tables:', tables.map((t) => t.name).join(', '));

// Try to find candle table
const candleTable = tables.find((t) => t.name.toLowerCase().includes('candle'));
if (candleTable) {
  console.log('\nCandle table:', candleTable.name);
  const rows = db
    .prepare(
      `SELECT * FROM "${candleTable.name}" ORDER BY dateStr DESC, instrumentToken LIMIT 30`,
    )
    .all();
  console.table(
    rows.map((r) => ({
      ...r,
      candlesJson: r.candlesJson ? r.candlesJson.length + ' chars' : null,
    })),
  );
}
db.close();

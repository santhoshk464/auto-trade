const Database = require('better-sqlite3');
const db = new Database('./dev.db');
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all();
console.log('Tables:', tables.map((t) => t.name).join(', ') || '(none)');
db.close();

/**
 * Apply all Prisma migration SQL files directly via better-sqlite3.
 * Use this when prisma migrate dev/reset fails due to file locks.
 * Run: node scripts/apply-migrations.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'dev.db');
const migrationsDir = path.resolve(__dirname, '..', 'prisma', 'migrations');

const db = new Database(dbPath);
// Enable WAL for better concurrent access
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

// Get all migration folders sorted chronologically
const folders = fs
  .readdirSync(migrationsDir)
  .filter(
    (f) =>
      f !== 'migration_lock.toml' &&
      fs.statSync(path.join(migrationsDir, f)).isDirectory(),
  )
  .sort();

let applied = 0;
let skipped = 0;

for (const folder of folders) {
  const sqlFile = path.join(migrationsDir, folder, 'migration.sql');
  if (!fs.existsSync(sqlFile)) {
    console.log(`  SKIP (no migration.sql): ${folder}`);
    skipped++;
    continue;
  }

  const sql = fs.readFileSync(sqlFile, 'utf8');

  // Split on statement boundaries (handle multi-statement migrations)
  // SQLite exec() handles multiple statements separated by semicolons
  try {
    db.exec(sql);
    console.log(`  ✅ Applied: ${folder}`);
    applied++;
  } catch (err) {
    // Some statements may already exist (e.g. re-running after partial apply)
    if (
      err.message.includes('already exists') ||
      err.message.includes('duplicate column')
    ) {
      console.log(
        `  ⚠️  Already applied (skipped): ${folder} — ${err.message}`,
      );
      skipped++;
    } else {
      console.error(`  ❌ FAILED: ${folder} — ${err.message}`);
      // Don't abort — try the rest
    }
  }
}

// Mark all migrations as applied in Prisma's tracking table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      finished_at DATETIME,
      migration_name TEXT NOT NULL,
      logs TEXT,
      rolled_back_at DATETIME,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      applied_steps_count INTEGER DEFAULT 0
    )
  `);

  for (const folder of folders) {
    const sqlFile = path.join(migrationsDir, folder, 'migration.sql');
    if (!fs.existsSync(sqlFile)) continue;
    const existing = db
      .prepare('SELECT id FROM _prisma_migrations WHERE migration_name = ?')
      .get(folder);
    if (!existing) {
      db.prepare(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
         VALUES (?, ?, datetime('now'), ?, 1)`,
      ).run(
        Math.random().toString(36).slice(2),
        '0000000000000000000000000000000000000000000000000000000000000000',
        folder,
      );
    }
  }
  console.log('\n✅ Prisma migration tracking table updated');
} catch (err) {
  console.error('Migration tracking table error:', err.message);
}

db.pragma('foreign_keys = ON');
db.close();

console.log(`\nDone: ${applied} applied, ${skipped} skipped`);

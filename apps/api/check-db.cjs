const Database = require('better-sqlite3');
const db = new Database('./dev.db');
['LiveTrade', 'StrikeSelection', 'Signal', 'PaperTrade'].forEach((t) => {
  try {
    console.log(
      t + ':',
      db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c,
    );
  } catch (e) {
    console.log(t + ': error', e.message);
  }
});
const dates = db
  .prepare(
    'SELECT DISTINCT substr(createdAt,1,10) as d FROM "LiveTrade" ORDER BY d DESC LIMIT 5',
  )
  .all();
console.log(
  'LiveTrade dates:',
  dates.map((r) => r.d),
);
db.close();

const db = require('better-sqlite3')('./dev.db');

// Get brokers
const brokers = db.prepare('SELECT id, userId, type, name FROM Broker LIMIT 5').all();
console.log('Brokers:', JSON.stringify(brokers, null, 2));

// Total instrument count
const count = db.prepare('SELECT COUNT(*) as c FROM Instrument').get();
console.log('Total instruments in DB:', count.c);

// Find the two instruments
const ce = db.prepare("SELECT instrumentToken, tradingsymbol, strike, expiry FROM Instrument WHERE tradingsymbol = 'NIFTY2642124250CE' LIMIT 1").get();
const pe = db.prepare("SELECT instrumentToken, tradingsymbol, strike, expiry FROM Instrument WHERE tradingsymbol = 'NIFTY2642124500PE' LIMIT 1").get();
console.log('\nCE instrument:', JSON.stringify(ce));
console.log('PE instrument:', JSON.stringify(pe));

// If not found, show nearby NIFTY26421 instruments
if (!ce || !pe) {
  const nearby = db.prepare("SELECT tradingsymbol, instrumentToken, strike, expiry FROM Instrument WHERE tradingsymbol LIKE 'NIFTY26421%' ORDER BY strike LIMIT 20").all();
  console.log('\nNIFTY26421* instruments in DB:', JSON.stringify(nearby, null, 2));
}

// Check existing StrikeSelection for today
const today = new Date().toISOString().split('T')[0];
const existing = db.prepare("SELECT * FROM StrikeSelection WHERE date = ? AND symbol = 'NIFTY'").all(today);
console.log('\nExisting StrikeSelection for today:', JSON.stringify(existing, null, 2));

db.close();

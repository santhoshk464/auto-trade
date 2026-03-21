import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

// Set default DATABASE_URL if not provided
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db';
}

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL,
  }),
});

/**
 * Example queries for historical instrument scanning
 */
async function main() {
  console.log('🔍 Querying Instruments Database\n');

  // 1. Get all NIFTY options for a specific expiry
  console.log('📊 Example 1: NIFTY Options for Feb 26, 2026');
  const niftyOptions = await prisma.instrument.findMany({
    where: {
      name: 'NIFTY',
      expiry: '2026-02-26',
      instrumentType: { in: ['CE', 'PE'] },
    },
    orderBy: [{ instrumentType: 'asc' }, { strike: 'asc' }],
    take: 10,
  });

  console.log(`Found ${niftyOptions.length} options (showing first 10):`);
  niftyOptions.forEach((opt) => {
    console.log(
      `  ${opt.tradingsymbol} - Strike: ${opt.strike} - Token: ${opt.instrumentToken}`,
    );
  });

  // 2. Get all expiry dates for NIFTY
  console.log('\n📅 Example 2: All NIFTY Expiry Dates');
  const niftyExpiries = await prisma.instrument.findMany({
    where: {
      name: 'NIFTY',
      instrumentType: { in: ['CE', 'PE'] },
      expiry: { not: null },
    },
    distinct: ['expiry'],
    select: {
      expiry: true,
    },
    orderBy: {
      expiry: 'asc',
    },
  });

  console.log(`Found ${niftyExpiries.length} expiry dates:`);
  niftyExpiries.slice(0, 10).forEach((exp) => {
    console.log(`  ${exp.expiry}`);
  });

  // 3. Get instruments by token (useful for historical data fetching)
  console.log('\n🔢 Example 3: Find Instrument by Token');
  const instrument = await prisma.instrument.findUnique({
    where: {
      instrumentToken: 256265, // NIFTY 50 index
    },
  });

  if (instrument) {
    console.log(`Found: ${instrument.name} - ${instrument.tradingsymbol}`);
    console.log(`  Exchange: ${instrument.exchange}`);
    console.log(`  Segment: ${instrument.segment}`);
    console.log(`  Type: ${instrument.instrumentType}`);
  }

  // 4. Search instruments by trading symbol pattern
  console.log('\n🔎 Example 4: Search by Trading Symbol Pattern');
  const bankNiftyFeb = await prisma.instrument.findMany({
    where: {
      tradingsymbol: {
        contains: 'BANKNIFTY26FEB',
      },
      instrumentType: 'CE',
    },
    orderBy: {
      strike: 'asc',
    },
    take: 5,
  });

  console.log(`Found ${bankNiftyFeb.length} BANKNIFTY Feb CE options:`);
  bankNiftyFeb.forEach((opt) => {
    console.log(
      `  ${opt.tradingsymbol} - Strike: ${opt.strike} - Token: ${opt.instrumentToken}`,
    );
  });

  // 5. Get statistics
  console.log('\n📈 Example 5: Database Statistics');
  const totalCount = await prisma.instrument.count();
  const byExchange = await prisma.instrument.groupBy({
    by: ['exchange'],
    _count: true,
  });

  console.log(`Total Instruments: ${totalCount}`);
  console.log('By Exchange:');
  byExchange.forEach((stat) => {
    console.log(`  ${stat.exchange}: ${stat._count}`);
  });

  // 6. Get all futures for a specific symbol
  console.log('\n📦 Example 6: All Futures for NIFTY');
  const niftyFutures = await prisma.instrument.findMany({
    where: {
      name: 'NIFTY',
      instrumentType: 'FUT',
    },
    orderBy: {
      expiry: 'asc',
    },
  });

  console.log(`Found ${niftyFutures.length} NIFTY futures:`);
  niftyFutures.forEach((fut) => {
    console.log(
      `  ${fut.tradingsymbol} - Expiry: ${fut.expiry} - Token: ${fut.instrumentToken}`,
    );
  });

  console.log('\n✅ Query examples completed!');
}

main()
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

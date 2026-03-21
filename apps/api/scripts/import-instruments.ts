import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

// Set default DATABASE_URL if not provided
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db';
}

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL,
  }),
});

interface InstrumentRow {
  instrument_token: string;
  exchange_token: string;
  tradingsymbol: string;
  name: string;
  last_price: string;
  expiry: string;
  strike: string;
  tick_size: string;
  lot_size: string;
  instrument_type: string;
  segment: string;
  exchange: string;
}

async function importInstruments(csvFilePath: string, isUpdate = false) {
  console.log(`📂 Reading CSV file: ${csvFilePath}`);

  const fileContent = fs.readFileSync(csvFilePath, 'utf-8');

  console.log('📊 Parsing CSV data...');
  const records: InstrumentRow[] = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  console.log(`✅ Found ${records.length} instruments to import`);

  if (!isUpdate) {
    // Fresh import: Clear existing instruments first (backward compatibility)
    console.log('🗑️  Clearing existing instruments...');
    await prisma.instrument.deleteMany({});
    console.log('✅ Cleared existing instruments');
  } else {
    console.log('🔄 Update mode: Preserving historical instruments');
  }

  const today = new Date();
  const batchSize = 500; // Smaller batches for better error handling
  let inserted = 0;
  let updated = 0;

  console.log(`📥 Processing in batches of ${batchSize}...`);

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    try {
      // Process each instrument individually for upsert
      for (const row of batch) {
        try {
          const instrumentData = {
            instrumentToken: parseInt(row.instrument_token),
            exchangeToken: parseInt(row.exchange_token),
            tradingsymbol: row.tradingsymbol,
            name: row.name || null,
            lastPrice: parseFloat(row.last_price) || 0,
            expiry: row.expiry || null,
            strike: parseFloat(row.strike) || 0,
            tickSize: parseFloat(row.tick_size),
            lotSize: parseInt(row.lot_size),
            instrumentType: row.instrument_type,
            segment: row.segment,
            exchange: row.exchange,
            lastSeenDate: today, // Update last seen date
          };

          const result = await prisma.instrument.upsert({
            where: {
              instrumentToken: instrumentData.instrumentToken,
            },
            update: {
              // Update existing instrument
              exchangeToken: instrumentData.exchangeToken,
              tradingsymbol: instrumentData.tradingsymbol,
              name: instrumentData.name,
              lastPrice: instrumentData.lastPrice,
              tickSize: instrumentData.tickSize,
              lotSize: instrumentData.lotSize,
              lastSeenDate: today,
            },
            create: {
              // Create new instrument
              ...instrumentData,
              firstSeenDate: today,
            },
          });

          if (result.createdAt.getTime() === result.updatedAt.getTime()) {
            inserted++;
          } else {
            updated++;
          }
        } catch (error: any) {
          console.error(
            `❌ Error processing ${row.tradingsymbol}: ${error.message}`,
          );
        }
      }

      const total = inserted + updated;
      const progress = ((total / records.length) * 100).toFixed(1);
      process.stdout.write(
        `\r📥 Progress: ${total}/${records.length} (${progress}%) | New: ${inserted}, Updated: ${updated}`,
      );
    } catch (error) {
      console.error(`\n❌ Error processing batch ${i / batchSize + 1}:`, error);
    }
  }

  console.log(
    `\n✅ Import complete! New: ${inserted}, Updated: ${updated}, Total: ${inserted + updated}`,
  );

  // Show some statistics
  const stats = await prisma.instrument.groupBy({
    by: ['exchange'],
    _count: true,
  });

  console.log('\n📊 Total Instruments by Exchange:');
  stats
    .sort((a: any, b: any) => b._count - a._count)
    .forEach((stat: any) => {
      console.log(`   ${stat.exchange}: ${stat._count}`);
    });

  const typeStats = await prisma.instrument.groupBy({
    by: ['instrumentType'],
    _count: true,
  });

  console.log('\n📊 Total Instruments by Type:');
  typeStats
    .sort((a: any, b: any) => b._count - a._count)
    .forEach((stat: any) => {
      console.log(`   ${stat.instrumentType}: ${stat._count}`);
    });

  // Show newly added instruments count (last 24 hours)
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const newCount = await prisma.instrument.count({
    where: {
      firstSeenDate: {
        gte: yesterday,
      },
    },
  });

  console.log(`\n🆕 Instruments added in last 24 hours: ${newCount}`);
}

async function main() {
  const csvPath = process.argv[2];
  const mode = process.argv[3]; // 'update' or undefined

  if (!csvPath) {
    console.error('❌ Please provide the CSV file path as an argument');
    console.log(
      'Usage: npx tsx scripts/import-instruments.ts <path-to-csv> [update]',
    );
    console.log('');
    console.log('Modes:');
    console.log(
      '  (default) - Fresh import: Clears all existing data and imports from scratch',
    );
    console.log(
      '  update    - Update mode: Preserves historical data, only upserts changes',
    );
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`❌ File not found: ${csvPath}`);
    process.exit(1);
  }

  const isUpdate = mode === 'update';

  try {
    await importInstruments(csvPath, isUpdate);
  } catch (error) {
    console.error('❌ Import failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

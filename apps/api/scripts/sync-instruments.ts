import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import https from 'https';

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

const KITE_INSTRUMENTS_URL = 'https://api.kite.trade/instruments';

async function downloadInstruments(): Promise<string> {
  console.log('📡 Downloading instruments from Kite API...');
  console.log(`   URL: ${KITE_INSTRUMENTS_URL}`);

  return new Promise((resolve, reject) => {
    https
      .get(KITE_INSTRUMENTS_URL, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
          process.stdout.write(
            `\r📥 Downloaded: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
          );
        });

        response.on('end', () => {
          console.log('\n✅ Download complete');
          const csvContent = Buffer.concat(chunks).toString('utf-8');
          resolve(csvContent);
        });

        response.on('error', (error) => {
          reject(error);
        });
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

async function saveToFile(content: string, filePath: string): Promise<void> {
  console.log(`💾 Saving to: ${filePath}`);
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('✅ File saved');
}

async function importFromContent(
  csvContent: string,
  isUpdate = true,
): Promise<void> {
  console.log('📊 Parsing CSV data...');
  const records: InstrumentRow[] = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  console.log(`✅ Found ${records.length} instruments to process`);

  if (!isUpdate) {
    console.log('🗑️  Clearing existing instruments...');
    await prisma.instrument.deleteMany({});
    console.log('✅ Cleared existing instruments');
  } else {
    console.log('🔄 Update mode: Preserving historical instruments');
  }

  const today = new Date();
  const batchSize = 500;
  let inserted = 0;
  let updated = 0;

  console.log(`📥 Processing in batches of ${batchSize}...`);

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

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
          lastSeenDate: today,
        };

        // Check if instrument exists
        const existing = await prisma.instrument.findUnique({
          where: { instrumentToken: instrumentData.instrumentToken },
          select: { id: true },
        });

        if (existing) {
          // Update existing
          await prisma.instrument.update({
            where: { instrumentToken: instrumentData.instrumentToken },
            data: {
              exchangeToken: instrumentData.exchangeToken,
              tradingsymbol: instrumentData.tradingsymbol,
              name: instrumentData.name,
              lastPrice: instrumentData.lastPrice,
              tickSize: instrumentData.tickSize,
              lotSize: instrumentData.lotSize,
              lastSeenDate: today,
            },
          });
          updated++;
        } else {
          // Create new
          await prisma.instrument.create({
            data: {
              ...instrumentData,
              firstSeenDate: today,
            },
          });
          inserted++;
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
  }

  console.log(
    `\n✅ Import complete! New: ${inserted}, Updated: ${updated}, Total: ${inserted + updated}`,
  );

  // Statistics
  const totalCount = await prisma.instrument.count();
  console.log(
    `\n📊 Total instruments in database: ${totalCount.toLocaleString()}`,
  );

  const stats = await prisma.instrument.groupBy({
    by: ['exchange'],
    _count: true,
  });

  console.log('\n📊 Instruments by Exchange:');
  stats
    .sort((a: any, b: any) => b._count - a._count)
    .slice(0, 10)
    .forEach((stat: any) => {
      console.log(`   ${stat.exchange}: ${stat._count.toLocaleString()}`);
    });

  // Show newly added
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const newCount = await prisma.instrument.count({
    where: {
      firstSeenDate: { gte: yesterday },
    },
  });

  console.log(`\n🆕 New instruments in last 24 hours: ${newCount}`);

  // Show potentially delisted (not seen in last 30 days)
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const oldCount = await prisma.instrument.count({
    where: {
      lastSeenDate: { lt: thirtyDaysAgo },
    },
  });

  console.log(
    `📉 Instruments not seen in 30+ days (potentially delisted): ${oldCount}`,
  );
}

async function main() {
  const mode = process.argv[2]; // 'download', 'import', or 'auto'
  const filePath = process.argv[3];

  console.log('🚀 Kite Instruments Sync Tool\n');

  try {
    if (mode === 'download') {
      // Just download and save
      const csvContent = await downloadInstruments();
      const outputPath =
        filePath || `./downloads/instruments_${Date.now()}.csv`;
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await saveToFile(csvContent, outputPath);
      console.log(`\n✅ Instruments saved to: ${outputPath}`);
    } else if (mode === 'import' && filePath) {
      // Import from file
      console.log(`📂 Reading from file: ${filePath}`);
      const csvContent = fs.readFileSync(filePath, 'utf-8');
      await importFromContent(csvContent, true);
    } else if (mode === 'auto' || !mode) {
      // Download and import directly (default mode)
      const csvContent = await downloadInstruments();

      // Optionally save a backup
      const backupDir = './downloads/backups';
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      const backupPath = `${backupDir}/instruments_${new Date().toISOString().split('T')[0]}.csv`;
      await saveToFile(csvContent, backupPath);

      // Import
      await importFromContent(csvContent, true);

      console.log(`\n✅ Complete! Backup saved to: ${backupPath}`);
    } else {
      console.error('❌ Invalid usage');
      console.log('\nUsage:');
      console.log('  npx tsx scripts/sync-instruments.ts [mode] [file]');
      console.log('\nModes:');
      console.log('  (none)      - Auto: Download and import (default)');
      console.log('  auto        - Auto: Download and import');
      console.log('  download    - Download only and save to file');
      console.log('  import      - Import from local CSV file');
      console.log('\nExamples:');
      console.log('  npx tsx scripts/sync-instruments.ts');
      console.log('  npx tsx scripts/sync-instruments.ts auto');
      console.log(
        '  npx tsx scripts/sync-instruments.ts download ./my-instruments.csv',
      );
      console.log(
        '  npx tsx scripts/sync-instruments.ts import ./my-instruments.csv',
      );
      process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

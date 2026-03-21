/**
 * Prisma seed script
 * Populates the DB with data exported from seed-data.json.
 *
 * Run via:  npx prisma db seed
 *   (or)    npx ts-node --project tsconfig.json prisma/seed.ts
 *
 * NOTE: Instruments are NOT seeded here — they are large (200k+ rows).
 *       After seeding, sync instruments by running:
 *         npx ts-node scripts/sync-instruments.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

interface SeedData {
  User?: Array<Record<string, unknown>>;
  Broker?: Array<Record<string, unknown>>;
  TradingSettings?: Array<Record<string, unknown>>;
}

async function main() {
  const seedFile = path.join(__dirname, 'seed-data.json');

  if (!fs.existsSync(seedFile)) {
    console.log('No seed-data.json found — skipping seed.');
    console.log('To generate it, run:  node scripts/export-db.cjs');
    return;
  }

  const data: SeedData = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

  // ── Users ──────────────────────────────────────────────────────────────────
  if (data.User && data.User.length > 0) {
    console.log(`Seeding ${data.User.length} user(s)...`);
    for (const user of data.User) {
      await prisma.user.upsert({
        where: { id: user.id as string },
        update: {},
        create: {
          id: user.id as string,
          name: user.name as string,
          email: user.email as string,
          phone: (user.phone as string) ?? null,
          passwordHash: user.passwordHash as string,
          role: user.role as 'USER' | 'ADMIN',
          createdAt: new Date(user.createdAt as string),
          updatedAt: new Date(user.updatedAt as string),
        },
      });
    }
    console.log('✓ Users seeded.');
  }

  // ── Brokers (accessToken intentionally null — reconnect via Kite OAuth) ────
  if (data.Broker && data.Broker.length > 0) {
    console.log(`Seeding ${data.Broker.length} broker(s) (access tokens cleared)...`);
    for (const broker of data.Broker) {
      await prisma.broker.upsert({
        where: { id: broker.id as string },
        update: {},
        create: {
          id: broker.id as string,
          userId: broker.userId as string,
          type: broker.type as 'KITE' | 'ANGEL' | 'DELTA',
          name: broker.name as string,
          apiKey: broker.apiKey as string,
          apiSecret: broker.apiSecret as string,
          accessToken: null,
          accessTokenExpiresAt: null,
          lastConnectedAt: null,
          createdAt: new Date(broker.createdAt as string),
          updatedAt: new Date(broker.updatedAt as string),
        },
      });
    }
    console.log('✓ Brokers seeded (reconnect Kite OAuth to restore access token).');
  }

  // ── TradingSettings ────────────────────────────────────────────────────────
  if (data.TradingSettings && data.TradingSettings.length > 0) {
    console.log(`Seeding ${data.TradingSettings.length} trading settings row(s)...`);
    for (const s of data.TradingSettings) {
      await prisma.tradingSettings.upsert({
        where: { id: s.id as string },
        update: {},
        create: {
          id: s.id as string,
          userId: s.userId as string,
          symbol: s.symbol as string,
          hedgeLots: s.hedgeLots as number,
          sellLots: s.sellLots as number,
          paperLots: s.paperLots as number,
          bufferPoints: s.bufferPoints as number,
          liveEnabled: false, // always start disabled on a fresh machine
          minSellRsi: s.minSellRsi as number,
          maxSellRiskPts: s.maxSellRiskPts as number,
          createdAt: new Date(s.createdAt as string),
          updatedAt: new Date(s.updatedAt as string),
        },
      });
    }
    console.log('✓ TradingSettings seeded.');
  }

  console.log('\nSeed complete!');
  console.log('──────────────────────────────────────────────────');
  console.log('Next steps:');
  console.log('  1. Re-connect your Kite broker via the UI (OAuth flow)');
  console.log('  2. Sync instruments:  npx ts-node scripts/sync-instruments.ts');
  console.log('──────────────────────────────────────────────────');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

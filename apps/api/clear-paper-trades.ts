import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import 'dotenv/config';

const datasourceUrl = process.env.DATABASE_URL;
if (!datasourceUrl) {
  throw new Error('DATABASE_URL is missing');
}

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: datasourceUrl,
  }),
});

async function clearPaperTrades() {
  try {
    const result = await prisma.paperTrade.deleteMany({});
    console.log(`✅ Deleted ${result.count} paper trades from the database`);

    // Also clear regular trades if needed
    const tradesResult = await prisma.trade.deleteMany({});
    console.log(
      `✅ Deleted ${tradesResult.count} regular trades from the database`,
    );
  } catch (error) {
    console.error('❌ Error clearing trades:', error);
  } finally {
    await prisma.$disconnect();
  }
}

clearPaperTrades();

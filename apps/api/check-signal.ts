import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkSignal() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today);
  endOfDay.setHours(23, 59, 59, 999);

  console.log('🔍 Looking for NIFTY26FEB25400CE signals created today...\n');

  const signals = await prisma.signal.findMany({
    where: {
      optionSymbol: {
        contains: 'NIFTY26FEB25400CE',
      },
      signalDate: {
        gte: today,
        lte: endOfDay,
      },
    },
    include: {
      user: {
        select: {
          email: true,
        },
      },
    },
  });

  console.log(`Found ${signals.length} signal(s):\n`);

  signals.forEach((signal, index) => {
    console.log(`Signal #${index + 1}:`);
    console.log(`  ID: ${signal.id}`);
    console.log(`  Option Symbol: ${signal.optionSymbol}`);
    console.log(`  Signal Time: "${signal.signalTime}"`);
    console.log(`  Signal Type: ${signal.signalType}`);
    console.log(`  Strategy: ${signal.strategy}`);
    console.log(`  Signal Date: ${signal.signalDate}`);
    console.log(`  Trade Created: ${signal.tradeCreated}`);
    console.log(`  Paper Trade ID: ${signal.paperTradeId || 'null'}`);
    console.log(`  User: ${signal.user.email}`);
    console.log(`  Created At: ${signal.createdAt}`);
    console.log('');
  });

  // Also check paper trades for this option
  console.log('\n📊 Checking paper trades for NIFTY26FEB25400CE today...\n');

  const paperTrades = await prisma.paperTrade.findMany({
    where: {
      optionSymbol: {
        contains: 'NIFTY26FEB25400CE',
      },
      entryTime: {
        gte: today,
        lte: endOfDay,
      },
    },
    include: {
      user: {
        select: {
          email: true,
        },
      },
    },
  });

  console.log(`Found ${paperTrades.length} paper trade(s):\n`);

  paperTrades.forEach((trade, index) => {
    console.log(`Paper Trade #${index + 1}:`);
    console.log(`  ID: ${trade.id}`);
    console.log(`  Option Symbol: ${trade.optionSymbol}`);
    console.log(`  Signal Type: ${trade.signalType}`);
    console.log(`  Strategy: ${trade.strategy}`);
    console.log(`  Entry Time: ${trade.entryTime}`);
    console.log(`  Status: ${trade.status}`);
    console.log(`  User: ${trade.user.email}`);
    console.log('');
  });

  await prisma.$disconnect();
}

checkSignal().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

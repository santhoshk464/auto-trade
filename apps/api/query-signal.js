const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  console.log('\n🔍 Checking signals for NIFTY26FEB25400CE today...\n');

  const signals = await prisma.signal.findMany({
    where: {
      optionSymbol: {
        contains: 'NIFTY26FEB25400CE',
      },
      signalDate: {
        gte: today,
      },
    },
  });

  if (signals.length === 0) {
    console.log('❌ No signals found for NIFTY26FEB25400CE today.\n');
  } else {
    signals.forEach((sig, index) => {
      console.log(`Signal #${index + 1}:`);
      console.log(`  Option: ${sig.optionSymbol}`);
      console.log(`  Signal Time: "${sig.signalTime}"`);
      console.log(`  Strategy: ${sig.strategy}`);
      console.log(`  Trade Created: ${sig.tradeCreated}`);
      console.log(`  Paper Trade ID: ${sig.paperTradeId || 'null'}`);
      console.log(`  Signal Date: ${sig.signalDate}`);
      console.log('');
    });
  }

  console.log('\n📊 Checking paper trades for NIFTY26FEB25400CE today...\n');

  const trades = await prisma.paperTrade.findMany({
    where: {
      optionSymbol: {
        contains: 'NIFTY26FEB25400CE',
      },
      entryTime: {
        gte: today,
      },
    },
  });

  if (trades.length === 0) {
    console.log('❌ No paper trades found for NIFTY26FEB25400CE today.\n');
  } else {
    trades.forEach((trade, index) => {
      console.log(`Paper Trade #${index + 1}:`);
      console.log(`  ID: ${trade.id}`);
      console.log(`  Option: ${trade.optionSymbol}`);
      console.log(`  Strategy: ${trade.strategy}`);
      console.log(`  Entry Time: ${trade.entryTime}`);
      console.log(`  Status: ${trade.status}`);
      console.log('');
    });
  }

  await prisma.$disconnect();
}

main().catch(console.error);

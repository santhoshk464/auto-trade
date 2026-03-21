import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkPaperTrade() {
  try {
    const trades = await prisma.paperTrade.findMany({
      take: 5,
      orderBy: { entryTime: 'desc' },
      select: {
        id: true,
        optionSymbol: true,
        signalType: true,
        entryPrice: true,
        exitPrice: true,
        stopLoss: true,
        target1: true,
        target2: true,
        target3: true,
        status: true,
        pnl: true,
        entryTime: true,
        exitTime: true,
        instrumentToken: true,
      },
    });

    console.log('📊 Recent Paper Trades:');
    console.log('='.repeat(80));
    trades.forEach((trade, idx) => {
      console.log(`\n[${idx + 1}] ${trade.optionSymbol} (${trade.signalType})`);
      console.log(`   Status: ${trade.status}`);
      console.log(`   Entry: ₹${trade.entryPrice} at ${trade.entryTime}`);
      console.log(
        `   Exit: ₹${trade.exitPrice || 'N/A'} at ${trade.exitTime || 'N/A'}`,
      );
      console.log(`   Stop Loss: ₹${trade.stopLoss}`);
      console.log(
        `   Targets: ₹${trade.target1} / ₹${trade.target2} / ₹${trade.target3}`,
      );
      console.log(`   P&L: ₹${trade.pnl}`);
      console.log(`   Instrument Token: ${trade.instrumentToken}`);
    });
    console.log('\n' + '='.repeat(80));
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkPaperTrade();

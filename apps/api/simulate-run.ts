/**
 * Standalone simulation script — runs simulateAutoTradeDay without HTTP/auth.
 * Usage: npx ts-node -P tsconfig.json simulate-run.ts [YYYY-MM-DD]
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { KiteService } from './src/kite/services/kite.service';
import { TradingService } from './src/kite/services/trading.service';
import { PrismaService } from './src/prisma/prisma.service';

async function main() {
  const date = process.argv[2] || new Date().toISOString().split('T')[0];

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const prisma = app.get(PrismaService);
  const kiteService = app.get(KiteService);
  const tradingService = app.get(TradingService);

  // Find the first broker with a valid access token
  const broker = await prisma.broker.findFirst({
    where: {
      accessToken: { not: null },
      accessTokenExpiresAt: { gt: new Date() },
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (!broker) {
    console.error('❌ No active broker with a valid token found.');
    await app.close();
    process.exit(1);
  }

  console.log(`\n🤖 Running Auto-Trade Simulation`);
  console.log(`   Broker : ${broker.name}`);
  console.log(`   Date   : ${date}`);
  console.log(
    `   Strategy: DAY_SELLING | 1min | SL=30pts | Target=60pts | Max 2 trades\n`,
  );

  try {
    const result = await tradingService.simulateAutoTradeDay(broker.id, date);

    console.log('═'.repeat(60));
    console.log(`📅  Date    : ${result.date}   |   Expiry: ${result.expiry}`);
    console.log(`📡  Signals : ${result.totalSignalsFound} raw signals found`);
    console.log('═'.repeat(60));

    if (!result.trades || result.trades.length === 0) {
      console.log('\n⚠️  No trades taken today.\n');
    } else {
      for (const trade of result.trades) {
        const icon =
          trade.exitReason === 'TARGET_HIT'
            ? '🎯'
            : trade.exitReason === 'SL_HIT'
              ? '🛑'
              : trade.exitReason === 'REPLACED_BY_TRADE_2'
                ? '🔄'
                : trade.exitReason === 'EOD_CLOSE'
                  ? '🔔'
                  : '⏳';

        console.log(
          `\n  TRADE ${trade.tradeNo}  ${icon}  ${trade.optionSymbol}`,
        );
        console.log(
          `    Signal  : ${trade.signalTime}  —  ${trade.signalReason}`,
        );
        console.log(
          `    Entry   : ₹${trade.entry}   SL: ₹${trade.sl}   Target: ₹${trade.target}`,
        );
        console.log(
          `    Exit    : ${trade.exitTime}  @  ₹${trade.exitPrice}  (${trade.exitReason})`,
        );
        console.log(
          `    P&L     : ${trade.pnlFormatted}  (₹${trade.pnlPerUnit}/unit × ${trade.lotSize} lots)`,
        );
      }
    }

    console.log('\n' + '═'.repeat(60));
    const s = result.summary;
    console.log(`📊  SUMMARY`);
    console.log(`    Total Trades : ${s.totalTrades}`);
    console.log(`    Wins / Losses: ${s.wins} / ${s.losses}`);
    console.log(`    Net P&L      : ${s.totalPnlFormatted}`);
    console.log('═'.repeat(60) + '\n');
  } catch (err: any) {
    console.error('❌ Simulation failed:', err.message);
  }

  await app.close();
}

main();

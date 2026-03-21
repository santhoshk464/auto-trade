import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixUnlinkedSignals() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    console.log('\n🔍 Finding unlinked signals and paper trades from today...\n');

    // Get all paper trades from today
    const paperTrades = await prisma.paperTrade.findMany({
      where: {
        entryTime: {
          gte: today,
          lte: endOfDay,
        },
      },
      orderBy: { entryTime: 'asc' },
    });

    console.log(`Found ${paperTrades.length} paper trade(s) today.\n`);

    let fixedCount = 0;

    for (const trade of paperTrades) {
      // Find matching signal for this paper trade
      const signals = await prisma.signal.findMany({
        where: {
          userId: trade.userId,
          optionSymbol: trade.optionSymbol,
          strategy: trade.strategy,
          signalDate: {
            gte: today,
            lte: endOfDay,
          },
          tradeCreated: false, // Only unlinked signals
        },
      });

      if (signals.length === 0) {
        console.log(`⚠️  No unlinked signal found for trade: ${trade.optionSymbol} (${trade.strategy})`);
        continue;
      }

      // Get the entry time in IST format for matching
      const entryTimeIST = new Date(trade.entryTime).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      console.log(`\n📊 Paper Trade: ${trade.optionSymbol}`);
      console.log(`   Entry Time: ${entryTimeIST}`);
      console.log(`   Strategy: ${trade.strategy}`);
      console.log(`   Status: ${trade.status}`);
      console.log(`   Found ${signals.length} potential matching signal(s):`);

      // Try to find best matching signal by time
      let bestMatch = null;
      let bestMatchScore = -1;

      for (const signal of signals) {
        console.log(`   - Signal Time: "${signal.signalTime}"`);
        
        // Normalize both times for comparison
        const normalizedSignalTime = signal.signalTime.toLowerCase().trim();
        const normalizedEntryTime = entryTimeIST.toLowerCase().trim();

        if (normalizedSignalTime === normalizedEntryTime) {
          bestMatch = signal;
          bestMatchScore = 2; // Exact match
          break;
        } else {
          // Check if times are close (ignore AM/PM differences)
          const signalTimeParts = normalizedSignalTime.match(/(\d+):(\d+)/);
          const entryTimeParts = normalizedEntryTime.match(/(\d+):(\d+)/);
          
          if (signalTimeParts && entryTimeParts) {
            const signalHour = parseInt(signalTimeParts[1]);
            const signalMin = parseInt(signalTimeParts[2]);
            const entryHour = parseInt(entryTimeParts[1]);
            const entryMin = parseInt(entryTimeParts[2]);

            if (signalHour === entryHour && signalMin === entryMin) {
              if (bestMatchScore < 1) {
                bestMatch = signal;
                bestMatchScore = 1; // Time match (ignore AM/PM)
              }
            }
          }
        }
      }

      if (bestMatch) {
        console.log(`   ✅ Linking signal "${bestMatch.signalTime}" to paper trade ID: ${trade.id}`);
        
        await prisma.signal.update({
          where: { id: bestMatch.id },
          data: {
            tradeCreated: true,
            paperTradeId: trade.id,
          },
        });

        fixedCount++;
        console.log(`   ✓ Successfully linked!`);
      } else {
        console.log(`   ⚠️  No matching signal found for entry time ${entryTimeIST}`);
      }
    }

    console.log(`\n✅ Fixed ${fixedCount} unlinked signal(s).\n`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixUnlinkedSignals();

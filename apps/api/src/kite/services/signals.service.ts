import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SignalType } from '@prisma/client';

@Injectable()
export class SignalsService {
  private readonly logger = new Logger(SignalsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Save a signal to the database
   */
  async saveSignal(data: {
    userId: string;
    brokerId?: string;
    symbol: string;
    optionSymbol: string;
    instrumentToken: number;
    strike: number;
    optionType: string;
    expiryDate: string;
    signalType: 'BUY' | 'SELL';
    strategy: string;
    signalReason: string;
    signalTime: string;
    signalDate: Date;
    entryPrice: number;
    stopLoss: number;
    target1: number;
    target2: number;
    target3: number;
    ltp?: number;
    marginPoints?: number;
    interval?: string;
    targetDate?: string;
  }) {
    try {
      // Check if signal already exists (prevent duplicates)
      const existingSignal = await this.prisma.signal.findFirst({
        where: {
          userId: data.userId,
          optionSymbol: data.optionSymbol,
          strategy: data.strategy,
          signalTime: data.signalTime,
          signalDate: data.signalDate,
        },
      });

      if (existingSignal) {
        this.logger.debug(
          `Signal already exists: ${data.optionSymbol} ${data.signalType} @ ${data.signalTime}`,
        );
        return existingSignal;
      }

      const signal = await this.prisma.signal.create({
        data: {
          userId: data.userId,
          brokerId: data.brokerId,
          symbol: data.symbol,
          optionSymbol: data.optionSymbol,
          instrumentToken: data.instrumentToken,
          strike: data.strike,
          optionType: data.optionType,
          expiryDate: data.expiryDate,
          signalType: data.signalType as SignalType,
          strategy: data.strategy,
          signalReason: data.signalReason,
          signalTime: data.signalTime,
          signalDate: data.signalDate,
          entryPrice: data.entryPrice,
          stopLoss: data.stopLoss,
          target1: data.target1,
          target2: data.target2,
          target3: data.target3,
          ltp: data.ltp,
          marginPoints: data.marginPoints,
          interval: data.interval,
          targetDate: data.targetDate,
        },
      });

      this.logger.log(
        `📝 Saved signal: ${data.optionSymbol} ${data.signalType} @ ${data.signalTime}`,
      );

      return signal;
    } catch (error) {
      this.logger.error(`Failed to save signal: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark a signal as traded (paper trade created)
   */
  async markSignalAsTraded(signalId: string, paperTradeId: string) {
    return this.prisma.signal.update({
      where: { id: signalId },
      data: {
        tradeCreated: true,
        paperTradeId: paperTradeId,
      },
    });
  }

  /**
   * Mark signal as traded by option symbol and time
   * (For cases where signalId is not directly available)
   */
  async markSignalAsTradedByDetails(
    userId: string,
    optionSymbol: string,
    signalTime: string,
    strategy: string,
    paperTradeId: string,
  ) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today);
      endOfDay.setHours(23, 59, 59, 999);

      // Normalize signal time (lowercase for case-insensitive matching)
      const normalizedTime = signalTime.toLowerCase().trim();

      // Log the criteria for debugging
      this.logger.debug(
        `🔍 Attempting to mark signal as traded with criteria:
        userId: ${userId}
        optionSymbol: ${optionSymbol}
        signalTime: ${signalTime} (normalized: ${normalizedTime})
        strategy: ${strategy}
        paperTradeId: ${paperTradeId}
        date range: ${today.toISOString()} - ${endOfDay.toISOString()}`,
      );

      // First check if matching signal exists (case-insensitive time comparison)
      const matchingSignals = await this.prisma.signal.findMany({
        where: {
          userId: userId,
          optionSymbol: optionSymbol,
          strategy: strategy,
          signalDate: {
            gte: today,
            lte: endOfDay,
          },
          tradeCreated: false,
        },
      });

      this.logger.debug(
        `Found ${matchingSignals.length} potential matching signals`,
      );

      let signalToUpdate: any = null;

      if (matchingSignals.length > 0) {
        // Try to find exact match or case-insensitive match
        signalToUpdate = matchingSignals.find(
          (sig) => sig.signalTime.toLowerCase().trim() === normalizedTime,
        );

        if (!signalToUpdate) {
          this.logger.warn(
            `⚠️  No exact time match found. Available signal times:`,
          );
          matchingSignals.forEach((sig) => {
            this.logger.warn(
              `  Signal: ${sig.optionSymbol} @ "${sig.signalTime}" (stored), looking for: "${signalTime}"`,
            );
          });
        } else {
          this.logger.debug(
            `✓ Found matching signal with ID: ${signalToUpdate.id}`,
          );
        }
      }

      let result;

      if (signalToUpdate) {
        // Update the specific signal we found
        await this.prisma.signal.update({
          where: { id: signalToUpdate.id },
          data: {
            tradeCreated: true,
            paperTradeId: paperTradeId,
          },
        });
        result = { count: 1 };
      } else {
        // Fallback to updateMany (original logic) in case we missed something
        result = await this.prisma.signal.updateMany({
          where: {
            userId: userId,
            optionSymbol: optionSymbol,
            signalTime: signalTime,
            strategy: strategy,
            signalDate: {
              gte: today,
              lte: endOfDay,
            },
            tradeCreated: false,
          },
          data: {
            tradeCreated: true,
            paperTradeId: paperTradeId,
          },
        });
      }

      if (result.count > 0) {
        this.logger.log(
          `✅ Marked ${result.count} signal(s) as traded: ${optionSymbol} @ ${signalTime}`,
        );
      } else {
        this.logger.warn(
          `⚠️  No signals updated. Signal might already be marked as traded or criteria don't match.`,
        );
      }

      return result;
    } catch (error) {
      this.logger.error(`Failed to mark signal as traded: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get signals for a user with optional filters
   */
  async getSignals(
    userId: string,
    strategy?: string,
    date?: string,
    limit: number = 100,
  ) {
    const where: any = { userId };

    if (strategy) {
      where.strategy = strategy;
    }

    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      where.signalDate = {
        gte: startDate,
        lte: endDate,
      };
    }

    const signals = await this.prisma.signal.findMany({
      where,
      orderBy: [{ signalDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      include: {
        broker: {
          select: {
            name: true,
            type: true,
          },
        },
      },
    });

    // Fetch paper trade status for signals that have trades
    const signalsWithTradeStatus = await Promise.all(
      signals.map(async (signal) => {
        if (signal.tradeCreated && signal.paperTradeId) {
          const paperTrade = await this.prisma.paperTrade.findUnique({
            where: { id: signal.paperTradeId },
            select: { status: true, pnl: true, exitTime: true },
          });

          return {
            ...signal,
            paperTradeStatus: paperTrade?.status || null,
            paperTradePnl: paperTrade?.pnl || null,
            paperTradeExitTime: paperTrade?.exitTime || null,
          };
        }
        return {
          ...signal,
          paperTradeStatus: null,
          paperTradePnl: null,
          paperTradeExitTime: null,
        };
      }),
    );

    return {
      signals: signalsWithTradeStatus,
      count: signalsWithTradeStatus.length,
    };
  }

  /**
   * Get latest signals grouped by strategy
   */
  async getLatestSignals(userId: string, strategy?: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const where: any = {
      userId,
      signalDate: {
        gte: today,
      },
    };

    if (strategy) {
      where.strategy = strategy;
    }

    const signals = await this.prisma.signal.findMany({
      where,
      orderBy: [{ signalDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        broker: {
          select: {
            name: true,
            type: true,
          },
        },
      },
    });

    // Group by strategy
    const grouped: Record<string, any[]> = {};
    for (const signal of signals) {
      if (!grouped[signal.strategy]) {
        grouped[signal.strategy] = [];
      }
      grouped[signal.strategy].push(signal);
    }

    return {
      signals: grouped,
      total: signals.length,
      strategies: Object.keys(grouped),
    };
  }

  /**
   * Get signal statistics
   */
  async getSignalStats(userId: string, date?: string) {
    const where: any = { userId };

    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      where.signalDate = {
        gte: startDate,
        lte: endDate,
      };
    } else {
      // Default to today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      where.signalDate = {
        gte: today,
      };
    }

    const [totalSignals, buySignals, sellSignals, tradedSignals, byStrategy] =
      await Promise.all([
        this.prisma.signal.count({ where }),
        this.prisma.signal.count({ where: { ...where, signalType: 'BUY' } }),
        this.prisma.signal.count({ where: { ...where, signalType: 'SELL' } }),
        this.prisma.signal.count({ where: { ...where, tradeCreated: true } }),
        this.prisma.signal.groupBy({
          by: ['strategy'],
          where,
          _count: true,
        }),
      ]);

    // Get active and closed trades count
    const signalsWithTrades = await this.prisma.signal.findMany({
      where: { ...where, tradeCreated: true },
      select: { paperTradeId: true },
    });

    const paperTradeIds = signalsWithTrades
      .map((s) => s.paperTradeId)
      .filter((id) => id !== null) as string[];

    let activeTrades = 0;
    let closedTrades = 0;

    if (paperTradeIds.length > 0) {
      const [activeCount, closedCount] = await Promise.all([
        this.prisma.paperTrade.count({
          where: { id: { in: paperTradeIds }, status: 'ACTIVE' },
        }),
        this.prisma.paperTrade.count({
          where: {
            id: { in: paperTradeIds },
            status: { not: 'ACTIVE' },
          },
        }),
      ]);

      activeTrades = activeCount;
      closedTrades = closedCount;
    }

    return {
      total: totalSignals,
      buy: buySignals,
      sell: sellSignals,
      traded: tradedSignals,
      active: activeTrades,
      closed: closedTrades,
      pending: totalSignals - tradedSignals,
      byStrategy: byStrategy.map((s) => ({
        strategy: s.strategy,
        count: s._count,
      })),
    };
  }

  /**
   * Fix unlinked signals by matching them with paper trades
   */
  async fixUnlinkedSignals(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    this.logger.log('🔍 Finding unlinked signals and paper trades...');

    // Get all paper trades from today
    const paperTrades = await this.prisma.paperTrade.findMany({
      where: {
        userId,
        entryTime: {
          gte: today,
          lte: endOfDay,
        },
      },
      orderBy: { entryTime: 'asc' },
    });

    this.logger.log(`Found ${paperTrades.length} paper trade(s) today`);

    let fixedCount = 0;
    const results = [];

    for (const trade of paperTrades) {
      // Find matching signal for this paper trade
      const signals = await this.prisma.signal.findMany({
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
        this.logger.debug(
          `No unlinked signal found for trade: ${trade.optionSymbol} (${trade.strategy})`,
        );
        continue;
      }

      // Get the entry time in IST format for matching
      const entryTimeIST = new Date(trade.entryTime).toLocaleTimeString(
        'en-IN',
        {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        },
      );

      this.logger.debug(
        `Paper Trade: ${trade.optionSymbol} @ ${entryTimeIST} (${trade.strategy})`,
      );
      this.logger.debug(`Found ${signals.length} potential matching signal(s)`);

      // Try to find best matching signal by time
      let bestMatch = null;

      for (const signal of signals) {
        // Normalize both times for comparison
        const normalizedSignalTime = signal.signalTime.toLowerCase().trim();
        const normalizedEntryTime = entryTimeIST.toLowerCase().trim();

        if (normalizedSignalTime === normalizedEntryTime) {
          bestMatch = signal;
          break;
        }

        // Check if times match ignoring AM/PM case differences
        const signalTimeParts = normalizedSignalTime.match(/(\d+):(\d+)/);
        const entryTimeParts = normalizedEntryTime.match(/(\d+):(\d+)/);

        if (signalTimeParts && entryTimeParts) {
          const signalHour = parseInt(signalTimeParts[1]);
          const signalMin = parseInt(signalTimeParts[2]);
          const entryHour = parseInt(entryTimeParts[1]);
          const entryMin = parseInt(entryTimeParts[2]);

          if (signalHour === entryHour && signalMin === entryMin) {
            bestMatch = signal;
            break;
          }
        }
      }

      if (bestMatch) {
        await this.prisma.signal.update({
          where: { id: bestMatch.id },
          data: {
            tradeCreated: true,
            paperTradeId: trade.id,
          },
        });

        fixedCount++;
        const result = `✅ Linked ${trade.optionSymbol} @ ${bestMatch.signalTime} to paper trade`;
        this.logger.log(result);
        results.push(result);
      } else {
        const result = `⚠️  No matching signal found for ${trade.optionSymbol} @ ${entryTimeIST}`;
        this.logger.warn(result);
        results.push(result);
      }
    }

    const summary = `Fixed ${fixedCount} unlinked signal(s)`;
    this.logger.log(summary);

    return {
      success: true,
      fixedCount,
      totalPaperTrades: paperTrades.length,
      results,
      message: summary,
    };
  }

  /**
   * Clear all of today's signals for a user
   */
  async clearTodaySignals(userId: string) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const result = await this.prisma.signal.deleteMany({
      where: {
        userId,
        signalDate: { gte: todayStart, lte: todayEnd },
      },
    });

    this.logger.log(
      `Cleared ${result.count} signals for today (userId=${userId})`,
    );
    return { deleted: result.count };
  }

  /**
   * Clear today's DB-fallback signal tokens for a specific broker + strategy.
   * Used by Trade Finder to force fresh ATM selection when the cached
   * instrument tokens belong to a different expiry.
   */
  async clearTodaySignalsForBroker(brokerId: string, strategy?: string) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const where: any = {
      brokerId,
      signalDate: { gte: todayStart, lte: todayEnd },
    };
    if (strategy) where.strategy = strategy;

    const result = await this.prisma.signal.deleteMany({ where });
    this.logger.log(
      `Cleared ${result.count} today signals for brokerId=${brokerId} strategy=${strategy ?? 'all'}`,
    );
    return { deleted: result.count };
  }

  /**
   * Delete old signals (cleanup)
   */
  async deleteOldSignals(daysOld: number = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.signal.deleteMany({
      where: {
        signalDate: {
          lt: cutoffDate,
        },
      },
    });

    this.logger.log(
      `Deleted ${result.count} signals older than ${daysOld} days`,
    );
    return result;
  }
}

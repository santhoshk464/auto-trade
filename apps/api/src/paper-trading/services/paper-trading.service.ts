import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaperTradeStatus, SignalType, type PaperTrade } from '@prisma/client';
import { KiteConnect } from 'kiteconnect';

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Create a new paper trade
   */
  async createPaperTrade(data: {
    userId: string;
    brokerId: string;
    symbol: string;
    optionSymbol: string;
    instrumentToken: number;
    strike: number;
    optionType: string;
    expiryDate: string;
    signalType: SignalType;
    strategy: string;
    signalReason?: string;
    entryPrice: number;
    entryTime?: Date; // Optional: actual signal timestamp
    stopLoss: number;
    target1: number;
    target2: number;
    target3: number;
    quantity?: number;
    marginPoints?: number;
    interval?: string;
  }): Promise<PaperTrade> {
    // Hard daily cap: never create more than 2 paper trades in the same IST day.
    // This secondary guard enforces the cap even when createPaperTrade is called
    // directly (e.g. via the manual API endpoint) without going through canPlaceNewTrade.
    const entryDate = data.entryTime ?? new Date();
    const capStart = new Date(entryDate);
    capStart.setHours(0, 0, 0, 0);
    const capEnd = new Date(entryDate);
    capEnd.setHours(23, 59, 59, 999);
    const todayCount = await this.prisma.paperTrade.count({
      where: {
        userId: data.userId,
        entryTime: { gte: capStart, lte: capEnd },
      },
    });
    if (todayCount >= 2) {
      throw new Error(
        `Daily trade limit (2 trades) reached. Cannot create more paper trades today.`,
      );
    }

    // Check if there's already an active trade for this option
    const activeTrade = await this.prisma.paperTrade.findFirst({
      where: {
        userId: data.userId,
        optionSymbol: data.optionSymbol,
        status: PaperTradeStatus.ACTIVE,
      },
    });

    if (activeTrade) {
      throw new Error(
        `Active trade already exists for ${data.optionSymbol}. Close existing trade first.`,
      );
    }

    const paperTrade = await this.prisma.paperTrade.create({
      data: {
        userId: data.userId,
        brokerId: data.brokerId,
        symbol: data.symbol,
        optionSymbol: data.optionSymbol,
        instrumentToken: data.instrumentToken,
        strike: data.strike,
        optionType: data.optionType,
        expiryDate: data.expiryDate,
        signalType: data.signalType,
        strategy: data.strategy,
        signalReason: data.signalReason,
        entryPrice: data.entryPrice,
        entryTime: data.entryTime, // Use provided time or default to now
        stopLoss: data.stopLoss,
        target1: data.target1,
        target2: data.target2,
        target3: data.target3,
        quantity: data.quantity || 1,
        marginPoints: data.marginPoints,
        interval: data.interval,
        status: PaperTradeStatus.ACTIVE,
      },
    });

    this.logger.log(
      `Created paper trade: ${paperTrade.optionSymbol} ${paperTrade.signalType} at ${paperTrade.entryPrice}`,
    );

    return paperTrade;
  }

  /**
   * Get all paper trades for a user
   */
  async getUserPaperTrades(
    userId: string,
    filters?: {
      status?: PaperTradeStatus;
      strategy?: string;
      fromDate?: Date;
      toDate?: Date;
    },
  ): Promise<PaperTrade[]> {
    const where: any = { userId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.strategy) {
      where.strategy = filters.strategy;
    }

    if (filters?.fromDate || filters?.toDate) {
      where.entryTime = {};
      if (filters.fromDate) {
        where.entryTime.gte = filters.fromDate;
      }
      if (filters.toDate) {
        where.entryTime.lte = filters.toDate;
      }
    }

    return this.prisma.paperTrade.findMany({
      where,
      orderBy: { entryTime: 'desc' },
      include: {
        broker: true,
      },
    });
  }

  /**
   * Get active paper trades
   */
  async getActiveTrades(userId: string) {
    return this.prisma.paperTrade.findMany({
      where: {
        userId,
        status: PaperTradeStatus.ACTIVE,
      },
      include: {
        broker: true,
      },
    });
  }

  /**
   * Check if user has active trade for an option
   */
  async hasActiveTrade(userId: string, optionSymbol: string): Promise<boolean> {
    const count = await this.prisma.paperTrade.count({
      where: {
        userId,
        optionSymbol,
        status: PaperTradeStatus.ACTIVE,
      },
    });
    return count > 0;
  }

  /**
   * Update trade status and calculate P&L
   */
  async closeTrade(
    tradeId: string,
    exitPrice: number,
    status: PaperTradeStatus,
    exitTime?: Date, // Optional: Use provided timestamp (for historical data)
  ): Promise<PaperTrade> {
    const trade = await this.prisma.paperTrade.findUnique({
      where: { id: tradeId },
    });

    if (!trade) {
      throw new Error('Trade not found');
    }

    if (trade.status !== PaperTradeStatus.ACTIVE) {
      throw new Error('Trade is not active');
    }

    // Calculate P&L
    const pnlPerLot =
      trade.signalType === SignalType.SELL
        ? (trade.entryPrice - exitPrice) * trade.quantity
        : (exitPrice - trade.entryPrice) * trade.quantity;

    const pnlPercentage =
      ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;

    this.logger.log(
      `Closing trade ${trade.optionSymbol} (${trade.signalType}): Entry=${trade.entryPrice}, Exit=${exitPrice}, P&L=${pnlPerLot.toFixed(2)}`,
    );

    const updatedTrade = await this.prisma.paperTrade.update({
      where: { id: tradeId },
      data: {
        exitPrice,
        exitTime: exitTime || new Date(), // Use provided time or current time
        status,
        pnl: pnlPerLot,
        pnlPercentage:
          trade.signalType === SignalType.SELL ? -pnlPercentage : pnlPercentage,
      },
    });

    this.logger.log(
      `✅ Closed trade: ${updatedTrade.optionSymbol} at ${exitPrice}, P&L: ${pnlPerLot.toFixed(2)}, Status: ${status}`,
    );

    return updatedTrade;
  }

  /**
   * Monitor active trades and close if SL or Target hit
   * This should be called periodically (e.g., via cron job or when checking signals)
   */
  async monitorAndUpdateTrades(userId: string): Promise<{
    checked: number;
    closed: number;
    trades: any[];
  }> {
    const activeTrades = await this.getActiveTrades(userId);

    if (activeTrades.length === 0) {
      return { checked: 0, closed: 0, trades: [] };
    }

    this.logger.log(`Monitoring ${activeTrades.length} active trades`);

    const closedTrades: any[] = [];

    // Get broker access token for fetching current prices
    const broker = activeTrades[0].broker;
    if (!broker.accessToken) {
      this.logger.warn('No access token available for broker');
      return { checked: activeTrades.length, closed: 0, trades: [] };
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      // Fetch LTP for all active trades
      const instrumentTokens = activeTrades.map((t) =>
        String(t.instrumentToken),
      );
      const quotes = await kc.getQuote(instrumentTokens);

      for (const trade of activeTrades) {
        const quote = quotes[String(trade.instrumentToken)];
        if (!quote || !quote.last_price) {
          this.logger.warn(
            `No quote data for ${trade.optionSymbol} (${trade.instrumentToken})`,
          );
          continue;
        }

        const currentPrice = quote.last_price;
        let shouldClose = false;
        let newStatus: PaperTradeStatus = PaperTradeStatus.ACTIVE;

        this.logger.debug(
          `Monitoring ${trade.optionSymbol} (${trade.signalType}): Entry=${trade.entryPrice}, Current=${currentPrice}, SL=${trade.stopLoss}, T1=${trade.target1}, T2=${trade.target2}, T3=${trade.target3}`,
        );

        if (trade.signalType === SignalType.SELL) {
          // For SELL trades: SL is above entry, Targets are below entry
          if (currentPrice >= trade.stopLoss) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_SL;
            this.logger.log(
              `SL HIT for ${trade.optionSymbol}: Current ${currentPrice} >= SL ${trade.stopLoss}`,
            );
          } else if (currentPrice <= trade.target3) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_TARGET3;
            this.logger.log(
              `TARGET3 HIT for ${trade.optionSymbol}: Current ${currentPrice} <= T3 ${trade.target3}`,
            );
          } else if (currentPrice <= trade.target2) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_TARGET2;
            this.logger.log(
              `TARGET2 HIT for ${trade.optionSymbol}: Current ${currentPrice} <= T2 ${trade.target2}`,
            );
          } else if (currentPrice <= trade.target1) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_TARGET1;
            this.logger.log(
              `TARGET1 HIT for ${trade.optionSymbol}: Current ${currentPrice} <= T1 ${trade.target1}`,
            );
          }
        } else {
          // For BUY trades: SL is below entry, Targets are above entry
          if (currentPrice <= trade.stopLoss) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_SL;
            this.logger.log(
              `SL HIT for ${trade.optionSymbol}: Current ${currentPrice} <= SL ${trade.stopLoss}`,
            );
          } else if (currentPrice >= trade.target3) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_TARGET3;
            this.logger.log(
              `TARGET3 HIT for ${trade.optionSymbol}: Current ${currentPrice} >= T3 ${trade.target3}`,
            );
          } else if (currentPrice >= trade.target2) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_TARGET2;
            this.logger.log(
              `TARGET2 HIT for ${trade.optionSymbol}: Current ${currentPrice} >= T2 ${trade.target2}`,
            );
          } else if (currentPrice >= trade.target1) {
            shouldClose = true;
            newStatus = PaperTradeStatus.CLOSED_TARGET1;
            this.logger.log(
              `TARGET1 HIT for ${trade.optionSymbol}: Current ${currentPrice} >= T1 ${trade.target1}`,
            );
          }
        }

        if (shouldClose) {
          const closedTrade = await this.closeTrade(
            trade.id,
            currentPrice,
            newStatus,
          );
          closedTrades.push(closedTrade);
        }
      }
    } catch (error) {
      this.logger.error('Error monitoring trades:', error);
    }

    return {
      checked: activeTrades.length,
      closed: closedTrades.length,
      trades: closedTrades,
    };
  }

  /**
   * Square off all active trades at end of day (EOD)
   * This should be called at 3:10 PM to close all open positions
   */
  async squareOffActiveTrades(): Promise<{
    checked: number;
    closed: number;
    trades: any[];
  }> {
    // Get ALL active trades across all users
    const activeTrades = await this.prisma.paperTrade.findMany({
      where: {
        status: PaperTradeStatus.ACTIVE,
      },
      include: {
        broker: true,
        user: true,
      },
    });

    if (activeTrades.length === 0) {
      this.logger.log('No active trades to square off');
      return { checked: 0, closed: 0, trades: [] };
    }

    this.logger.log(
      `🔔 SQUARE OFF: Closing ${activeTrades.length} active trades at EOD`,
    );

    const closedTrades: any[] = [];

    // Group trades by broker to minimize API calls
    const tradesByBroker = activeTrades.reduce(
      (acc, trade) => {
        const brokerId = trade.brokerId;
        if (!acc[brokerId]) {
          acc[brokerId] = [];
        }
        acc[brokerId].push(trade);
        return acc;
      },
      {} as Record<string, typeof activeTrades>,
    );

    // Process each broker's trades
    for (const [brokerId, trades] of Object.entries(tradesByBroker)) {
      const broker = trades[0].broker;

      if (!broker.accessToken) {
        this.logger.warn(
          `No access token for broker ${broker.name}. Skipping ${trades.length} trades.`,
        );
        continue;
      }

      const kc = new KiteConnect({ api_key: broker.apiKey });
      kc.setAccessToken(broker.accessToken);

      try {
        // Fetch LTP for all instruments
        const instrumentTokens = trades.map((t) => String(t.instrumentToken));
        const quotes = await kc.getQuote(instrumentTokens);

        for (const trade of trades) {
          const quote = quotes[String(trade.instrumentToken)];
          if (!quote || !quote.last_price) {
            this.logger.warn(
              `No quote data for ${trade.optionSymbol}. Closing at entry price.`,
            );
            // Close at entry price if no quote available (P&L = 0)
            const closedTrade = await this.closeTrade(
              trade.id,
              trade.entryPrice,
              PaperTradeStatus.CLOSED_EOD,
            );
            closedTrades.push(closedTrade);
            continue;
          }

          const currentPrice = quote.last_price;
          this.logger.log(
            `Squaring off ${trade.optionSymbol} for ${trade.user.email}: Entry=${trade.entryPrice}, Exit=${currentPrice}`,
          );

          const closedTrade = await this.closeTrade(
            trade.id,
            currentPrice,
            PaperTradeStatus.CLOSED_EOD,
          );
          closedTrades.push(closedTrade);
        }
      } catch (error) {
        this.logger.error(
          `Error squaring off trades for broker ${broker.name}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `✅ SQUARE OFF COMPLETE: Closed ${closedTrades.length} out of ${activeTrades.length} active trades`,
    );

    return {
      checked: activeTrades.length,
      closed: closedTrades.length,
      trades: closedTrades,
    };
  }

  /**
   * Monitor ALL active paper trades across every user every minute.
   * Checks live LTP against SL and Target levels and closes the trade
   * immediately when hit. Called by the scheduler every minute intraday.
   */
  async monitorAllActiveTrades(): Promise<{
    checked: number;
    closed: number;
  }> {
    const activeTrades = await this.prisma.paperTrade.findMany({
      where: { status: PaperTradeStatus.ACTIVE },
      include: { broker: true },
    });

    if (activeTrades.length === 0) {
      return { checked: 0, closed: 0 };
    }

    this.logger.debug(
      `[PaperMonitor] Checking ${activeTrades.length} active trade(s) for SL/Target`,
    );

    let closed = 0;

    // Group by broker to batch LTP calls
    const byBroker = activeTrades.reduce(
      (acc, t) => {
        if (!acc[t.brokerId]) acc[t.brokerId] = [];
        acc[t.brokerId].push(t);
        return acc;
      },
      {} as Record<string, typeof activeTrades>,
    );

    for (const trades of Object.values(byBroker)) {
      const broker = trades[0].broker;
      if (!broker?.accessToken) continue;

      const kc = new KiteConnect({ api_key: broker.apiKey });
      kc.setAccessToken(broker.accessToken);

      try {
        const tokens = trades.map((t) => String(t.instrumentToken));
        const quotes = await kc.getQuote(tokens);

        for (const trade of trades) {
          const quote = quotes[String(trade.instrumentToken)];
          if (!quote) continue;

          // Don't monitor the entry candle itself — the signal fires on candle
          // CLOSE, so the trade is entered at the end of that candle. Checking
          // LTP or historical highs on the same candle causes spurious SL hits
          // when the candle's intrabar range touched the SL before entry.
          // Wait until the next minute candle has started.
          const nowMinute = Math.floor(Date.now() / 60_000);
          const entryMinute = Math.floor(
            new Date(trade.entryTime).getTime() / 60_000,
          );
          if (nowMinute <= entryMinute) {
            this.logger.debug(
              `[PaperMonitor] Skipping ${trade.optionSymbol} — still on entry candle (entry=${new Date(trade.entryTime).toISOString()})`,
            );
            continue;
          }

          // Use LTP (last_price) for SL/Target detection.
          // quote.ohlc.high/low = day's high/low since 9:15 AM open — NOT the
          // current minute's candle. Using them causes false triggers: e.g. if
          // the option traded at target price early morning, ohlc.low would
          // stay at that level all day and fire the target the moment a new
          // trade is entered.  LTP represents the actual current market price.
          const ltp: number = quote.last_price;

          let newStatus: PaperTradeStatus | null = null;
          let exitPrice = ltp;

          if (trade.signalType === 'SELL') {
            // Phase 2 (BE active): T1 already hit, stopLoss moved to entryPrice.
            // Close as BE if price reverses back to entry, or continue to T2/T3.
            if (trade.t1Hit) {
              if (ltp >= trade.stopLoss) {
                // stopLoss == entryPrice here: BE triggered
                newStatus = PaperTradeStatus.CLOSED_BE;
                exitPrice = trade.entryPrice;
                this.logger.log(
                  `[PaperMonitor] BE HIT ${trade.optionSymbol}: ltp ${ltp} >= entry ${trade.entryPrice}`,
                );
              } else if (ltp <= trade.target3) {
                newStatus = PaperTradeStatus.CLOSED_TARGET3;
                exitPrice = trade.target3;
              } else if (ltp <= trade.target2) {
                newStatus = PaperTradeStatus.CLOSED_TARGET2;
                exitPrice = trade.target2;
              }
            } else {
              // Phase 1: watching for SL or Targets (T3 → T2 → T1)
              if (ltp >= trade.stopLoss) {
                newStatus = PaperTradeStatus.CLOSED_SL;
                exitPrice = trade.stopLoss;
                this.logger.log(
                  `[PaperMonitor] SL HIT ${trade.optionSymbol}: ltp ${ltp} >= SL ${trade.stopLoss}`,
                );
              } else if (ltp <= trade.target3) {
                newStatus = PaperTradeStatus.CLOSED_TARGET3;
                exitPrice = trade.target3;
                this.logger.log(
                  `[PaperMonitor] T3 HIT ${trade.optionSymbol}: ltp ${ltp} <= T3 ${trade.target3}`,
                );
              } else if (ltp <= trade.target2) {
                newStatus = PaperTradeStatus.CLOSED_TARGET2;
                exitPrice = trade.target2;
                this.logger.log(
                  `[PaperMonitor] T2 HIT ${trade.optionSymbol}: ltp ${ltp} <= T2 ${trade.target2}`,
                );
              } else if (ltp <= trade.target1) {
                newStatus = PaperTradeStatus.CLOSED_TARGET1;
                exitPrice = trade.target1;
                this.logger.log(
                  `[PaperMonitor] T1 HIT ${trade.optionSymbol}: ltp ${ltp} <= T1 ${trade.target1}`,
                );
              }
            }
          } else {
            // BUY trade — symmetric logic
            if (trade.t1Hit) {
              if (ltp <= trade.stopLoss) {
                newStatus = PaperTradeStatus.CLOSED_BE;
                exitPrice = trade.entryPrice;
                this.logger.log(
                  `[PaperMonitor] BE HIT ${trade.optionSymbol}: ltp ${ltp} <= entry ${trade.entryPrice}`,
                );
              } else if (ltp >= trade.target3) {
                newStatus = PaperTradeStatus.CLOSED_TARGET3;
                exitPrice = trade.target3;
              } else if (ltp >= trade.target2) {
                newStatus = PaperTradeStatus.CLOSED_TARGET2;
                exitPrice = trade.target2;
              }
            } else {
              // Phase 1: watching for SL or Targets (T3 → T2 → T1)
              if (ltp <= trade.stopLoss) {
                newStatus = PaperTradeStatus.CLOSED_SL;
                exitPrice = trade.stopLoss;
              } else if (ltp >= trade.target3) {
                newStatus = PaperTradeStatus.CLOSED_TARGET3;
                exitPrice = trade.target3;
                this.logger.log(
                  `[PaperMonitor] T3 HIT ${trade.optionSymbol}: ltp ${ltp} >= T3 ${trade.target3}`,
                );
              } else if (ltp >= trade.target2) {
                newStatus = PaperTradeStatus.CLOSED_TARGET2;
                exitPrice = trade.target2;
                this.logger.log(
                  `[PaperMonitor] T2 HIT ${trade.optionSymbol}: ltp ${ltp} >= T2 ${trade.target2}`,
                );
              } else if (ltp >= trade.target1) {
                newStatus = PaperTradeStatus.CLOSED_TARGET1;
                exitPrice = trade.target1;
                this.logger.log(
                  `[PaperMonitor] T1 HIT ${trade.optionSymbol}: ltp ${ltp} >= T1 ${trade.target1}`,
                );
              }
            }
          }

          if (newStatus) {
            await this.closeTrade(trade.id, exitPrice, newStatus);
            closed++;
          } else {
            // ── Catch-up scan ────────────────────────────────────────────────
            // If LTP doesn't trigger now, the server may have been offline
            // when a SL/Target was actually hit (e.g. server restart mid-day).
            // Fetch 1-min historical candles from entryTime → now and walk
            // through them to find the earliest missed hit.
            // • SL uses candle.high (SELL) / candle.low (BUY) — stop orders
            //   trigger on any touch.
            // • Targets use candle.close to avoid false wick-spike triggers.
            try {
              const entryTime = new Date(trade.entryTime);
              const nowTime = new Date();
              // Only do catch-up if trade is at least 2 minutes old
              if (nowTime.getTime() - entryTime.getTime() > 120_000) {
                // Skip the entry candle — start scanning from the candle AFTER entry.
                // The entry candle's high/low are already part of the signal's
                // price action; scanning it would falsely close the trade on the
                // same candle the signal fired.
                const catchUpFrom = new Date(entryTime.getTime() + 60_000);
                const candles: any[] = await kc.getHistoricalData(
                  trade.instrumentToken,
                  'minute',
                  catchUpFrom,
                  nowTime,
                  false,
                );

                if (candles && candles.length > 0) {
                  // Track whether T1 was hit during catch-up (for BE logic)
                  let catchUpT1Hit = trade.t1Hit;
                  let catchUpSL = trade.stopLoss; // may change to entryPrice after T1

                  for (const c of candles) {
                    const candleTime = new Date(c.date);
                    let missedStatus: PaperTradeStatus | null = null;
                    let missedPrice = 0;

                    if (trade.signalType === 'SELL') {
                      if (catchUpT1Hit) {
                        // Phase 2 (legacy BE-active trades): targets by close FIRST,
                        // then BE by high — a candle that closes at a target wins over
                        // a high that merely touched the BE level.
                        if (c.close <= trade.target3) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET3;
                          missedPrice = trade.target3;
                        } else if (c.close <= trade.target2) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET2;
                          missedPrice = trade.target2;
                        } else if (c.high >= catchUpSL) {
                          missedStatus = PaperTradeStatus.CLOSED_BE;
                          missedPrice = trade.entryPrice;
                        }
                      } else {
                        // Phase 1: SL by high, targets by close (T3 → T2 → T1)
                        if (c.high >= catchUpSL) {
                          missedStatus = PaperTradeStatus.CLOSED_SL;
                          missedPrice = catchUpSL;
                        } else if (c.close <= trade.target3) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET3;
                          missedPrice = trade.target3;
                        } else if (c.close <= trade.target2) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET2;
                          missedPrice = trade.target2;
                        } else if (c.close <= trade.target1) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET1;
                          missedPrice = trade.target1;
                        }
                      }
                    } else {
                      if (catchUpT1Hit) {
                        // Phase 2 (legacy BE-active trades): targets by close FIRST
                        if (c.close >= trade.target3) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET3;
                          missedPrice = trade.target3;
                        } else if (c.close >= trade.target2) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET2;
                          missedPrice = trade.target2;
                        } else if (c.low <= catchUpSL) {
                          missedStatus = PaperTradeStatus.CLOSED_BE;
                          missedPrice = trade.entryPrice;
                        }
                      } else {
                        // Phase 1: SL by low, targets by close (T3 → T2 → T1)
                        if (c.low <= catchUpSL) {
                          missedStatus = PaperTradeStatus.CLOSED_SL;
                          missedPrice = catchUpSL;
                        } else if (c.close >= trade.target3) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET3;
                          missedPrice = trade.target3;
                        } else if (c.close >= trade.target2) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET2;
                          missedPrice = trade.target2;
                        } else if (c.close >= trade.target1) {
                          missedStatus = PaperTradeStatus.CLOSED_TARGET1;
                          missedPrice = trade.target1;
                        }
                      }
                    }

                    if (missedStatus) {
                      this.logger.warn(
                        `[PaperMonitor] CATCH-UP: ${trade.optionSymbol} ${missedStatus} at ${missedPrice} (candle ${candleTime.toISOString()}, close=${c.close}, high=${c.high}, low=${c.low})`,
                      );
                      await this.closeTrade(
                        trade.id,
                        missedPrice,
                        missedStatus,
                        candleTime,
                      );
                      closed++;
                      break; // Stop at first hit
                    }
                  }
                }
              }
            } catch (catchUpErr: any) {
              this.logger.warn(
                `[PaperMonitor] Catch-up scan failed for ${trade.optionSymbol}: ${catchUpErr.message}`,
              );
            }
          }
        }
      } catch (err: any) {
        this.logger.error(
          `[PaperMonitor] Error for broker ${broker.name}: ${err.message}`,
        );
      }
    }

    if (closed > 0) {
      this.logger.log(
        `[PaperMonitor] Closed ${closed}/${activeTrades.length} trade(s) this tick`,
      );
    }

    return { checked: activeTrades.length, closed };
  }

  /**
   * Calculate P&L statistics
   */
  async getPnLStats(
    userId: string,
    period: 'daily' | 'weekly' | 'monthly' | 'all' = 'all',
  ): Promise<{
    totalTrades: number;
    activeTrades: number;
    closedTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnL: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    bestTrade: number;
    worstTrade: number;
  }> {
    const now = new Date();
    let fromDate: Date | undefined;

    switch (period) {
      case 'daily':
        fromDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'weekly':
        fromDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'monthly':
        fromDate = new Date(now.setDate(now.getDate() - 30));
        break;
    }

    const where: any = { userId };
    if (fromDate) {
      where.entryTime = { gte: fromDate };
    }

    const trades = await this.prisma.paperTrade.findMany({ where });

    const activeTrades = trades.filter(
      (t: PaperTrade) => t.status === PaperTradeStatus.ACTIVE,
    ).length;
    const closedTrades = trades.filter(
      (t: PaperTrade) => t.status !== PaperTradeStatus.ACTIVE,
    );

    const winningTrades = closedTrades.filter((t: PaperTrade) => t.pnl > 0);
    const losingTrades = closedTrades.filter((t: PaperTrade) => t.pnl < 0);

    const totalPnL = closedTrades.reduce(
      (sum: number, t: PaperTrade) => sum + t.pnl,
      0,
    );
    const winRate =
      closedTrades.length > 0
        ? (winningTrades.length / closedTrades.length) * 100
        : 0;

    const avgWin =
      winningTrades.length > 0
        ? winningTrades.reduce((sum: number, t: PaperTrade) => sum + t.pnl, 0) /
          winningTrades.length
        : 0;

    const avgLoss =
      losingTrades.length > 0
        ? losingTrades.reduce((sum: number, t: PaperTrade) => sum + t.pnl, 0) /
          losingTrades.length
        : 0;

    const bestTrade =
      closedTrades.length > 0
        ? Math.max(...closedTrades.map((t: PaperTrade) => t.pnl))
        : 0;
    const worstTrade =
      closedTrades.length > 0
        ? Math.min(...closedTrades.map((t: PaperTrade) => t.pnl))
        : 0;

    return {
      totalTrades: trades.length,
      activeTrades,
      closedTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      totalPnL,
      winRate,
      avgWin,
      avgLoss,
      bestTrade,
      worstTrade,
    };
  }

  /**
   * Cancel an active trade
   */
  async cancelTrade(tradeId: string): Promise<PaperTrade> {
    const trade = await this.prisma.paperTrade.findUnique({
      where: { id: tradeId },
    });

    if (!trade) {
      throw new Error('Trade not found');
    }

    if (trade.status !== PaperTradeStatus.ACTIVE) {
      throw new Error('Only active trades can be cancelled');
    }

    return this.prisma.paperTrade.update({
      where: { id: tradeId },
      data: {
        status: PaperTradeStatus.CANCELLED,
        exitTime: new Date(),
      },
    });
  }

  /**
   * Delete a paper trade (removes from database)
   */
  async deleteTrade(tradeId: string, userId: string): Promise<void> {
    const trade = await this.prisma.paperTrade.findUnique({
      where: { id: tradeId },
    });

    if (!trade) {
      throw new Error('Trade not found');
    }

    // Security check: ensure user owns this trade
    if (trade.userId !== userId) {
      throw new Error('Unauthorized to delete this trade');
    }

    await this.prisma.paperTrade.delete({
      where: { id: tradeId },
    });

    this.logger.log(`Deleted paper trade ${tradeId} for user ${userId}`);
  }

  /**
   * Check if user can place new paper trade based on daily limits
   * Returns { canTrade: boolean, reason?: string }
   * @param targetDate - The trading date to check (format: 'YYYY-MM-DD' or 'DD-MM-YYYY')
   */
  async canPlaceNewTrade(
    userId: string,
    maxDailyLoss: number = 35,
    targetDate?: string,
  ): Promise<{ canTrade: boolean; reason?: string }> {
    // Determine the date to check
    let checkDate: Date;
    if (targetDate) {
      // Parse targetDate (format: 'YYYY-MM-DD' or 'DD-MM-YYYY')
      const parts = targetDate.includes('-') ? targetDate.split('-') : [];
      if (parts.length === 3) {
        // Check if it's YYYY-MM-DD or DD-MM-YYYY
        if (parts[0].length === 4) {
          // YYYY-MM-DD
          checkDate = new Date(targetDate);
        } else {
          // DD-MM-YYYY
          checkDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        }
      } else {
        checkDate = new Date();
      }
    } else {
      checkDate = new Date();
    }

    // Get start and end of the target trading date
    const startOfDay = new Date(checkDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(checkDate);
    endOfDay.setHours(23, 59, 59, 999);

    const dayTrades = await this.prisma.paperTrade.findMany({
      where: {
        userId,
        entryTime: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    // HARD CAP FIRST: Never exceed 2 paper trades per day regardless of active
    // state. Checked before the active-trade guard to close the race window
    // where both crons (SL monitor + signal detector) fire at the same second —
    // the monitor closes Trade N just as the detector queries activeTrades=0,
    // which would otherwise allow a 3rd trade through.
    if (dayTrades.length >= 2) {
      return {
        canTrade: false,
        reason: `Daily trade limit (2 trades) reached on ${targetDate || 'this date'}.`,
      };
    }

    // Check if any trade hit target on this specific date (discipline rule)
    const targetHitOnDate = dayTrades.some(
      (t) =>
        t.status === PaperTradeStatus.CLOSED_TARGET1 ||
        t.status === PaperTradeStatus.CLOSED_TARGET2 ||
        t.status === PaperTradeStatus.CLOSED_TARGET3,
    );

    if (targetHitOnDate) {
      return {
        canTrade: false,
        reason: `Target hit on ${targetDate || 'this date'}. No more trades for discipline.`,
      };
    }

    // Check if any active trade exists
    const activeTrades = await this.prisma.paperTrade.count({
      where: {
        userId,
        status: PaperTradeStatus.ACTIVE,
      },
    });

    if (activeTrades > 0) {
      return {
        canTrade: false,
        reason: 'Active trade exists. Wait for it to close.',
      };
    }

    // Check daily loss limit for this specific date
    const closedTradesOnDate = dayTrades.filter(
      (t) => t.status !== PaperTradeStatus.ACTIVE,
    );
    const datePnL = closedTradesOnDate.reduce((sum, t) => sum + t.pnl, 0);

    if (datePnL <= -maxDailyLoss) {
      return {
        canTrade: false,
        reason: `Daily loss limit (${maxDailyLoss} points) reached on ${targetDate || 'this date'}. P&L: ${datePnL.toFixed(2)}`,
      };
    }

    return { canTrade: true };
  }

  /**
   * Get today's trading statistics
   */
  async getTodayStats(userId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayTrades = await this.prisma.paperTrade.findMany({
      where: {
        userId,
        entryTime: { gte: startOfDay },
      },
    });

    const activeTrades = todayTrades.filter(
      (t) => t.status === PaperTradeStatus.ACTIVE,
    );
    const closedTrades = todayTrades.filter(
      (t) => t.status !== PaperTradeStatus.ACTIVE,
    );
    const todayPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const targetHit = todayTrades.some(
      (t) =>
        t.status === PaperTradeStatus.CLOSED_TARGET1 ||
        t.status === PaperTradeStatus.CLOSED_TARGET2 ||
        t.status === PaperTradeStatus.CLOSED_TARGET3,
    );

    return {
      totalTrades: todayTrades.length,
      activeTrades: activeTrades.length,
      closedTrades: closedTrades.length,
      todayPnL,
      targetHit,
    };
  }

  /**
   * Delete all paper trades for a user
   */
  async deleteAllTrades(userId: string): Promise<{ deleted: number }> {
    const result = await this.prisma.paperTrade.deleteMany({
      where: {
        userId: userId,
      },
    });

    this.logger.log(
      `Deleted all ${result.count} paper trades for user ${userId}`,
    );

    return { deleted: result.count };
  }
}

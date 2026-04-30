import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KiteService } from '../services/kite.service';
import { TradingService } from '../services/trading.service';
import { SignalsService } from '../services/signals.service';
import { LiveTradingService } from '../services/live-trading.service';
import { KiteTickerService } from '../services/kite-ticker.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaperTradingService } from '../../paper-trading/services/paper-trading.service';
import { WhatsAppService } from '../services/whatsapp.service';
import https from 'https';
import { parse } from 'csv-parse/sync';

@Injectable()
export class KiteScheduler {
  private readonly logger = new Logger(KiteScheduler.name);
  private isRunning = false;
  private runStartedAt = 0; // epoch ms when the current run started
  private isSyncingInstruments = false;

  constructor(
    private readonly kiteService: KiteService,
    private readonly tradingService: TradingService,
    private readonly signalsService: SignalsService,
    private readonly prisma: PrismaService,
    private readonly paperTradingService: PaperTradingService,
    private readonly liveTradingService: LiveTradingService,
    private readonly whatsAppService: WhatsAppService,
    private readonly kiteTickerService: KiteTickerService,
  ) {}

  /**
   * Runs at exactly 9:15 AM IST on weekdays to proactively select and persist
   * the ATM-based CE + PE strikes into the StrikeSelection DB table.
   * All subsequent scans (auto-trader and Trade Finder) will use this record
   * instead of recomputing strikes from the live spot price.
   */
  @Cron('15 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async selectStrikesAtMarketOpen(): Promise<void> {
    this.logger.log('⚡ 9:15 AM — Running proactive strike selection');

    const brokers = await this.prisma.broker.findMany();
    const activeBrokers = brokers.filter(
      (b) =>
        b.accessToken &&
        b.accessTokenExpiresAt &&
        b.accessTokenExpiresAt.getTime() > Date.now(),
    );

    if (activeBrokers.length === 0) {
      this.logger.warn('[StrikeSelection] No active brokers — skipping');
      return;
    }

    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });

    for (const broker of activeBrokers) {
      const expiryData = await this.kiteService
        .getExpiryDates('NSE', 'NIFTY')
        .catch(() => null);
      if (!expiryData?.expiries?.length) {
        this.logger.warn(
          `[StrikeSelection] No expiry data for broker ${broker.name}`,
        );
        continue;
      }
      const expiry = expiryData.expiries[0];

      for (const symbol of ['NIFTY', 'BANKNIFTY']) {
        try {
          const result = await this.tradingService.selectAndSaveStrike(
            broker.id,
            symbol,
            today,
            expiry,
          );
          if (result) {
            this.logger.log(
              `[StrikeSelection] ${symbol} ${today}: CE=${result.ceInstrument.tradingsymbol} PE=${result.peInstrument.tradingsymbol}`,
            );
          }
        } catch (err) {
          this.logger.error(
            `[StrikeSelection] Error selecting strike for ${symbol}: ${err.message}`,
          );
        }
      }
    }
  }

  /**
   * Runs every minute during market hours (9:15 AM – 2:30 PM IST).
   * Cron fires every minute in the 9–15 hour band; the inner time guard
   * (`isBeforeMarketOpen` / `isAfterMarketClose`) enforces the exact window.
   */
  @Cron('*/1 9-15 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async runOptionMonitorDuringMarketHours() {
    const { hour, minute } = this.getISTTime();

    // Market hours: 9:15 AM to 2:30 PM IST (no new trades after 2:30 PM)
    const isBeforeMarketOpen = hour < 9 || (hour === 9 && minute < 15);
    const isAfterMarketClose = hour > 14 || (hour === 14 && minute > 30);

    if (isBeforeMarketOpen || isAfterMarketClose) {
      this.logger.debug('Outside market hours. Skipping...');
      return;
    }

    await this.coreRun();
  }

  /**
   * Manual trigger — bypasses the market-hours time guard.
   * Called from POST /live-trades/run-now for on-demand testing.
   */
  async runNow(): Promise<void> {
    this.logger.log(
      '🔧 Manual trigger: running scheduler logic NOW (time guard bypassed)',
    );
    // Reset the lock in case a previous run got stuck
    this.isRunning = false;
    await this.coreRun();
  }

  private async coreRun(): Promise<void> {
    // Prevent concurrent runs.
    // Safety valve: if a previous run has been stuck for > 25 seconds,
    // force-release the lock so we don't miss multiple consecutive cron ticks.
    if (this.isRunning) {
      const elapsed = Date.now() - this.runStartedAt;
      // With candle caching, runs should complete in < 5s; 25s is a generous
      // safety valve that still recovers quickly if Kite API hangs momentarily.
      if (elapsed < 25_000) {
        this.logger.warn(
          `⏳ Previous run still in progress (${Math.round(elapsed / 1000)}s elapsed). Skipping this cycle.`,
        );
        return;
      }
      this.logger.warn(
        `⚠️ Previous run has been stuck for ${Math.round(elapsed / 1000)}s — force-releasing lock and retrying.`,
      );
    }

    this.isRunning = true;
    this.runStartedAt = Date.now();

    const runStart = Date.now();
    try {
      this.logger.log('🤖 Auto-running Option Monitor (Market Hours)');

      // Get all brokers
      const allBrokers = await this.prisma.broker.findMany();

      if (allBrokers.length === 0) {
        this.logger.warn(
          '⚠️  No brokers configured. Please add a broker and generate access token.',
        );
        return;
      }

      // Filter for active brokers with valid access tokens
      const brokers = allBrokers.filter(
        (b) =>
          b.accessToken &&
          b.accessTokenExpiresAt &&
          b.accessTokenExpiresAt.getTime() > Date.now(),
      );

      // Log expired tokens
      const expiredBrokers = allBrokers.filter(
        (b) =>
          (!b.accessToken ||
            !b.accessTokenExpiresAt ||
            b.accessTokenExpiresAt.getTime() <= Date.now()) &&
          b.lastConnectedAt, // Only warn if they were connected before
      );

      if (expiredBrokers.length > 0) {
        this.logger.warn(
          `🔴 ${expiredBrokers.length} broker(s) have expired access tokens:`,
        );
        expiredBrokers.forEach((b) => {
          this.logger.warn(
            `   - ${b.name} (${b.type}): Token expired. Please reconnect at /brokers`,
          );
        });
      }

      if (brokers.length === 0) {
        this.logger.warn(
          '⚠️  No active brokers with valid tokens. Skipping auto-trade.',
        );
        return;
      }

      // ── Fetch shared data once (expiry + time snapshot) ─────────────────
      // These are the same for all brokers; compute once to avoid N redundant
      // calls inside the per-broker loop.
      const expiryData = await this.kiteService.getExpiryDates('NSE', 'NIFTY');
      if (
        !expiryData ||
        !expiryData.expiries ||
        expiryData.expiries.length === 0
      ) {
        this.logger.warn('No expiry dates found');
        return;
      }
      const nextExpiry = expiryData.expiries[0];
      const runNow = new Date();
      // Use IST calendar date — toISOString() returns UTC which can be a
      // different calendar day near midnight IST (UTC+5:30 = UTC-18:30 boundary).
      const today = runNow.toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kolkata',
      });
      const currentTime = runNow.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      this.logger.log(
        `Running strategies for ${today} at ${currentTime} | ${brokers.length} broker(s)`,
      );

      // Active strategies for auto-trading — Super Power Pack (DHR + DLB + EMA)
      const strategies = ['SUPER_POWER_PACK'] as const;

      // ── Run all brokers in parallel ───────────────────────────────────────
      // Processing brokers sequentially adds N×optionMonitor latency before the
      // last broker's signal is detected; running in parallel cuts wall-clock
      // time to a single optionMonitor call regardless of broker count.
      await Promise.all(
        brokers.map(async (broker) => {
          try {
            this.logger.log(
              `Running for broker: ${broker.name} (User: ${broker.userId})`,
            );

            // Run each strategy
            for (const strategy of strategies) {
              try {
                this.logger.log(`Running ${strategy} strategy...`);

                // Strike selection is handled by the StrikeSelection DB table.
                // The selectAndSaveStrike() method is called lazily inside
                // optionMonitor → no need for an in-memory cache here.
                const monitorStart = Date.now();
                const result = await this.tradingService.optionMonitor(
                  broker.id,
                  'NIFTY',
                  nextExpiry,
                  20, // margin points
                  today, // target date
                  '5minute', // MUST match Trade Finder default — SPPP patterns are designed for 5-min candles.
                  // Using 'minute' would run DLB/DHR/EMA-REJ on 1m bars and generate
                  // false early-morning signals that Trade Finder never shows.
                  currentTime, // Use current time for live data
                  strategy,
                  true, // realtimeMode: only check the latest candle for patterns
                  'live',
                );
                this.logger.log(
                  `⏱️ [${broker.name}] optionMonitor took ${Date.now() - monitorStart}ms`,
                );

                // Save all signals to database
                if (result.options && result.options.length > 0) {
                  // ── Stop SELL trading if any SELL live trade already hit target ──
                  // BUY (complementary) signals are independent and not blocked here.
                  // Use hedgeQty > 0 as proxy for SELL trades (BUY trades have hedgeQty=0).
                  const todayStartForCheck = new Date(today + 'T00:00:00.000Z');
                  const todayEndForCheck = new Date(today + 'T23:59:59.999Z');
                  const sellTargetHitToday =
                    await this.prisma.liveTrade.findFirst({
                      where: {
                        userId: broker.userId,
                        strategy: strategy,
                        status: 'TARGET_HIT',
                        hedgeQty: { gt: 0 }, // SELL trades have a hedge; BUY trades don't
                        createdAt: {
                          gte: todayStartForCheck,
                          lte: todayEndForCheck,
                        },
                      },
                    });

                  if (sellTargetHitToday) {
                    this.logger.log(
                      `🎯 SELL target already hit today for [${strategy}] (trade: ${sellTargetHitToday.optionSymbol}) — no more SELL trades for the day.`,
                    );
                    // Do not 'continue' here — BUY signals below will still be
                    // processed by the option/signal loop independently.
                  }

                  for (const option of result.options) {
                    if (option.signals && option.signals.length > 0) {
                      for (const signal of option.signals) {
                        try {
                          const todayStart = new Date(today + 'T00:00:00.000Z');
                          const todayEnd = new Date(today + 'T23:59:59.999Z');

                          // ── Daily completion gate (SELL + BUY) ────────────────
                          // Once a SELL trade hits its target, the day is done —
                          // block both SELL and complementary BUY signals.
                          if (sellTargetHitToday) {
                            this.logger.log(
                              `🎯 Signal skipped: SELL target already hit today for [${strategy}] (trade: ${sellTargetHitToday.optionSymbol})`,
                            );
                            continue;
                          }

                          if (signal.recommendation === 'SELL') {
                            // (sellTargetHitToday already checked above)

                            // Max 2 SELL trades per strategy per day.
                            const todaySignalCount =
                              await this.prisma.signal.count({
                                where: {
                                  userId: broker.userId,
                                  strategy: strategy,
                                  signalType: 'SELL',
                                  signalDate: {
                                    gte: todayStart,
                                    lte: todayEnd,
                                  },
                                },
                              });
                            if (todaySignalCount >= 2) {
                              this.logger.debug(
                                `⏭️ Daily 2-trade limit reached for [${strategy}] — skipping SELL ${option.tradingsymbol}`,
                              );
                              continue;
                            }
                          }

                          // Avoid exact duplicate: same option + same signal direction already saved today.
                          // Use signalType filter so a complementary BUY on PE does not block
                          // a subsequent primary SELL on the same PE option.
                          const duplicateSignal =
                            await this.prisma.signal.findFirst({
                              where: {
                                userId: broker.userId,
                                optionSymbol: option.tradingsymbol,
                                signalType: signal.recommendation as any,
                                strategy: strategy,
                                signalDate: { gte: todayStart, lte: todayEnd },
                              },
                            });

                          if (duplicateSignal) {
                            this.logger.debug(
                              `⏭️ Signal already captured today for ${option.tradingsymbol} [${strategy}] @ ${duplicateSignal.signalTime} — skipping duplicate`,
                            );
                            continue;
                          }

                          // ── Swing-high-aware SL/Target (from signal analysis) ──
                          // detectDaySellSignals() computed:
                          //   SL = nearest swing high + 2 (if 8–30 pts above entry), else entry + 30
                          //   Target = 2× risk below entry (always 1:2 RRR)
                          // Use signal.price as entry for consistency with signal analysis.
                          const liveEntry = signal.price;
                          const savedSL = Math.round(signal.stopLoss);
                          // SUPER_POWER_PACK sub-strategies set target1=1:1 and target2=1:2.
                          // Use target2 (1:2 RR) as the live order target.
                          const savedTarget = Math.max(
                            Math.round(signal.target2 ?? signal.target1),
                            1,
                          );

                          // ── WhatsApp notification — fired IMMEDIATELY after duplicate
                          // check, before the DB save, to minimise notification latency.
                          // The duplicate guard above already confirmed this is a new signal.
                          this.whatsAppService
                            .sendSignalAlert({
                              optionSymbol: option.tradingsymbol,
                              entry: liveEntry,
                              stopLoss: savedSL,
                              target: savedTarget,
                              reason: signal.reason ?? 'N/A',
                              strategy: strategy,
                              time: signal.time ?? currentTime,
                              optionType: option.optionType,
                              qty: signal.qty || option.lotSize,
                              lotSize: option.lotSize,
                              score: signal.score,
                              direction: signal.recommendation ?? 'SELL',
                            })
                            .catch((err: any) =>
                              this.logger.error(
                                `WhatsApp alert failed for ${option.tradingsymbol}: ${err.message}`,
                              ),
                            );

                          const savedSignal =
                            await this.signalsService.saveSignal({
                              userId: broker.userId,
                              brokerId: broker.id,
                              symbol: option.symbol,
                              optionSymbol: option.tradingsymbol,
                              instrumentToken: option.instrumentToken,
                              strike: option.strike,
                              optionType: option.optionType,
                              expiryDate: nextExpiry,
                              signalType: signal.recommendation,
                              strategy: strategy,
                              signalReason: signal.reason,
                              signalTime: signal.time,
                              signalDate: new Date(today),
                              entryPrice: liveEntry,
                              stopLoss: savedSL,
                              target1: Math.max(Math.round(signal.target1), 1),
                              target2: Math.max(
                                Math.round(signal.target2 ?? signal.target1),
                                1,
                              ),
                              target3: Math.max(
                                Math.round(
                                  signal.target3 ??
                                    signal.target2 ??
                                    signal.target1,
                                ),
                                1,
                              ),
                              ltp: option.ltp,
                              marginPoints: 20,
                              interval: 'minute',
                              targetDate: today,
                              confidenceScore: signal.confidenceScore,
                              confidenceGrade: signal.confidenceGrade,
                            });

                          // Attach signal ID to the signal object for later use
                          signal.signalId = savedSignal.id;

                          // If optionMonitor already created a paper trade for this
                          // signal, mark it as traded now that the Signal DB row exists.
                          if (signal.paperTradeId) {
                            await this.signalsService
                              .markSignalAsTraded(
                                savedSignal.id,
                                signal.paperTradeId,
                              )
                              .catch((err) =>
                                this.logger.error(
                                  `Failed to mark signal ${savedSignal.id} as traded: ${err.message}`,
                                ),
                              );
                          }

                          // ── Real-time signal monitoring via WebSocket ticker ──────
                          // watchSignal registers this signal with KiteTickerService so
                          // that every LTP tick from Kite's WebSocket is checked against
                          // the signal's 1:1 / target / SL levels. Alerts fire instantly
                          // (no polling delay) and always use the signal's own entry price,
                          // keeping all three notifications consistent.
                          //
                          // skipOneToOne for SELL signals: when a live SELL order fills,
                          // LiveTradingService calls watchTrade() which sends the 1:1 alert
                          // using the actual fill price (entryFilledPrice). Allowing
                          // watchSignal to ALSO send a 1:1 alert would produce a duplicate
                          // notification at a potentially different (signal vs fill) price.
                          // BUY complementary signals have no live fill path, so their 1:1
                          // must come from watchSignal.
                          const isNewSignal =
                            savedSignal.createdAt &&
                            Date.now() -
                              new Date(savedSignal.createdAt).getTime() <
                              180_000;

                          if (isNewSignal) {
                            const isSellSignal =
                              signal.recommendation === 'SELL';
                            this.kiteTickerService
                              .watchSignal({
                                signalId: savedSignal.id,
                                brokerId: broker.id,
                                optionSymbol: option.tradingsymbol,
                                instrumentToken: option.instrumentToken,
                                entryPrice: liveEntry,
                                slPrice: savedSL,
                                direction:
                                  (signal.recommendation as 'SELL' | 'BUY') ??
                                  'SELL',
                                strategy: strategy,
                                qty: signal.qty || option.lotSize || 75,
                                skipOneToOne: isSellSignal,
                              })
                              .catch((err: any) =>
                                this.logger.error(
                                  `watchSignal failed for ${option.tradingsymbol}: ${err.message}`,
                                ),
                              );
                          }

                          // ── Confidence gate: SELL signals only, skip grade C ────────
                          // BUY complementary signals don't have a grade — never blocked.
                          // SELL grade C (score 0–2, most filters failing) → save & notify
                          // but don't auto-trade.
                          if (
                            signal.recommendation === 'SELL' &&
                            signal.confidenceGrade === 'C'
                          ) {
                            this.logger.warn(
                              `⛔ Live order blocked: ${option.tradingsymbol} grade=C score=${signal.confidenceScore ?? 'N/A'} — signal saved & notified but not auto-traded`,
                            );
                            continue;
                          }

                          // ── Live order placement (BUY and SELL) ────────────────────
                          if (isNewSignal) {
                            this.liveTradingService
                              .executeLiveOrder({
                                signal: {
                                  id: savedSignal.id,
                                  symbol: option.symbol,
                                  optionSymbol: option.tradingsymbol,
                                  instrumentToken: option.instrumentToken,
                                  strike: option.strike,
                                  optionType: option.optionType,
                                  expiryDate: nextExpiry,
                                  signalType: signal.recommendation,
                                  strategy: strategy,
                                  entryPrice: liveEntry,
                                  stopLoss: savedSL,
                                  target1: savedTarget,
                                  ltp: option.ltp,
                                  exchange: 'NFO',
                                  lotSize: option.lotSize || 75,
                                },
                                brokerId: broker.id,
                                userId: broker.userId,
                              })
                              .catch((err) =>
                                this.logger.error(
                                  `Live order failed for signal ${savedSignal.id}: ${err.message}`,
                                ),
                              );
                          }
                        } catch (error: any) {
                          this.logger.error(
                            `Failed to save signal: ${error.message}`,
                          );
                        }
                      }
                    }
                  }
                }

                this.logger.log(
                  `✅ ${strategy} completed: ${result.options?.length || 0} options analyzed`,
                );
              } catch (strategyError: any) {
                this.logger.error(
                  `Failed to run ${strategy}: ${strategyError.message}`,
                );
              }
            }

            this.logger.log(
              `✅ Completed for broker: ${broker.name} (${Date.now() - runStart}ms total)`,
            );
          } catch (error: any) {
            this.logger.error(
              `Failed to run for broker ${broker.name}: ${error.message}`,
            );
          }
        }),
      ); // end Promise.all(brokers)

      this.logger.log(`⏱️ coreRun total: ${Date.now() - runStart}ms`);
    } catch (error: any) {
      this.logger.error(`Auto-run failed: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Market open check at 9:15 AM
   */
  @Cron('15 9 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async onMarketOpen() {
    this.logger.log('🔔 Market is now OPEN. Starting automated monitoring...');
  }

  /**
   * Market close notification at 2:30 PM
   */
  @Cron('30 14 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async onMarketClose() {
    this.logger.log(
      '🔔 Market is now CLOSED. Stopping automated monitoring...',
    );
    // Clear all signal WebSocket watchers — no need to monitor after hours
    this.kiteTickerService.unwatchAllSignals();
  }

  /**
   * Monitor live trades every minute during market hours (9:15 AM - 3:15 PM)
   * Checks order fills and advances the live trade lifecycle
   */
  @Cron('* 9-15 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async monitorLiveTradesEveryMinute() {
    const { hour, minute } = this.getISTTime();

    const isBeforeMarket = hour < 9 || (hour === 9 && minute < 15);
    const isAfterMarket = hour > 15 || (hour === 15 && minute > 15);

    if (isBeforeMarket || isAfterMarket) return;

    try {
      await this.liveTradingService.monitorLiveTrades();
    } catch (err: any) {
      this.logger.error(`Live trade monitor failed: ${err.message}`);
    }
  }

  /**
   * Monitor paper trades every minute during market hours (9:15 AM - 3:15 PM)
   * Checks live high/low against SL and Target levels and closes immediately on hit.
   */
  @Cron('* 9-15 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async monitorPaperTradesEveryMinute() {
    const { hour, minute } = this.getISTTime();

    const isBeforeMarket = hour < 9 || (hour === 9 && minute < 15);
    const isAfterMarket = hour > 15 || (hour === 15 && minute > 15);

    if (isBeforeMarket || isAfterMarket) return;

    try {
      const result = await this.paperTradingService.monitorAllActiveTrades();

      // Paper trade monitor runs only to keep PaperTrade DB status (entryTime,
      // exitPrice, pnl, status) accurate for P&L tracking and the dashboard.
      // WhatsApp notifications for 1:1 / Target / SL are now handled exclusively
      // by KiteTickerService.watchSignal() which fires instantly on every
      // WebSocket LTP tick and always uses the signal's own entry price.
      if (result.oneToOneAlerts.length > 0) {
        this.logger.debug(
          `[PaperMonitor] ${result.oneToOneAlerts.length} 1:1 level(s) reached (DB updated; WhatsApp handled by WebSocket ticker)`,
        );
      }
      if (result.closedTrades.length > 0) {
        this.logger.debug(
          `[PaperMonitor] ${result.closedTrades.length} trade(s) closed (DB updated; WhatsApp handled by WebSocket ticker)`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Paper trade monitor failed: ${err.message}`);
    }
  }

  /**
   * Auto square-off at 3:10 PM (15:10)
   * Close all active trades at end of day to prevent overnight positions
   */
  @Cron('10 15 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async autoSquareOffTrades() {
    this.logger.log('🔔 AUTO SQUARE-OFF: Starting EOD square-off at 3:10 PM');

    try {
      const result = await this.paperTradingService.squareOffActiveTrades();

      if (result.closed > 0) {
        this.logger.log(
          `✅ SQUARE-OFF COMPLETE: Closed ${result.closed} out of ${result.checked} active trades`,
        );
      } else {
        this.logger.log('✅ No active trades to square off');
      }
    } catch (error) {
      this.logger.error(`❌ Square-off failed: ${error.message}`, error.stack);
    }

    // Also square off all live trades
    try {
      await this.liveTradingService.squareOffAllLiveTrades();
    } catch (error) {
      this.logger.error(
        `❌ Live trade EOD square-off failed: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Daily Instruments Sync at 7:30 AM (before market opens)
   * Downloads latest instruments from Kite and updates database
   * Preserves historical data for backtesting
   */
  @Cron('40 8 * * 1-6', {
    timeZone: 'Asia/Kolkata',
  })
  async dailyInstrumentsSync() {
    if (this.isSyncingInstruments) {
      this.logger.warn('Instruments sync already in progress. Skipping...');
      return;
    }

    this.isSyncingInstruments = true;
    this.logger.log('🔄 Starting daily instruments sync from Kite API...');

    try {
      const csvContent = await this.downloadInstrumentsFromKite();
      const stats = await this.syncInstruments(csvContent);

      this.logger.log(
        `✅ Instruments sync complete! New: ${stats.inserted}, Updated: ${stats.updated}, Total: ${stats.total}`,
      );

      if (stats.newInstruments > 0) {
        this.logger.log(
          `🆕 ${stats.newInstruments} new instruments added today`,
        );
      }
    } catch (error) {
      this.logger.error(
        `❌ Instruments sync failed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isSyncingInstruments = false;
    }
  }

  /**
   * Download instruments CSV from Kite API
   */
  private async downloadInstrumentsFromKite(): Promise<string> {
    const url = 'https://api.kite.trade/instruments';
    this.logger.log(`Downloading from ${url}...`);

    return new Promise((resolve, reject) => {
      https
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `HTTP ${response.statusCode}: ${response.statusMessage}`,
              ),
            );
            return;
          }

          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const content = Buffer.concat(chunks).toString('utf-8');
            this.logger.log(
              `Downloaded ${(content.length / 1024 / 1024).toFixed(2)} MB`,
            );
            resolve(content);
          });
          response.on('error', reject);
        })
        .on('error', reject);
    });
  }

  /**
   * Sync instruments to database
   */
  private async syncInstruments(csvContent: string): Promise<{
    inserted: number;
    updated: number;
    total: number;
    newInstruments: number;
  }> {
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

    const records: InstrumentRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    this.logger.log(`Parsed ${records.length} instruments from CSV`);

    const today = new Date();
    let inserted = 0;
    let updated = 0;
    const batchSize = 500;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);

      for (const row of batch) {
        try {
          const instrumentToken = parseInt(row.instrument_token);

          const existing = await this.prisma.instrument.findUnique({
            where: { instrumentToken },
            select: { id: true },
          });

          if (existing) {
            await this.prisma.instrument.update({
              where: { instrumentToken },
              data: {
                exchangeToken: parseInt(row.exchange_token),
                tradingsymbol: row.tradingsymbol,
                name: row.name || null,
                lastPrice: parseFloat(row.last_price) || 0,
                tickSize: parseFloat(row.tick_size),
                lotSize: parseInt(row.lot_size),
                lastSeenDate: today,
              },
            });
            updated++;
          } else {
            await this.prisma.instrument.create({
              data: {
                instrumentToken,
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
                firstSeenDate: today,
              },
            });
            inserted++;
          }
        } catch (error) {
          this.logger.error(
            `Error processing ${row.tradingsymbol}: ${error.message}`,
          );
        }
      }
    }

    const totalCount = await this.prisma.instrument.count();

    // Count new instruments (first seen today)
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);

    const newInstruments = await this.prisma.instrument.count({
      where: {
        firstSeenDate: { gte: startOfDay },
      },
    });

    return {
      inserted,
      updated,
      total: totalCount,
      newInstruments,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Returns current hour and minute in IST, regardless of server timezone. */
  private getISTTime(): { hour: number; minute: number } {
    const ist = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    return { hour: ist.getHours(), minute: ist.getMinutes() };
  }

  // ─── EOD Candle Cache ──────────────────────────────────────────────────────

  /**
   * Runs at 3:30 PM IST on weekdays.
   * For every strike selected today (via StrikeSelection), fetches the full
   * day's 1m and 5m candles from Kite and persists them into CandleCache.
   * This allows replay of expired options data in future simulations.
   */
  @Cron('30 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async saveEodCandleCache(): Promise<void> {
    this.logger.log('📦 EOD Candle Cache: Starting snapshot save...');

    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });

    // Fetch all strike selections made today across all brokers
    const selections = await this.prisma.strikeSelection.findMany({
      where: { date: today },
      include: { broker: true },
    });

    if (selections.length === 0) {
      this.logger.warn(
        `[EOD Cache] No StrikeSelection records found for ${today} — nothing to cache`,
      );
      return;
    }

    // Deduplicate tokens (multiple brokers may share same expiry/strike)
    type TokenEntry = {
      instrumentToken: number;
      tradingsymbol: string;
      brokerId: string;
      accessToken: string;
      apiKey: string;
    };
    const tokenMap = new Map<number, TokenEntry>();
    for (const sel of selections) {
      if (!sel.broker.accessToken || !sel.broker.apiKey) continue;
      const entry = {
        brokerId: sel.brokerId,
        accessToken: sel.broker.accessToken,
        apiKey: sel.broker.apiKey,
      };
      tokenMap.set(sel.ceInstrumentToken, {
        instrumentToken: sel.ceInstrumentToken,
        tradingsymbol: sel.ceTradingSymbol,
        ...entry,
      });
      tokenMap.set(sel.peInstrumentToken, {
        instrumentToken: sel.peInstrumentToken,
        tradingsymbol: sel.peTradingSymbol,
        ...entry,
      });
    }

    if (tokenMap.size === 0) {
      this.logger.warn('[EOD Cache] No valid broker tokens found — skipping');
      return;
    }

    const { KiteConnect } = await import('kiteconnect');
    const intervals = ['minute', '5minute'] as const;
    const todayFrom = `${today} 09:15:00`;
    const todayTo = `${today} 15:29:59`;

    let saved = 0;
    let failed = 0;

    for (const entry of tokenMap.values()) {
      const kc = new KiteConnect({ api_key: entry.apiKey });
      kc.setAccessToken(entry.accessToken);

      for (const interval of intervals) {
        try {
          let candles = await kc.getHistoricalData(
            entry.instrumentToken,
            interval,
            todayFrom,
            todayTo,
          );

          // Retry once on empty response (possible rate-limit hit)
          if (!candles || candles.length === 0) {
            this.logger.warn(
              `[EOD Cache] Empty response for ${entry.tradingsymbol} ${interval} — retrying in 1s`,
            );
            await new Promise((r) => setTimeout(r, 1000));
            candles = await kc.getHistoricalData(
              entry.instrumentToken,
              interval,
              todayFrom,
              todayTo,
            );
          }

          if (!candles || candles.length === 0) {
            this.logger.warn(
              `[EOD Cache] No ${interval} candles for ${entry.tradingsymbol} after retry — skipping`,
            );
            continue;
          }

          await this.prisma.candleCache.upsert({
            where: {
              instrumentToken_dateStr_interval: {
                instrumentToken: entry.instrumentToken,
                dateStr: today,
                interval,
              },
            },
            update: {
              tradingsymbol: entry.tradingsymbol,
              candlesJson: JSON.stringify(candles),
              savedAt: new Date(),
            },
            create: {
              instrumentToken: entry.instrumentToken,
              tradingsymbol: entry.tradingsymbol,
              dateStr: today,
              interval,
              candlesJson: JSON.stringify(candles),
              savedAt: new Date(),
            },
          });

          saved++;
          this.logger.log(
            `[EOD Cache] Saved ${candles.length} × ${interval} candles for ${entry.tradingsymbol}`,
          );
        } catch (err: any) {
          failed++;
          this.logger.error(
            `[EOD Cache] Failed to save ${interval} candles for ${entry.tradingsymbol}: ${err.message}`,
          );
        }

        // Delay between Kite API calls (stay under 3 req/s)
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.logger.log(
      `📦 EOD Candle Cache complete: ${saved} saved, ${failed} failed (${tokenMap.size} instruments)`,
    );
  }

  /**
   * Manual trigger — saves EOD candle cache for a specific date.
   * Called from POST /kite/save-candle-cache?date=YYYY-MM-DD
   */
  async saveEodCandleCacheForDate(date: string): Promise<{
    saved: number;
    failed: number;
    instruments: number;
  }> {
    this.logger.log(`📦 EOD Candle Cache (manual): Saving for date=${date}`);

    const selections = await this.prisma.strikeSelection.findMany({
      where: { date },
      include: { broker: true },
    });

    if (selections.length === 0) {
      this.logger.warn(
        `[EOD Cache] No StrikeSelection records for ${date} — nothing to cache`,
      );
      return { saved: 0, failed: 0, instruments: 0 };
    }

    type TokenEntry = {
      instrumentToken: number;
      tradingsymbol: string;
      apiKey: string;
      accessToken: string;
    };
    const tokenMap = new Map<number, TokenEntry>();
    for (const sel of selections) {
      if (!sel.broker.accessToken || !sel.broker.apiKey) continue;
      const base = {
        apiKey: sel.broker.apiKey,
        accessToken: sel.broker.accessToken,
      };
      tokenMap.set(sel.ceInstrumentToken, {
        instrumentToken: sel.ceInstrumentToken,
        tradingsymbol: sel.ceTradingSymbol,
        ...base,
      });
      tokenMap.set(sel.peInstrumentToken, {
        instrumentToken: sel.peInstrumentToken,
        tradingsymbol: sel.peTradingSymbol,
        ...base,
      });
    }

    const { KiteConnect } = await import('kiteconnect');
    const intervals = ['minute', '5minute'] as const;
    const dateFrom = `${date} 09:15:00`;
    const dateTo = `${date} 15:29:59`;

    let saved = 0;
    let failed = 0;

    for (const entry of tokenMap.values()) {
      const kc = new KiteConnect({ api_key: entry.apiKey });
      kc.setAccessToken(entry.accessToken);

      for (const interval of intervals) {
        try {
          let candles = await kc.getHistoricalData(
            entry.instrumentToken,
            interval,
            dateFrom,
            dateTo,
          );

          // Retry once on empty response (possible rate-limit hit)
          if (!candles || candles.length === 0) {
            this.logger.warn(
              `[EOD Cache] Empty response for ${entry.tradingsymbol} ${interval} — retrying in 1s`,
            );
            await new Promise((r) => setTimeout(r, 1000));
            candles = await kc.getHistoricalData(
              entry.instrumentToken,
              interval,
              dateFrom,
              dateTo,
            );
          }

          if (!candles || candles.length === 0) {
            this.logger.warn(
              `[EOD Cache] No ${interval} candles for ${entry.tradingsymbol} after retry — skipping`,
            );
            continue;
          }

          await this.prisma.candleCache.upsert({
            where: {
              instrumentToken_dateStr_interval: {
                instrumentToken: entry.instrumentToken,
                dateStr: date,
                interval,
              },
            },
            update: {
              tradingsymbol: entry.tradingsymbol,
              candlesJson: JSON.stringify(candles),
              savedAt: new Date(),
            },
            create: {
              instrumentToken: entry.instrumentToken,
              tradingsymbol: entry.tradingsymbol,
              dateStr: date,
              interval,
              candlesJson: JSON.stringify(candles),
              savedAt: new Date(),
            },
          });

          saved++;
          this.logger.log(
            `[EOD Cache] Saved ${candles.length} × ${interval} candles for ${entry.tradingsymbol}`,
          );
        } catch (err: any) {
          failed++;
          this.logger.error(
            `[EOD Cache] ${interval} for ${entry.tradingsymbol}: ${err.message}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return { saved, failed, instruments: tokenMap.size };
  }
}

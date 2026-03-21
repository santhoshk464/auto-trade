import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KiteService } from '../services/kite.service';
import { TradingService } from '../services/trading.service';
import { SignalsService } from '../services/signals.service';
import { LiveTradingService } from '../services/live-trading.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaperTradingService } from '../../paper-trading/services/paper-trading.service';
import https from 'https';
import { parse } from 'csv-parse/sync';

@Injectable()
export class KiteScheduler {
  private readonly logger = new Logger(KiteScheduler.name);
  private isRunning = false;
  private isSyncingInstruments = false;

  /**
   * Per-broker, per-strategy strike cache for DAY_SELLING.
   * Strikes are locked for 2 hours then re-selected from live NIFTY spot.
   * Schedule: 9:15 → lock, 11:15 → re-lock, 13:15 → re-lock
   */
  private strikeCache = new Map<
    string,
    { date: string; lockedAt: number; instruments: any[] }
  >();

  constructor(
    private readonly kiteService: KiteService,
    private readonly tradingService: TradingService,
    private readonly signalsService: SignalsService,
    private readonly prisma: PrismaService,
    private readonly paperTradingService: PaperTradingService,
    private readonly liveTradingService: LiveTradingService,
  ) {}

  /**
   * Returns the currently locked instruments for a broker+strategy pair, or null if not locked.
   * Used by KiteController so Trade Finder shows the same option as the auto-trader.
   */
  getLockedStrikes(
    brokerId: string,
    strategy: string,
  ): {
    instruments: any[];
    lockedAgoMinutes: number;
    nextRefreshInMinutes: number;
  } | null {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const cacheKey = `${brokerId}_${strategy}`;
    const cached = this.strikeCache.get(cacheKey);
    if (!cached || cached.date !== today || cached.instruments.length === 0)
      return null;
    const ageMs = Date.now() - cached.lockedAt;
    if (ageMs >= 2 * 60 * 60 * 1000) return null; // expired
    const lockedAgoMinutes = Math.floor(ageMs / 60_000);
    return {
      instruments: cached.instruments,
      lockedAgoMinutes,
      nextRefreshInMinutes: 120 - lockedAgoMinutes,
    };
  }

  /**
   * Runs every 5 minutes during market hours (9:15 AM - 2:30 PM)
   * Cron format: minute hour day month weekday
   * Runs every 5 minutes from 9:00 AM to 3:55 PM IST on weekdays.
   * Time guard inside the method enforces the actual 9:15–15:30 window.
   */
  @Cron('*/1 9-15 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async runOptionMonitorDuringMarketHours() {
    // Check if it's within market hours
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Market hours: 9:15 AM to 2:30 PM (no new trades after 2:30 PM)
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
    // Prevent concurrent runs
    if (this.isRunning) {
      this.logger.warn('Previous run still in progress. Skipping this cycle.');
      return;
    }

    this.isRunning = true;

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

      // Run for each broker
      for (const broker of brokers) {
        try {
          this.logger.log(
            `Running for broker: ${broker.name} (User: ${broker.userId})`,
          );

          // Get the next weekly expiry
          const expiryData = await this.kiteService.getExpiryDates(
            'NSE',
            'NIFTY',
          );

          if (
            !expiryData ||
            !expiryData.expiries ||
            expiryData.expiries.length === 0
          ) {
            this.logger.warn('No expiry dates found');
            continue;
          }

          const nextExpiry = expiryData.expiries[0]; // First expiry is the nearest

          // Run all strategies and save signals to database
          // Use current date and time for live trading
          const now = new Date();
          const today = now.toISOString().split('T')[0];
          const currentTime = now.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });

          this.logger.log(
            `Running strategies for ${today} at ${currentTime}...`,
          );

          // Active strategies for auto-trading (others disabled for now)
          const strategies = ['DAY_SELLING'] as const;

          // Run each strategy
          for (const strategy of strategies) {
            try {
              this.logger.log(`Running ${strategy} strategy...`);

              // ── 2-hour strike-price lock ─────────────────────────────────────
              // At 9:15 AM → select strikes fresh from NIFTY opening spot price.
              // Every 2 hrs thereafter (11:15, 13:15) → re-select from live spot.
              // In between → reuse locked CE + PE to avoid chasing every tick.
              const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
              const cacheKey = `${broker.id}_${strategy}`;
              const cached = this.strikeCache.get(cacheKey);
              const isStale =
                !cached ||
                cached.date !== today ||
                Date.now() - cached.lockedAt >= TWO_HOURS_MS;

              const lockedInstruments = isStale
                ? undefined
                : cached.instruments;

              if (isStale) {
                this.logger.log(
                  `[${strategy}] ⚡ Strike window expired or first run — re-selecting strikes from current NIFTY spot`,
                );
              } else {
                const ageMin = Math.floor(
                  (Date.now() - cached.lockedAt) / 60_000,
                );
                const nextRefreshMin = 120 - ageMin;
                this.logger.log(
                  `[${strategy}] 🔒 Using cached strikes (locked ${ageMin}min ago, refresh in ~${nextRefreshMin}min): ${cached.instruments.map((i) => i.tradingsymbol).join(', ')}`,
                );
              }
              // ────────────────────────────────────────────────────────────────

              const result = await this.tradingService.optionMonitor(
                broker.id,
                'NIFTY',
                nextExpiry,
                20, // margin points
                today, // target date
                'minute',
                currentTime, // Use current time for live data
                strategy,
                true, // realtimeMode: only check the latest candle for patterns
                'live',
                lockedInstruments, // undefined → re-select; array → reuse
              );

              // ── Update cache when fresh selection was made ───────────────────
              if (
                isStale &&
                result.selectedInstruments &&
                result.selectedInstruments.length > 0
              ) {
                this.strikeCache.set(cacheKey, {
                  date: today,
                  lockedAt: Date.now(),
                  instruments: result.selectedInstruments,
                });
                const unlockTime = new Date(
                  Date.now() + TWO_HOURS_MS,
                ).toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });
                this.logger.log(
                  `[${strategy}] 🔒 Strikes locked: ${result.selectedInstruments.map((i) => i.tradingsymbol).join(', ')} — next refresh at ~${unlockTime}`,
                );
              }
              // ────────────────────────────────────────────────────────────────

              // Save all signals to database
              if (result.options && result.options.length > 0) {
                for (const option of result.options) {
                  if (option.signals && option.signals.length > 0) {
                    for (const signal of option.signals) {
                      try {
                        // ── Max 2 trades per strategy per day ─────────────────
                        // Trade 1: first signal on any option.
                        // Trade 2: second signal (Live Trading will close Trade 1
                        //          automatically before placing Trade 2).
                        // After 2 signals, no more trading for the day.
                        const todayStart = new Date(today + 'T00:00:00.000Z');
                        const todayEnd = new Date(today + 'T23:59:59.999Z');

                        const todaySignalCount = await this.prisma.signal.count(
                          {
                            where: {
                              userId: broker.userId,
                              strategy: strategy,
                              signalDate: { gte: todayStart, lte: todayEnd },
                            },
                          },
                        );

                        if (todaySignalCount >= 2) {
                          this.logger.debug(
                            `⏭️ Daily 2-trade limit reached for [${strategy}] — skipping ${option.tradingsymbol}`,
                          );
                          continue;
                        }

                        // Avoid exact duplicate: same option already signalled today
                        const duplicateSignal =
                          await this.prisma.signal.findFirst({
                            where: {
                              userId: broker.userId,
                              optionSymbol: option.tradingsymbol,
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
                        const savedTarget = Math.max(
                          Math.round(signal.target1),
                          1,
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
                            target1: savedTarget,
                            target2: savedTarget,
                            target3: savedTarget,
                            ltp: option.ltp,
                            marginPoints: 20,
                            interval: 'minute',
                            targetDate: today,
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

                        // ── Live order placement ──────────────────────────
                        // Only fires if savedSignal is NEW (not a duplicate)
                        // saveSignal returns existing if duplicate; detect by createdAt
                        // Use 3-min window to accommodate slow API calls (instrument download etc.)
                        const isNewSignal =
                          savedSignal.createdAt &&
                          Date.now() -
                            new Date(savedSignal.createdAt).getTime() <
                            180_000;

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
                      } catch (error) {
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
            } catch (strategyError) {
              this.logger.error(
                `Failed to run ${strategy}: ${strategyError.message}`,
              );
            }
          }

          this.logger.log(`✅ Completed for broker: ${broker.name}`);
        } catch (error) {
          this.logger.error(
            `Failed to run for broker ${broker.name}: ${error.message}`,
          );
        }
      }
    } catch (error) {
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
  }

  /**
   * Monitor live trades every minute during market hours (9:15 AM - 3:15 PM)
   * Checks order fills and advances the live trade lifecycle
   */
  @Cron('* 9-15 * * 1-5', {
    timeZone: 'Asia/Kolkata',
  })
  async monitorLiveTradesEveryMinute() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

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
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    const isBeforeMarket = hour < 9 || (hour === 9 && minute < 15);
    const isAfterMarket = hour > 15 || (hour === 15 && minute > 15);

    if (isBeforeMarket || isAfterMarket) return;

    try {
      await this.paperTradingService.monitorAllActiveTrades();
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
}

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KiteService } from './kite.service';
import { WhatsAppService } from './whatsapp.service';
import { KiteTickerService } from './kite-ticker.service';
import { TradeAdvisorService } from './trade-advisor.service';
import { LiveTradeStatus } from '@prisma/client';

/**
 * LiveTradingService
 *
 * Lifecycle:
 *  1. executeLiveOrder(signal, brokerId, userId)
 *       → find hedge option (far OTM, same type, ~₹5)
 *       → place hedge BUY  (LIMIT price = ltp)
 *       → set status = PENDING_HEDGE
 *
 *  2. monitorLiveTrades()  [called by scheduler every 1 min]
 *       PENDING_HEDGE  → wait for hedge fill
 *                       once filled → place SELL entry (LIMIT = signal price + buffer)
 *                       → PENDING_ENTRY
 *       PENDING_ENTRY  → wait for entry fill
 *                       once filled → place TARGET (LIMIT) + SL (SL-LIMIT)
 *                       → ACTIVE
 *       ACTIVE         → wait for TARGET or SL execution
 *                       once one fires → cancel the other → close hedge → DONE
 *
 *  3. squareOffAllLiveTrades()  [called by scheduler at 3:10 PM]
 *       close all ACTIVE/PENDING_ENTRY live trades
 */

@Injectable()
export class LiveTradingService {
  private readonly logger = new Logger(LiveTradingService.name);

  // Lot sizes per symbol
  private readonly LOT_SIZES: Record<string, number> = {
    NIFTY: 75,
    BANKNIFTY: 30,
    FINNIFTY: 65,
    MIDCPNIFTY: 120,
    SENSEX: 20,
    BANKEX: 15,
  };

  // Hedge option price range (₹ per unit) - buy cheap far OTM to satisfy SEBI margin rules
  // Target: ₹4–₹6. Falls back to cheapest available if none found in range.
  private readonly HEDGE_MIN_PRICE = 4;
  private readonly HEDGE_MAX_PRICE = 6;

  // In-memory set to avoid sending duplicate 1:1 alerts for the same trade
  // (kept as fallback for when ticker is not connected)
  private readonly oneToOneAlerted = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kiteService: KiteService,
    private readonly whatsAppService: WhatsAppService,
    private readonly kiteTickerService: KiteTickerService,
    private readonly tradeAdvisor: TradeAdvisorService,
  ) {}

  // ─── Advisor wiring helpers ─────────────────────────────────────────────────

  private async advisorStart(trade: any): Promise<void> {
    try {
      const tradeDate = new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kolkata',
      });
      // Look up StrikeSelection for today to get both CE/PE symbols for OI polling
      const ss = await this.prisma.strikeSelection.findFirst({
        where: {
          brokerId: trade.brokerId,
          symbol: trade.symbol,
          date: tradeDate,
        },
      });
      const ceTradingsymbol =
        ss?.ceTradingSymbol ??
        (trade.optionType === 'CE' ? trade.optionSymbol : '');
      const peTradingsymbol =
        ss?.peTradingSymbol ??
        (trade.optionType === 'PE' ? trade.optionSymbol : '');

      await this.tradeAdvisor.startAdvisingTrade({
        liveTradeId: trade.id,
        optionSymbol: trade.optionSymbol,
        instrumentToken: trade.instrumentToken,
        strike: trade.strike,
        expiryDate: trade.expiryDate,
        symbol: trade.symbol,
        direction: this.isBuyTrade(trade) ? 'BUY' : 'SELL',
        strategy: trade.strategy,
        entryPrice: trade.entryFilledPrice ?? trade.entryPrice ?? 0,
        slPrice: trade.slPrice ?? 0,
        targetPrice: trade.targetPrice ?? 0,
        brokerId: trade.brokerId,
        ceTradingsymbol,
        peTradingsymbol,
        signalId: trade.signalId ?? undefined,
      });

      // Reconnect WebSocket ticker for this trade so ticks flow into the
      // rolling window (handles server restarts where the in-memory ticker was lost).
      if (trade.entryFilledPrice && trade.slPrice && trade.instrumentToken) {
        this.kiteTickerService
          .watchTrade({
            id: trade.id,
            brokerId: trade.brokerId,
            optionSymbol: trade.optionSymbol,
            instrumentToken: trade.instrumentToken,
            entryFilledPrice: trade.entryFilledPrice,
            slPrice: trade.slPrice,
            targetPrice: trade.targetPrice ?? trade.entryFilledPrice,
            strategy: trade.strategy,
            entryQty: trade.entryQty,
            direction: this.isBuyTrade(trade) ? 'BUY' : 'SELL',
          })
          .catch((err: any) =>
            this.logger.error(
              `Ticker reconnect failed for ${trade.id}: ${err.message}`,
            ),
          );
      }
    } catch (err: any) {
      this.logger.error(
        `Advisor start failed for trade ${trade.id}: ${err.message}`,
      );
    }
  }

  private async advisorStop(
    tradeId: string,
    exitPrice: number | null,
    outcome: 'TARGET_HIT' | 'SL_HIT' | 'MANUAL_EXIT' | 'EARLY_EXIT',
  ): Promise<void> {
    try {
      await this.tradeAdvisor.stopAdvisingTrade(
        tradeId,
        exitPrice ?? 0,
        outcome,
      );
    } catch (err: any) {
      this.logger.error(
        `Advisor stop failed for trade ${tradeId}: ${err.message}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC: called from scheduler when a new signal fires
  // ─────────────────────────────────────────────────────────────────────────────

  async executeLiveOrder(params: {
    signal: {
      id: string;
      symbol: string;
      optionSymbol: string;
      instrumentToken: number;
      strike: number;
      optionType: string; // CE | PE
      expiryDate: string;
      signalType: 'BUY' | 'SELL'; // direction from strategy (usually SELL)
      strategy: string;
      entryPrice: number;
      stopLoss: number;
      target1: number;
      ltp: number;
      exchange: string;
      lotSize: number;
    };
    brokerId: string;
    userId: string;
  }): Promise<void> {
    const { signal, brokerId, userId } = params;

    try {
      this.logger.log(
        `🚀 executeLiveOrder called: ${signal.optionSymbol} [${signal.signalType}] strategy=${signal.strategy} signalId=${signal.id}`,
      );

      const isBuySignal = signal.signalType === 'BUY';

      // ── Fetch settings ──────────────────────────────────────────────────────
      const settings = await this.prisma.tradingSettings.findUnique({
        where: { userId_symbol: { userId, symbol: signal.symbol } },
      });

      if (!settings) {
        this.logger.warn(
          `⛔ No TradingSettings found for symbol=${signal.symbol} userId=${userId}`,
        );
        return;
      }

      if (!settings.liveEnabled) {
        this.logger.warn(
          `⛔ Live trading is DISABLED for ${signal.symbol} (user ${userId}) — toggle it ON in Settings`,
        );
        return;
      }

      this.logger.log(
        `✅ Settings OK: liveEnabled=true sellLots=${settings.sellLots} hedgeLots=${settings.hedgeLots} buffer=${settings.bufferPoints}`,
      );

      // ── Check for duplicate live trade for same signal ───────────────────────
      const existing = await this.prisma.liveTrade.findFirst({
        where: { signalId: signal.id },
      });

      if (existing) {
        this.logger.warn(
          `⛔ Live trade already exists (id=${existing.id}) for signal ${signal.id} — skipping duplicate`,
        );
        return;
      }

      // ── One active trade per contract per day ────────────────────────────────
      // For BUY (complementary): check by exact optionSymbol so a SELL on the
      // paired PE does not block a BUY on CE (they are separate positions).
      // For SELL (primary): check by underlying symbol to support "Trade 2
      // replaces Trade 1" across any option contract for the same strategy.
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      if (isBuySignal) {
        // BUY: only block if there's already an active BUY trade for this exact contract.
        const activeBuyTrade = await this.prisma.liveTrade.findFirst({
          where: {
            userId,
            optionSymbol: signal.optionSymbol,
            strategy: signal.strategy,
            status: {
              in: [
                LiveTradeStatus.PENDING_ENTRY,
                LiveTradeStatus.PENDING_EXIT_ORDERS,
                LiveTradeStatus.ACTIVE,
              ],
            },
            createdAt: { gte: todayStart },
          },
        });
        if (activeBuyTrade) {
          this.logger.log(
            `⏭️ BUY signal skipped: active BUY trade exists (id=${activeBuyTrade.id}) for ${signal.optionSymbol}`,
          );
          return;
        }
      } else {
        const activeTodayTrade = await this.prisma.liveTrade.findFirst({
          where: {
            userId,
            symbol: signal.symbol,
            strategy: signal.strategy,
            status: {
              in: [
                LiveTradeStatus.PENDING_HEDGE,
                LiveTradeStatus.PENDING_ENTRY,
                LiveTradeStatus.PENDING_EXIT_ORDERS,
                LiveTradeStatus.ACTIVE,
              ],
            },
            createdAt: { gte: todayStart },
          },
        });
        if (activeTodayTrade) {
          // ── SELL Trade 2 replaces Trade 1: close the active trade first ──────
          // This allows a maximum of 2 SELL trades per day.
          this.logger.log(
            `🔄 Trade 1 still active (id=${activeTodayTrade.id}, status=${activeTodayTrade.status}) — closing it before opening Trade 2 for ${signal.optionSymbol}`,
          );
          await this.squareOffTrade(
            activeTodayTrade,
            'Replaced by Trade 2 signal',
          );
          this.logger.log(
            `✅ Trade 1 closed. Proceeding to place Trade 2: ${signal.optionSymbol}`,
          );
        }
      }

      const lotSize = signal.lotSize || this.LOT_SIZES[signal.symbol] || 75;
      const hedgeQty = (settings.hedgeLots || 1) * lotSize;
      const entryQty = (settings.sellLots || 1) * lotSize;

      if (isBuySignal) {
        // ── BUY option: no hedge needed (buying = limited loss = premium paid) ──
        const liveTrade = await this.prisma.liveTrade.create({
          data: {
            userId,
            brokerId,
            symbol: signal.symbol,
            optionSymbol: signal.optionSymbol,
            instrumentToken: signal.instrumentToken,
            strike: signal.strike,
            optionType: signal.optionType,
            expiryDate: signal.expiryDate,
            exchange: signal.exchange || 'NFO',
            lotSize,
            strategy: signal.strategy,
            signalId: signal.id,

            hedgeSymbol: null,
            hedgeQty: 0,

            entryPrice: signal.entryPrice,
            entryLimitPrice: signal.entryPrice + (settings.bufferPoints || 5),
            entryQty,

            targetPrice: signal.target1,
            slPrice: signal.stopLoss,

            status: 'PENDING_ENTRY',
          },
        });

        this.logger.log(
          `📋 Created BUY LiveTrade ${liveTrade.id} for signal ${signal.id} | ${signal.optionSymbol}`,
        );

        // No hedge — place entry order directly
        await this.placeEntryOrder(liveTrade);
        return;
      }

      // ── SELL option: find hedge first ────────────────────────────────────────
      this.logger.log(
        `🔎 Looking for hedge option: ${signal.symbol} ${signal.optionType} expiry=${signal.expiryDate} strike=${signal.strike}`,
      );

      const hedgeOption = await this.findCheapHedgeOption({
        symbol: signal.symbol,
        optionType: signal.optionType,
        expiryDate: signal.expiryDate,
        signalStrike: signal.strike,
        brokerId,
      });

      if (!hedgeOption) {
        this.logger.warn(
          `⛔ No cheap hedge option found for ${signal.symbol} ${signal.optionType} expiry=${signal.expiryDate} — skipping live order`,
        );
        return;
      }

      // ── Create live trade record ─────────────────────────────────────────────
      const liveTrade = await this.prisma.liveTrade.create({
        data: {
          userId,
          brokerId,
          symbol: signal.symbol,
          optionSymbol: signal.optionSymbol,
          instrumentToken: signal.instrumentToken,
          strike: signal.strike,
          optionType: signal.optionType,
          expiryDate: signal.expiryDate,
          exchange: signal.exchange || 'NFO',
          lotSize,
          strategy: signal.strategy,
          signalId: signal.id,

          hedgeSymbol: hedgeOption.tradingsymbol,
          hedgeQty,

          entryPrice: signal.entryPrice,
          entryLimitPrice: signal.entryPrice + (settings.bufferPoints || 5),
          entryQty,

          targetPrice: signal.target1,
          slPrice: signal.stopLoss,

          status: 'PENDING_HEDGE',
        },
      });

      this.logger.log(
        `📋 Created SELL LiveTrade ${liveTrade.id} for signal ${signal.id} | ${signal.optionSymbol}`,
      );

      // ── Place hedge BUY order ────────────────────────────────────────────────
      await this.placeHedgeOrder(liveTrade.id, brokerId, hedgeOption, hedgeQty);
    } catch (err: any) {
      this.logger.error(
        `executeLiveOrder failed for signal ${params.signal.id}: ${err.message}`,
        err.stack,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC: polling monitor called by scheduler every ~1 minute
  // ─────────────────────────────────────────────────────────────────────────────

  async monitorLiveTrades(): Promise<void> {
    const activeTrades = await this.prisma.liveTrade.findMany({
      where: {
        status: {
          in: [
            'PENDING_HEDGE',
            'PENDING_ENTRY',
            'PENDING_EXIT_ORDERS',
            'ACTIVE',
          ],
        },
      },
    });

    if (activeTrades.length === 0) return;

    this.logger.log(`🔍 Monitoring ${activeTrades.length} live trade(s)...`);

    // Auto-register any ACTIVE trade that isn't yet under advisor monitoring
    // (handles trades that were already active before the advisor was wired in,
    //  or trades that survive a server restart)
    for (const trade of activeTrades) {
      if (
        trade.status === 'ACTIVE' &&
        !this.tradeAdvisor.getAdvisedTradeIds().includes(trade.id)
      ) {
        this.advisorStart(trade).catch(() => {});
      }
    }

    for (const trade of activeTrades) {
      try {
        await this.processTrade(trade);
      } catch (err: any) {
        this.logger.error(
          `Error processing live trade ${trade.id}: ${err.message}`,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC: Square off all live trades (EOD cleanup at 3:10 PM)
  // ─────────────────────────────────────────────────────────────────────────────

  async squareOffAllLiveTrades(): Promise<void> {
    const trades = await this.prisma.liveTrade.findMany({
      where: {
        status: {
          in: [
            'PENDING_HEDGE',
            'PENDING_ENTRY',
            'PENDING_EXIT_ORDERS',
            'ACTIVE',
          ],
        },
      },
    });

    if (trades.length === 0) return;

    this.logger.log(
      `🔔 EOD Square-off: ${trades.length} live trade(s) to close`,
    );

    for (const trade of trades) {
      await this.squareOffTrade(trade, 'EOD_SQUARE_OFF');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  private async processTrade(trade: any): Promise<void> {
    switch (trade.status as LiveTradeStatus) {
      case 'PENDING_HEDGE':
        await this.checkHedgeFill(trade);
        break;
      case 'PENDING_ENTRY':
        await this.checkEntryFill(trade);
        break;
      case 'PENDING_EXIT_ORDERS':
        await this.checkExitOrdersPlaced(trade);
        break;
      case 'ACTIVE':
        await this.checkExitFills(trade);
        break;
    }
  }

  // ─── Hedge order placement ────────────────────────────────────────────────

  private async placeHedgeOrder(
    tradeId: string,
    brokerId: string,
    hedgeOption: { tradingsymbol: string; ltp: number; exchange: string },
    qty: number,
  ): Promise<void> {
    try {
      // For hedge BUY: use LTP or slightly above to ensure fill
      const hedgeLimitPrice = Math.ceil(hedgeOption.ltp + 0.5);

      const result = await this.kiteService.placeOrder({
        brokerId,
        tradingsymbol: hedgeOption.tradingsymbol,
        exchange: hedgeOption.exchange || 'NFO',
        transactionType: 'BUY',
        quantity: qty,
        product: 'MIS',
        orderType: 'LIMIT',
        price: hedgeLimitPrice,
      });

      await this.prisma.liveTrade.update({
        where: { id: tradeId },
        data: { hedgeOrderId: result.orderId },
      });

      this.logger.log(
        `🛡️  Hedge BUY placed: ${hedgeOption.tradingsymbol} x${qty} @ ₹${hedgeLimitPrice} | orderId=${result.orderId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to place hedge order for trade ${tradeId}: ${err.message}`,
      );
      await this.prisma.liveTrade.update({
        where: { id: tradeId },
        data: {
          status: 'FAILED',
          errorMessage: `Hedge placement failed: ${err.message}`,
        },
      });
    }
  }

  // ─── Check hedge fill ─────────────────────────────────────────────────────

  private async checkHedgeFill(trade: any): Promise<void> {
    if (!trade.hedgeOrderId) return;

    const orderHistory = await this.kiteService.getOrderHistory({
      brokerId: trade.brokerId,
      orderId: trade.hedgeOrderId,
    });

    const latestStatus = this.getLatestOrderStatus(orderHistory);

    if (latestStatus === 'COMPLETE') {
      const filledPrice = this.getFilledPrice(orderHistory);
      this.logger.log(
        `✅ Hedge filled for trade ${trade.id}: ${trade.hedgeSymbol} @ ₹${filledPrice}`,
      );

      // Update trade and place entry order
      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          hedgeFilled: true,
          hedgePrice: filledPrice,
          status: 'PENDING_ENTRY',
        },
      });

      // Place the main SELL entry order
      await this.placeEntryOrder(trade);
    } else if (latestStatus === 'REJECTED' || latestStatus === 'CANCELLED') {
      this.logger.warn(
        `⚠️  Hedge order ${trade.hedgeOrderId} was ${latestStatus} for trade ${trade.id}`,
      );
      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          status: 'FAILED',
          errorMessage: `Hedge order ${latestStatus.toLowerCase()}`,
        },
      });
    }
    // else: still OPEN/TRIGGER PENDING — wait next tick
  }

  // ─── Direction helper: BUY trade when SL is below entry ─────────────────

  private isBuyTrade(trade: any): boolean {
    return (trade.slPrice as number) < (trade.entryPrice as number);
  }

  // ─── Entry order placement (BUY or SELL) ──────────────────────────────────

  private async placeEntryOrder(trade: any): Promise<void> {
    try {
      const isBuy = this.isBuyTrade(trade);
      // Limit price: slightly above signal price for easy fill (works for both BUY and SELL).
      // BUY LIMIT at entryLimitPrice means "fill at this price or lower".
      // SELL LIMIT at entryLimitPrice means "fill at this price or higher".
      const limitPrice = trade.entryLimitPrice as number;

      const result = await this.kiteService.placeOrder({
        brokerId: trade.brokerId,
        tradingsymbol: trade.optionSymbol,
        exchange: trade.exchange,
        transactionType: isBuy ? 'BUY' : 'SELL',
        quantity: trade.entryQty,
        product: 'MIS',
        orderType: 'LIMIT',
        price: limitPrice,
      });

      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: { entryOrderId: result.orderId, status: 'PENDING_ENTRY' },
      });

      this.logger.log(
        `${isBuy ? '📈 Entry BUY' : '📉 Entry SELL'} placed: ${trade.optionSymbol} x${trade.entryQty} @ ₹${limitPrice} | orderId=${result.orderId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to place entry order for trade ${trade.id}: ${err.message}`,
      );
      // Hedge is already placed — square it off and fail
      await this.closeHedge(trade, 'Entry placement failed');
      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          status: 'FAILED',
          errorMessage: `Entry placement failed: ${err.message}`,
        },
      });
    }
  }

  // ─── Check entry fill ────────────────────────────────────────────────────

  private async checkEntryFill(trade: any): Promise<void> {
    if (!trade.entryOrderId) return;

    const orderHistory = await this.kiteService.getOrderHistory({
      brokerId: trade.brokerId,
      orderId: trade.entryOrderId,
    });

    const latestStatus = this.getLatestOrderStatus(orderHistory);

    if (latestStatus === 'COMPLETE') {
      const filledPrice = this.getFilledPrice(orderHistory);
      const filledTime = this.getFilledTime(orderHistory);

      this.logger.log(
        `✅ Entry filled for trade ${trade.id}: SELL ${trade.optionSymbol} @ ₹${filledPrice}`,
      );

      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          entryFilled: true,
          entryFilledPrice: filledPrice,
          entryFilledTime: filledTime,
          status: 'PENDING_EXIT_ORDERS',
        },
      });

      // Place Target + SL orders
      await this.placeExitOrders({ ...trade, entryFilledPrice: filledPrice });
    } else if (latestStatus === 'REJECTED' || latestStatus === 'CANCELLED') {
      this.logger.warn(
        `⚠️  Entry order ${trade.entryOrderId} was ${latestStatus} for trade ${trade.id}`,
      );
      await this.closeHedge(trade, `Entry order ${latestStatus.toLowerCase()}`);
      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          status: 'FAILED',
          errorMessage: `Entry order ${latestStatus.toLowerCase()}`,
        },
      });
    }
  }

  // ─── Place Target + SL exit orders ───────────────────────────────────────

  private async placeExitOrders(trade: any): Promise<void> {
    try {
      const targetPrice = trade.targetPrice as number;
      const slPrice = trade.slPrice as number;
      const isBuy = this.isBuyTrade(trade);

      // Target:
      //   SELL trade → BUY LIMIT at lower price (buy back cheaper = profit)
      //   BUY  trade → SELL LIMIT at higher price (sell for profit)
      const targetResult = await this.kiteService.placeOrder({
        brokerId: trade.brokerId,
        tradingsymbol: trade.optionSymbol,
        exchange: trade.exchange,
        transactionType: isBuy ? 'SELL' : 'BUY',
        quantity: trade.entryQty,
        product: 'MIS',
        orderType: 'LIMIT',
        price: targetPrice,
      });

      // SL: SL-LIMIT order
      //   SELL trade → BUY SL-LIMIT: trigger when price RISES to SL; limit = SL + 5
      //   BUY  trade → SELL SL-LIMIT: trigger when price FALLS to SL; limit = SL - 5
      const slTriggerPrice = slPrice;
      const slLimitPrice = isBuy ? slPrice - 5 : slPrice + 5;
      const slResult = await this.kiteService.placeOrder({
        brokerId: trade.brokerId,
        tradingsymbol: trade.optionSymbol,
        exchange: trade.exchange,
        transactionType: isBuy ? 'SELL' : 'BUY',
        quantity: trade.entryQty,
        product: 'MIS',
        orderType: 'SL',
        price: slLimitPrice,
        triggerPrice: slTriggerPrice,
      });

      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          targetOrderId: targetResult.orderId,
          slOrderId: slResult.orderId,
          status: 'ACTIVE',
        },
      });

      this.logger.log(
        `🎯 Target+SL placed for trade ${trade.id}: TARGET=${targetResult.orderId} @ ₹${targetPrice} | SL=${slResult.orderId} trigger=₹${slTriggerPrice} limit=₹${slLimitPrice}`,
      );

      // Start AI Advisor for this trade
      const activeTradeSnap = { ...trade, targetPrice, status: 'ACTIVE' };
      this.advisorStart(activeTradeSnap).catch(() => {});

      // Start real-time WebSocket price watch for 1:1 / SL level alerts
      const entryFilledPrice = trade.entryFilledPrice ?? trade.entryPrice;
      if (entryFilledPrice && trade.slPrice && trade.instrumentToken) {
        this.kiteTickerService
          .watchTrade({
            id: trade.id,
            brokerId: trade.brokerId,
            optionSymbol: trade.optionSymbol,
            instrumentToken: trade.instrumentToken,
            entryFilledPrice,
            slPrice: trade.slPrice,
            targetPrice,
            strategy: trade.strategy,
            entryQty: trade.entryQty,
            direction: isBuy ? 'BUY' : 'SELL',
          })
          .catch((err: any) =>
            this.logger.error(`KiteTicker watchTrade failed: ${err.message}`),
          );
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to place exit orders for trade ${trade.id}: ${err.message}`,
      );
      // We have an open SELL position — square it off at market
      await this.squareOffTrade(trade, 'Exit order placement failed');
    }
  }

  // ─── Check PENDING_EXIT_ORDERS: confirm both target/sl are placed ────────

  private async checkExitOrdersPlaced(trade: any): Promise<void> {
    // If status is still PENDING_EXIT_ORDERS but orders exist, re-confirm
    if (trade.targetOrderId && trade.slOrderId) {
      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: { status: 'ACTIVE' },
      });
      // Start AI Advisor (recovery: was already PENDING_EXIT_ORDERS → now confirmed ACTIVE)
      this.advisorStart(trade).catch(() => {});
    } else {
      // Orders may have failed — retry placement
      await this.placeExitOrders(trade);
    }
  }

  // ─── Check Target/SL fills (OCO logic) ───────────────────────────────────

  private async checkExitFills(trade: any): Promise<void> {
    const [targetHistory, slHistory] = await Promise.all([
      trade.targetOrderId
        ? this.kiteService.getOrderHistory({
            brokerId: trade.brokerId,
            orderId: trade.targetOrderId,
          })
        : Promise.resolve([]),
      trade.slOrderId
        ? this.kiteService.getOrderHistory({
            brokerId: trade.brokerId,
            orderId: trade.slOrderId,
          })
        : Promise.resolve([]),
    ]);

    // ── 1:1 alert is handled by KiteTickerService in real-time.
    // Fallback: if ticker missed it (not connected), check here via LTP poll.
    if (
      trade.slPrice &&
      trade.entryFilledPrice &&
      !this.oneToOneAlerted.has(trade.id)
    ) {
      const isBuyCheck = this.isBuyTrade(trade);
      const risk = Math.abs(trade.slPrice - trade.entryFilledPrice);
      const oneToOneLevel = isBuyCheck
        ? trade.entryFilledPrice + risk
        : trade.entryFilledPrice - risk;
      try {
        const quotes = await this.kiteService.getQuotes(trade.brokerId, [
          { exchange: trade.exchange, tradingsymbol: trade.optionSymbol },
        ]);
        const ltp = quotes[0]?.last_price;
        if (
          ltp !== undefined &&
          (isBuyCheck ? ltp >= oneToOneLevel : ltp <= oneToOneLevel)
        ) {
          this.oneToOneAlerted.add(trade.id);
          this.whatsAppService
            .send1to1Alert({
              optionSymbol: trade.optionSymbol,
              entryPrice: trade.entryFilledPrice,
              targetPrice: oneToOneLevel,
              strategy: trade.strategy,
            })
            .catch((err: any) =>
              this.logger.error(
                `WhatsApp 1:1 fallback alert failed: ${err.message}`,
              ),
            );
        }
      } catch {
        // Non-critical
      }
    }

    const targetStatus = this.getLatestOrderStatus(targetHistory);
    const slStatus = this.getLatestOrderStatus(slHistory);

    const isBuyFill = this.isBuyTrade(trade);

    if (targetStatus === 'COMPLETE') {
      // Target hit! Cancel SL → close hedge (SELL only) → done
      const filledPrice = this.getFilledPrice(targetHistory);
      const filledTime = this.getFilledTime(targetHistory);

      this.logger.log(
        `🎯 TARGET HIT for trade ${trade.id}: ${trade.optionSymbol} @ ₹${filledPrice}`,
      );

      if (trade.slOrderId) {
        await this.tryCancelOrder(
          trade.brokerId,
          trade.slOrderId,
          'SL after target hit',
        );
      }
      if (!isBuyFill) await this.closeHedge(trade, 'Target hit');

      const pnl =
        trade.entryFilledPrice && filledPrice
          ? isBuyFill
            ? (filledPrice - trade.entryFilledPrice) * trade.entryQty
            : (trade.entryFilledPrice - filledPrice) * trade.entryQty
          : null;

      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          status: 'TARGET_HIT',
          targetFilled: true,
          targetFilledPrice: filledPrice,
          targetFilledTime: filledTime,
          exitPrice: filledPrice,
          exitTime: filledTime,
          pnl,
        },
      });

      // If 1:1 alert was never sent (target hit fast before LTP poll caught it),
      // send it now — target hit means 1:1 was definitely reached.
      if (
        !this.oneToOneAlerted.has(trade.id) &&
        trade.entryFilledPrice &&
        trade.slPrice
      ) {
        const risk = Math.abs(trade.slPrice - trade.entryFilledPrice);
        const oneToOneLevel = isBuyFill
          ? trade.entryFilledPrice + risk
          : trade.entryFilledPrice - risk;
        this.whatsAppService
          .send1to1Alert({
            optionSymbol: trade.optionSymbol,
            entryPrice: trade.entryFilledPrice,
            targetPrice: oneToOneLevel,
            strategy: trade.strategy,
          })
          .catch((err: any) =>
            this.logger.error(
              `WhatsApp 1:1 alert (on target hit) failed: ${err.message}`,
            ),
          );
      }
      this.oneToOneAlerted.delete(trade.id);
      this.kiteTickerService.unwatchTrade(trade.id);
      this.advisorStop(trade.id, filledPrice, 'TARGET_HIT').catch(() => {});

      this.whatsAppService
        .sendTradeClosedAlert({
          optionSymbol: trade.optionSymbol,
          status: 'TARGET_HIT',
          exitPrice: filledPrice,
          entryPrice: trade.entryFilledPrice ?? trade.entryPrice,
          pnl,
          qty: trade.entryQty,
          strategy: trade.strategy,
          direction: isBuyFill ? 'BUY' : 'SELL',
        })
        .catch((err: any) =>
          this.logger.error(`WhatsApp TARGET_HIT alert failed: ${err.message}`),
        );
    } else if (slStatus === 'COMPLETE') {
      // SL hit! Cancel Target → close hedge (SELL only) → done
      const filledPrice = this.getFilledPrice(slHistory);
      const filledTime = this.getFilledTime(slHistory);

      this.logger.log(
        `🛑 STOP LOSS HIT for trade ${trade.id}: ${trade.optionSymbol} @ ₹${filledPrice}`,
      );

      if (trade.targetOrderId) {
        await this.tryCancelOrder(
          trade.brokerId,
          trade.targetOrderId,
          'Target after SL hit',
        );
      }
      if (!isBuyFill) await this.closeHedge(trade, 'SL hit');

      const pnl =
        trade.entryFilledPrice && filledPrice
          ? isBuyFill
            ? (filledPrice - trade.entryFilledPrice) * trade.entryQty
            : (trade.entryFilledPrice - filledPrice) * trade.entryQty
          : null;

      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          status: 'SL_HIT',
          slFilled: true,
          slFilledPrice: filledPrice,
          slFilledTime: filledTime,
          exitPrice: filledPrice,
          exitTime: filledTime,
          pnl,
        },
      });

      // Clean up 1:1 alert tracking
      this.oneToOneAlerted.delete(trade.id);
      this.kiteTickerService.unwatchTrade(trade.id);
      this.advisorStop(trade.id, filledPrice, 'SL_HIT').catch(() => {});

      this.whatsAppService
        .sendTradeClosedAlert({
          optionSymbol: trade.optionSymbol,
          status: 'SL_HIT',
          exitPrice: filledPrice,
          entryPrice: trade.entryFilledPrice ?? trade.entryPrice,
          pnl,
          qty: trade.entryQty,
          strategy: trade.strategy,
          direction: isBuyFill ? 'BUY' : 'SELL',
        })
        .catch((err: any) =>
          this.logger.error(`WhatsApp SL_HIT alert failed: ${err.message}`),
        );
    }
    // else: both still open — wait next tick
  }

  // ─── Square off a single trade ─────────────────────────────────────────────

  async squareOffTrade(trade: any, reason: string): Promise<void> {
    this.logger.log(`🔴 Square-off trade ${trade.id}: ${reason}`);

    try {
      // 1. Cancel target and SL orders first
      if (trade.targetOrderId) {
        await this.tryCancelOrder(
          trade.brokerId,
          trade.targetOrderId,
          'target on square-off',
        );
      }
      if (trade.slOrderId) {
        await this.tryCancelOrder(
          trade.brokerId,
          trade.slOrderId,
          'SL on square-off',
        );
      }

      // 2. Close main position (direction-aware: SELL at market for BUY, BUY at market for SELL)
      if (trade.entryFilled && trade.entryOrderId) {
        await this.closeMainPosition(trade);
      }

      // 3. Close hedge position (SELL at market equivalent via LIMIT at LTP)
      if (trade.hedgeFilled && trade.hedgeOrderId) {
        await this.closeHedge(trade, reason);
      }

      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          status: 'SQUARED_OFF',
          exitTime: new Date(),
          errorMessage: reason !== 'EOD_SQUARE_OFF' ? reason : undefined,
        },
      });
      this.advisorStop(trade.id, trade.exitPrice ?? null, 'MANUAL_EXIT').catch(
        () => {},
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to square off trade ${trade.id}: ${err.message}`,
      );
    }
  }

  // ─── Close main position (direction-aware) ───────────────────────────────

  private async closeMainPosition(trade: any): Promise<void> {
    const isBuy = this.isBuyTrade(trade);
    try {
      await this.kiteService.placeOrder({
        brokerId: trade.brokerId,
        tradingsymbol: trade.optionSymbol,
        exchange: trade.exchange,
        // To close: BUY trade → SELL to exit; SELL trade → BUY to exit
        transactionType: isBuy ? 'SELL' : 'BUY',
        quantity: trade.entryQty,
        product: 'MIS',
        orderType: 'MARKET',
      });

      this.logger.log(
        `🔁 Closed ${isBuy ? 'BUY' : 'SELL'} position for trade ${trade.id}: ${trade.optionSymbol} x${trade.entryQty}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to close position for trade ${trade.id}: ${err.message}`,
      );
    }
  }

  // ─── Close hedge position ─────────────────────────────────────────────────

  private async closeHedge(trade: any, reason: string): Promise<void> {
    if (!trade.hedgeSymbol || !trade.hedgeQty || trade.hedgeQty === 0) return;

    try {
      await this.kiteService.placeOrder({
        brokerId: trade.brokerId,
        tradingsymbol: trade.hedgeSymbol,
        exchange: trade.exchange,
        transactionType: 'SELL',
        quantity: trade.hedgeQty,
        product: 'MIS',
        orderType: 'MARKET',
      });

      this.logger.log(
        `🛡️  Closed hedge for trade ${trade.id}: ${trade.hedgeSymbol} x${trade.hedgeQty} (${reason})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to close hedge for trade ${trade.id}: ${err.message}`,
      );
    }
  }

  // ─── Cancel order (swallow errors) ────────────────────────────────────────

  private async tryCancelOrder(
    brokerId: string,
    orderId: string,
    label: string,
  ): Promise<void> {
    try {
      await this.kiteService.cancelOrder({ brokerId, orderId });
      this.logger.log(`❌ Cancelled ${label} order: ${orderId}`);
    } catch (err: any) {
      // Order may already be filled — ignore
      this.logger.warn(
        `Could not cancel ${label} order ${orderId}: ${err.message}`,
      );
    }
  }

  // ─── Find far OTM cheap hedge option ──────────────────────────────────────

  private async findCheapHedgeOption(params: {
    symbol: string;
    optionType: string; // CE | PE
    expiryDate: string;
    signalStrike: number;
    brokerId: string;
  }): Promise<{ tradingsymbol: string; ltp: number; exchange: string } | null> {
    const { symbol, optionType, expiryDate, signalStrike, brokerId } = params;

    try {
      const instruments = await this.kiteService.getInstruments();

      const expiry = new Date(expiryDate).toISOString().split('T')[0];

      // Filter same symbol, same expiry, same optionType
      // Strip quotes from name (CSV stores as "NIFTY") and normalise expiry (may be Date object)
      const candidates = instruments.filter((i) => {
        let instName = i.name;
        if (instName && instName.startsWith('"') && instName.endsWith('"')) {
          instName = instName.slice(1, -1);
        }
        let instExpiry = i.expiry;
        if (typeof instExpiry === 'object' && instExpiry !== null) {
          instExpiry = (instExpiry as any).toISOString().split('T')[0];
        }
        return (
          instName === symbol &&
          i.instrument_type === optionType &&
          instExpiry === expiry &&
          i.exchange === 'NFO'
        );
      });

      this.logger.log(
        `🔍 Hedge search: symbol=${symbol} type=${optionType} expiry=${expiry} — ${candidates.length} instruments found`,
      );

      if (candidates.length === 0) {
        this.logger.warn(
          `⛔ No instruments found for ${symbol} ${optionType} expiry=${expiry}. Available expiries: ${[...new Set(instruments.filter((i) => i.name === symbol && i.exchange === 'NFO').map((i) => i.expiry))].sort().join(', ')}`,
        );
        return null;
      }

      // For CE: far OTM = strikes much higher than signal strike
      // For PE: far OTM = strikes much lower than signal strike
      const otmDistance = symbol.includes('BANKNIFTY')
        ? 3000
        : symbol === 'SENSEX'
          ? 3000
          : 2000;

      let filteredStrikes: typeof candidates;
      if (optionType === 'CE') {
        filteredStrikes = candidates.filter(
          (i) => i.strike >= signalStrike + otmDistance,
        );
      } else {
        filteredStrikes = candidates.filter(
          (i) => i.strike <= signalStrike - otmDistance,
        );
      }

      if (filteredStrikes.length === 0) {
        this.logger.warn(
          `⚠️  No instruments at OTM distance=${otmDistance} from strike=${signalStrike}. Using widest available fallback.`,
        );
        // Fallback: use widest available OTM
        filteredStrikes = candidates
          .sort((a, b) =>
            optionType === 'CE' ? b.strike - a.strike : a.strike - b.strike,
          )
          .slice(0, 20);
      } else {
        this.logger.log(
          `✅ ${filteredStrikes.length} OTM candidates (strike ${optionType === 'CE' ? '>=' : '<='} ${optionType === 'CE' ? signalStrike + otmDistance : signalStrike - otmDistance})`,
        );
      }

      // Get LTPs in batches to find the cheapest ~₹5 option
      // Request quotes for a sample of candidates (max 50 at a time)
      const sampleInsts = filteredStrikes.slice(0, 50);

      if (sampleInsts.length === 0) {
        this.logger.warn(`⛔ No sample instruments to quote. Returning null.`);
        return null;
      }

      const quotesResult = await this.kiteService.getQuotes(
        brokerId,
        sampleInsts.map((i) => ({
          exchange: 'NFO',
          tradingsymbol: i.tradingsymbol,
        })),
      );

      // Build a map tradingsymbol → ltp
      const ltpMap = new Map<string, number>();
      for (const q of quotesResult) {
        ltpMap.set(q.tradingsymbol, q.last_price);
      }

      this.logger.log(
        `📊 Quotes received: ${quotesResult.length}/${sampleInsts.length} instruments. ltpMap size=${ltpMap.size}`,
      );

      // Find the instrument with LTP in the target ₹5–₹8 range
      // (midpoint ₹6.5 used to prefer options centred in the range)
      let best: {
        tradingsymbol: string;
        ltp: number;
        exchange: string;
      } | null = null;

      for (const inst of sampleInsts) {
        const ltp = ltpMap.get(inst.tradingsymbol) ?? 0;

        if (ltp >= this.HEDGE_MIN_PRICE && ltp <= this.HEDGE_MAX_PRICE) {
          if (!best || Math.abs(ltp - 5.0) < Math.abs(best.ltp - 5.0)) {
            best = { tradingsymbol: inst.tradingsymbol, ltp, exchange: 'NFO' };
          }
        }
      }

      if (!best) {
        this.logger.log(
          `⚠️  No hedge in ₹${this.HEDGE_MIN_PRICE}–₹${this.HEDGE_MAX_PRICE} range. Relaxing to cheapest available in ₹${this.HEDGE_MIN_PRICE}–₹${this.HEDGE_MAX_PRICE + 2}...`,
        );
        // Relax upper bound only — hard floor of HEDGE_MIN_PRICE (₹4) is always enforced
        for (const inst of sampleInsts) {
          const ltp = ltpMap.get(inst.tradingsymbol) ?? 0;
          if (
            ltp >= this.HEDGE_MIN_PRICE &&
            ltp <= this.HEDGE_MAX_PRICE + 2 &&
            (!best || ltp < best.ltp)
          ) {
            best = { tradingsymbol: inst.tradingsymbol, ltp, exchange: 'NFO' };
          }
        }
      }

      if (best) {
        this.logger.log(
          `🔎 Hedge option selected: ${best.tradingsymbol} @ ₹${best.ltp}`,
        );
      } else {
        const allLtps = sampleInsts
          .map((i) => `${i.tradingsymbol}=₹${ltpMap.get(i.tradingsymbol) ?? 0}`)
          .slice(0, 10);
        this.logger.warn(
          `⛔ No valid hedge found. Sample LTPs: [${allLtps.join(', ')}]`,
        );
      }

      return best;
    } catch (err: any) {
      this.logger.error(`findCheapHedgeOption failed: ${err.message}`);
      return null;
    }
  }

  // ─── Get LTP for a symbol ─────────────────────────────────────────────────

  private async getLTP(
    brokerId: string,
    exchange: string,
    tradingsymbol: string,
  ): Promise<number | null> {
    try {
      const results = await this.kiteService.getQuotes(brokerId, [
        { exchange, tradingsymbol },
      ]);
      return results?.[0]?.last_price ?? null;
    } catch {
      return null;
    }
  }

  // ─── Order status helpers ─────────────────────────────────────────────────

  private getLatestOrderStatus(history: any[]): string {
    if (!history || history.length === 0) return 'UNKNOWN';
    // The last entry is the most recent
    const latest = history[history.length - 1];
    return latest?.status || 'UNKNOWN';
  }

  private getFilledPrice(history: any[]): number {
    const latest = history[history.length - 1];
    return latest?.average_price || latest?.price || 0;
  }

  private getFilledTime(history: any[]): Date {
    const latest = history[history.length - 1];
    return latest?.exchange_timestamp
      ? new Date(latest.exchange_timestamp)
      : new Date();
  }
}

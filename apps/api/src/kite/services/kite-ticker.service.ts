import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { KiteTicker } from 'kiteconnect';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { TickStorageService } from './tick-storage.service';

/**
 * Watched trade entry stored in memory.
 * Levels are pre-calculated when a trade becomes ACTIVE.
 */
interface WatchedTrade {
  tradeId: string;
  optionSymbol: string;
  instrumentToken: number;
  entryFilledPrice: number;
  slPrice: number;
  targetPrice: number; // 1:2 level stored in DB
  oneToOneLevel: number; // entry ± risk (direction-aware)
  strategy: string;
  qty: number;
  direction: 'BUY' | 'SELL';
  oneToOneAlerted: boolean;
}

/**
 * Signal-level WebSocket watcher — monitors ALL Auto Trade signals (SELL + BUY)
 * for real-time 1:1 / Target / SL level notifications purely from LTP.
 * Runs in parallel with WatchedTrade; BUY (complementary) signals are ONLY
 * tracked here since they are never placed as live orders.
 */
interface WatchedSignal {
  signalId: string;
  optionSymbol: string;
  instrumentToken: number;
  brokerId: string;
  entryPrice: number;
  slPrice: number;
  oneToOneLevel: number; // entry ∓ risk (direction-aware)
  finalTargetLevel: number; // entry ∓ 2×risk
  direction: 'SELL' | 'BUY';
  strategy: string;
  qty: number;
  /** Skip 1:1 alert when watchTrade() already handles it (live SELL trades) */
  skipOneToOne: boolean;
  oneToOneAlerted: boolean;
  targetAlerted: boolean;
  slAlerted: boolean;
}

@Injectable()
export class KiteTickerService implements OnModuleDestroy {
  private readonly logger = new Logger(KiteTickerService.name);

  // brokerId → KiteTicker instance
  private tickers = new Map<string, InstanceType<typeof KiteTicker>>();

  // instrumentToken → list of watched trades on that token
  private watchedByToken = new Map<number, WatchedTrade[]>();

  // tradeId → WatchedTrade (for O(1) lookup on unsubscribe)
  private watchedById = new Map<string, WatchedTrade>();

  // ── Signal-level watchers (SELL + BUY, LTP-based) ─────────────────────
  // signalId → WatchedSignal
  private watchedSignalById = new Map<string, WatchedSignal>();
  // instrumentToken → list of WatchedSignals on that token
  private watchedSignalByToken = new Map<number, WatchedSignal[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
    private readonly tickStorage: TickStorageService,
  ) {}

  onModuleDestroy() {
    for (const [brokerId, ticker] of this.tickers) {
      try {
        ticker.disconnect();
        this.logger.log(`KiteTicker disconnected for broker ${brokerId}`);
      } catch {}
    }
    this.tickers.clear();
  }

  // ─── Called when a trade becomes ACTIVE ───────────────────────────────────

  async watchTrade(trade: {
    id: string;
    brokerId: string;
    optionSymbol: string;
    instrumentToken: number;
    entryFilledPrice: number;
    slPrice: number;
    targetPrice: number;
    strategy: string;
    entryQty: number;
    direction?: 'BUY' | 'SELL';
  }): Promise<void> {
    if (this.watchedById.has(trade.id)) return; // already watching

    const direction = trade.direction ?? 'SELL';
    const isBuy = direction === 'BUY';
    const risk = Math.abs(trade.slPrice - trade.entryFilledPrice);
    const oneToOneLevel = isBuy
      ? trade.entryFilledPrice + risk
      : trade.entryFilledPrice - risk;

    const watched: WatchedTrade = {
      tradeId: trade.id,
      optionSymbol: trade.optionSymbol,
      instrumentToken: trade.instrumentToken,
      entryFilledPrice: trade.entryFilledPrice,
      slPrice: trade.slPrice,
      targetPrice: trade.targetPrice,
      oneToOneLevel,
      strategy: trade.strategy,
      qty: trade.entryQty,
      direction,
      oneToOneAlerted: false,
    };

    this.watchedById.set(trade.id, watched);

    const existing = this.watchedByToken.get(trade.instrumentToken) ?? [];
    existing.push(watched);
    this.watchedByToken.set(trade.instrumentToken, existing);

    this.logger.log(
      `👁️  Watching trade ${trade.id} | ${trade.optionSymbol} | 1:1=₹${oneToOneLevel.toFixed(2)} | 1:2=₹${trade.targetPrice.toFixed(2)} | SL=₹${trade.slPrice.toFixed(2)}`,
    );

    await this.ensureTicker(trade.brokerId, trade.instrumentToken);
  }

  // ─── Signal-level WebSocket monitoring ──────────────────────────────────

  /**
   * Subscribe a saved signal to real-time LTP monitoring.
   * Direction-aware: SELL options fire on price-down levels;
   * BUY (complementary CE) options fire on price-up levels.
   *
   * @param skipOneToOne  Pass true for live-traded SELL signals whose
   *                      1:1 alert is already handled by watchTrade().
   */
  async watchSignal(params: {
    signalId: string;
    brokerId: string;
    optionSymbol: string;
    instrumentToken: number;
    entryPrice: number;
    slPrice: number;
    direction: 'SELL' | 'BUY';
    strategy: string;
    qty: number;
    skipOneToOne?: boolean;
  }): Promise<void> {
    if (this.watchedSignalById.has(params.signalId)) return; // already watching

    const risk = Math.abs(params.entryPrice - params.slPrice);
    const isSell = params.direction === 'SELL';
    const oneToOneLevel = isSell
      ? params.entryPrice - risk
      : params.entryPrice + risk;
    const finalTargetLevel = isSell
      ? params.entryPrice - 2 * risk
      : params.entryPrice + 2 * risk;

    const watched: WatchedSignal = {
      signalId: params.signalId,
      optionSymbol: params.optionSymbol,
      instrumentToken: params.instrumentToken,
      brokerId: params.brokerId,
      entryPrice: params.entryPrice,
      slPrice: params.slPrice,
      oneToOneLevel,
      finalTargetLevel,
      direction: params.direction,
      strategy: params.strategy,
      qty: params.qty,
      skipOneToOne: params.skipOneToOne ?? false,
      oneToOneAlerted: false,
      targetAlerted: false,
      slAlerted: false,
    };

    this.watchedSignalById.set(params.signalId, watched);
    const existing =
      this.watchedSignalByToken.get(params.instrumentToken) ?? [];
    existing.push(watched);
    this.watchedSignalByToken.set(params.instrumentToken, existing);

    this.logger.log(
      `📡 Signal watch: ${params.optionSymbol} [${params.direction}] | entry=₹${params.entryPrice} | SL=₹${params.slPrice.toFixed(2)} | 1:1=₹${oneToOneLevel.toFixed(2)} | Target=₹${finalTargetLevel.toFixed(2)}`,
    );

    await this.ensureTicker(params.brokerId, params.instrumentToken);
  }

  unwatchSignal(signalId: string): void {
    const watched = this.watchedSignalById.get(signalId);
    if (!watched) return;

    this.watchedSignalById.delete(signalId);
    const list = this.watchedSignalByToken.get(watched.instrumentToken) ?? [];
    const updated = list.filter((s) => s.signalId !== signalId);
    if (updated.length === 0) {
      this.watchedSignalByToken.delete(watched.instrumentToken);
      this.unsubscribeTokenIfNoWatchers(watched.instrumentToken);
    } else {
      this.watchedSignalByToken.set(watched.instrumentToken, updated);
    }
    this.logger.log(
      `📡 Stopped watching signal ${signalId} (${watched.optionSymbol})`,
    );
  }

  /** Called at market close (2:30 PM) to clear all signal watchers. */
  unwatchAllSignals(): void {
    const count = this.watchedSignalById.size;
    this.watchedSignalById.clear();
    this.watchedSignalByToken.clear();
    if (count > 0) {
      this.logger.log(`📡 Cleared ${count} signal watcher(s) at market close`);
    }
  }

  // ─── Called when a trade closes (TARGET_HIT / SL_HIT / SQUARED_OFF) ───────

  unwatchTrade(tradeId: string): void {
    const watched = this.watchedById.get(tradeId);
    if (!watched) return;

    this.watchedById.delete(tradeId);

    const list = this.watchedByToken.get(watched.instrumentToken) ?? [];
    const updated = list.filter((w) => w.tradeId !== tradeId);
    if (updated.length === 0) {
      this.watchedByToken.delete(watched.instrumentToken);
      this.unsubscribeTokenIfNoWatchers(watched.instrumentToken);
    } else {
      this.watchedByToken.set(watched.instrumentToken, updated);
    }

    this.logger.log(`👁️  Stopped watching trade ${tradeId}`);
  }

  // ─── Ticker management ────────────────────────────────────────────────────

  private async ensureTicker(
    brokerId: string,
    instrumentToken: number,
  ): Promise<void> {
    if (this.tickers.has(brokerId)) {
      // Already have a ticker for this broker — just subscribe the new token
      const ticker = this.tickers.get(brokerId)!;
      if (ticker.connected()) {
        ticker.subscribe([instrumentToken]);
        ticker.setMode(ticker.modeFull, [instrumentToken]);
      }
      return;
    }

    // Create new ticker for this broker
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });
    if (!broker?.accessToken || !broker?.apiKey) {
      this.logger.warn(
        `⚠️  Cannot start KiteTicker for broker ${brokerId} — missing accessToken or apiKey`,
      );
      return;
    }

    const ticker = new KiteTicker({
      api_key: broker.apiKey,
      access_token: broker.accessToken,
    });

    ticker.autoReconnect(true, 10, 5);

    ticker.on('connect', () => {
      this.logger.log(`✅ KiteTicker connected for broker ${brokerId}`);
      // Subscribe all tokens currently watched for this broker
      const tokens = this.getTokensForBroker(brokerId);
      if (tokens.length > 0) {
        ticker.subscribe(tokens);
        ticker.setMode(ticker.modeFull, tokens);
      }
    });

    ticker.on(
      'ticks',
      (ticks: Array<{ instrument_token: number; last_price: number; [k: string]: any }>) => {
        this.processTicks(ticks);
      },
    );

    ticker.on('disconnect', (err: any) => {
      this.logger.warn(
        `KiteTicker disconnected for broker ${brokerId}: ${err?.message ?? 'unknown'}`,
      );
    });

    ticker.on('error', (err: any) => {
      this.logger.error(
        `KiteTicker error for broker ${brokerId}: ${err?.message ?? 'unknown'}`,
      );
    });

    ticker.on('reconnect', (retries: number, delay: number) => {
      this.logger.log(
        `KiteTicker reconnecting (attempt ${retries}, delay ${delay}s) for broker ${brokerId}`,
      );
    });

    ticker.on('noreconnect', () => {
      this.logger.error(
        `KiteTicker exhausted reconnect attempts for broker ${brokerId}`,
      );
      this.tickers.delete(brokerId);
    });

    this.tickers.set(brokerId, ticker);
    ticker.connect();
  }

  private getTokensForBroker(brokerId: string): number[] {
    // Return all watched tokens from both trades and signals.
    // In practice there's only one broker at a time.
    const tradeTokens = Array.from(this.watchedByToken.keys());
    const signalTokens = Array.from(this.watchedSignalByToken.keys());
    return Array.from(new Set([...tradeTokens, ...signalTokens]));
  }

  private unsubscribeTokenIfNoWatchers(token: number): void {
    // Only unsubscribe when neither trades NOR signals are watching this token
    if (
      this.watchedByToken.has(token) ||
      this.watchedSignalByToken.has(token)
    ) {
      return;
    }
    for (const ticker of this.tickers.values()) {
      if (ticker.connected()) {
        try {
          ticker.unsubscribe([token]);
        } catch {}
      }
    }
  }

  // ─── Tick processing ───────────────────────────────────────────────────────

  /** True on Tue/Wed/Thu IST — Nifty/BankNifty/FinNifty weekly expiry days */
  private isExpiryDay(): boolean {
    const day = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    ).getDay();
    return day === 2 || day === 3 || day === 4; // Tue / Wed / Thu
  }

  private processTicks(
    ticks: Array<{ instrument_token: number; last_price: number; [k: string]: any }>,
  ): void {
    const isExpiry = this.isExpiryDay();
    for (const tick of ticks) {
      const ltp = tick.last_price;

      // ── Feed tick into AI Advisor rolling window ───────────────────────
      this.tickStorage.ingestTick(
        {
          instrument_token: tick.instrument_token,
          tradingsymbol: tick.tradingsymbol,
          last_price: tick.last_price,
          oi: tick.oi,
          oi_day_high: tick.oi_day_high,
          oi_day_low: tick.oi_day_low,
          volume: tick.volume,
          buy_quantity: tick.buy_quantity,
          sell_quantity: tick.sell_quantity,
          average_price: tick.average_price,
          timestamp: tick.timestamp ? new Date(tick.timestamp) : new Date(),
        },
        isExpiry,
      );

      // ── Live trade level checks (1:1 for executed trades) ─────────────
      const trades = this.watchedByToken.get(tick.instrument_token);
      if (trades && trades.length > 0) {
        for (const trade of trades) {
          this.checkLevels(trade, ltp);
        }
      }

      // ── Signal-level checks (1:1, Target, SL for all signals) ─────────
      const signals = this.watchedSignalByToken.get(tick.instrument_token);
      if (signals && signals.length > 0) {
        // Iterate over a snapshot in case unwatchSignal mutates the array
        for (const sig of [...signals]) {
          this.checkSignalLevels(sig, ltp);
        }
      }
    }
  }

  private checkLevels(trade: WatchedTrade, ltp: number): void {
    const isBuy = trade.direction === 'BUY';
    // ── 1:1 alert (direction-aware) ─────────────────────────────────────────
    if (!trade.oneToOneAlerted) {
      const hit = isBuy
        ? ltp >= trade.oneToOneLevel // BUY: price rose to 1:1
        : ltp <= trade.oneToOneLevel; // SELL: price fell to 1:1
      if (hit) {
        trade.oneToOneAlerted = true;
        this.logger.log(
          `✅ 1:1 reached for trade ${trade.tradeId}: LTP=${ltp} | 1:1=₹${trade.oneToOneLevel} [${trade.direction}]`,
        );
        this.whatsApp
          .send1to1Alert({
            optionSymbol: trade.optionSymbol,
            entryPrice: trade.entryFilledPrice,
            targetPrice: trade.oneToOneLevel,
            strategy: trade.strategy,
          })
          .catch((err: any) =>
            this.logger.error(`WhatsApp 1:1 alert failed: ${err.message}`),
          );
      }
    }
  }

  /**
   * Direction-aware signal-level check.
   * SELL: good outcomes are price-down (1:1 → target).
   * BUY:  good outcomes are price-up  (1:1 → target).
   */
  private checkSignalLevels(signal: WatchedSignal, ltp: number): void {
    const isSell = signal.direction === 'SELL';

    // Detect all conditions first so we can guarantee send order.
    const oneToOneHit =
      !signal.skipOneToOne &&
      !signal.oneToOneAlerted &&
      (isSell ? ltp <= signal.oneToOneLevel : ltp >= signal.oneToOneLevel);

    const targetHit =
      !signal.targetAlerted &&
      (isSell
        ? ltp <= signal.finalTargetLevel
        : ltp >= signal.finalTargetLevel);

    const slHit =
      !signal.slAlerted &&
      !targetHit &&
      (isSell ? ltp >= signal.slPrice : ltp <= signal.slPrice);

    // ── 1:1 alert ───────────────────────────────────────────────────────────
    if (oneToOneHit) {
      signal.oneToOneAlerted = true;
      this.logger.log(
        `📡 Signal 1:1 reached: ${signal.optionSymbol} [${signal.direction}] LTP=₹${ltp} | 1:1=₹${signal.oneToOneLevel}`,
      );
      const oneToOnePromise = this.whatsApp
        .sendSignalLevelAlert({
          optionSymbol: signal.optionSymbol,
          level: 'ONE_TO_ONE',
          ltp,
          entryPrice: signal.entryPrice,
          strategy: signal.strategy,
          direction: signal.direction,
        })
        .catch((err: any) =>
          this.logger.error(`Signal 1:1 alert failed: ${err.message}`),
        );

      // ── Target also hit in the same tick — chain to guarantee order ──────
      // If we fire both independently, Twilio delivers them in any order.
      // Chaining ensures 1:1 message is queued before TARGET.
      if (targetHit) {
        signal.targetAlerted = true;
        signal.slAlerted = true;
        this.logger.log(
          `📡 Signal target hit (same tick): ${signal.optionSymbol} [${signal.direction}] LTP=₹${ltp} | Target=₹${signal.finalTargetLevel}`,
        );
        oneToOnePromise
          .then(() =>
            this.whatsApp.sendSignalLevelAlert({
              optionSymbol: signal.optionSymbol,
              level: 'TARGET',
              ltp,
              entryPrice: signal.entryPrice,
              strategy: signal.strategy,
              direction: signal.direction,
            }),
          )
          .catch((err: any) =>
            this.logger.error(`Signal target alert failed: ${err.message}`),
          );
        this.unwatchSignal(signal.signalId);
        return;
      }
      return;
    }

    // ── Target alert (independent of 1:1) ──────────────────────────────────
    if (targetHit) {
      signal.targetAlerted = true;
      signal.slAlerted = true;
      this.logger.log(
        `📡 Signal target hit: ${signal.optionSymbol} [${signal.direction}] LTP=₹${ltp} | Target=₹${signal.finalTargetLevel}`,
      );
      this.whatsApp
        .sendSignalLevelAlert({
          optionSymbol: signal.optionSymbol,
          level: 'TARGET',
          ltp,
          entryPrice: signal.entryPrice,
          strategy: signal.strategy,
          direction: signal.direction,
        })
        .catch((err: any) =>
          this.logger.error(`Signal target alert failed: ${err.message}`),
        );
      this.unwatchSignal(signal.signalId);
      return;
    }

    // ── SL alert ───────────────────────────────────────────────────────────
    if (slHit) {
      signal.slAlerted = true;
      signal.targetAlerted = true;
      this.logger.log(
        `📡 Signal SL hit: ${signal.optionSymbol} [${signal.direction}] LTP=₹${ltp} | SL=₹${signal.slPrice}`,
      );
      this.whatsApp
        .sendSignalLevelAlert({
          optionSymbol: signal.optionSymbol,
          level: 'STOP_LOSS',
          ltp,
          entryPrice: signal.entryPrice,
          strategy: signal.strategy,
          direction: signal.direction,
        })
        .catch((err: any) =>
          this.logger.error(`Signal SL alert failed: ${err.message}`),
        );
      this.unwatchSignal(signal.signalId);
    }
  }
}

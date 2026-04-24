/**
 * Triple Sync Live Trading Engine for Delta Exchange
 *
 * STRATEGY RECAP (TRIPLE_SYNC):
 * ─────────────────────────────────────────────────────────────────────────────
 * A signal fires when three independent forces align on a CLOSED candle:
 *   1. Price > 200 EMA  (bullish) / Price < 200 EMA  (bearish)
 *   2. Supertrend is green (UP)   / Supertrend is red   (DOWN)
 *   3. ADX > adxThreshold (default 25)
 *   + trigger candle must pass quality checks (body%, wick, range)
 *   + compression / sideways filter
 *
 * EXECUTION FLOW:
 *   On signal → place a MARKET order at the current market price.
 *   On fill   → place a reduce-only LIMIT SL order using strategy-computed SL.
 *   Targets (T1/T2/T3) are logged but managed manually or by future TP logic.
 *
 * ADAPTATIONS FOR CRYPTO / DELTA EXCHANGE:
 *   - Time filter disabled (crypto trades 24/7). Set tradeStartMins=0, tradeEndMins=1439.
 *   - minCandleRange defaults to 0 (instrument-agnostic); caller supplies config.
 *   - Warm-up buffer: 250 candles (200 for EMA + safety margin).
 *   - Only ONE active position per session (no pyramiding).
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket, { type RawData } from 'ws';
import { DeltaService } from './delta.service';
import {
  detectTripleSyncSignals,
  type TripleSyncCandle,
  type TripleSyncConfig,
  type TripleSyncSignal,
} from '../../kite/strategies/triple-sync.strategy';

const DELTA_WS_URL = 'wss://socket.india.delta.exchange';
const MAX_BUFFER = 300; // rolling candle buffer (>200 for EMA warm-up)
const POLL_INTERVAL_MS = 20_000;

// ─── Internal types ───────────────────────────────────────────────────────────

interface DeltaCandle {
  time: number; // Unix seconds (candle open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ActivePosition {
  side: 'buy' | 'sell';
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;
  risk: number;
  rrr: number;
  quantity: number;
  slOrderId: number | null;
  /** Signal metadata for logging. */
  signal: TripleSyncSignal;
}

export interface TripleSyncSessionStatus {
  symbol: string;
  running: boolean;
  candleCount: number;
  activePositions: number;
  lastSignal: string | null;
  positions: Array<{
    side: string;
    entryPrice: number;
    slPrice: number;
    tp1Price: number;
    tp2Price: number;
    tp3Price: number;
    rrr: number;
    slOrderId: number | null;
  }>;
}

interface SymbolSession {
  userId: string;
  brokerId: string;
  symbol: string;
  globalSymbol: string;
  productId: number;
  quantity: number;
  strategyConfig: TripleSyncConfig;
  candles: DeltaCandle[];
  currentCandleTime: number | null;
  activePositions: ActivePosition[];
  ws: WebSocket | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastSignalTime: string | null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class TripleSyncLiveService implements OnModuleDestroy {
  private readonly logger = new Logger(TripleSyncLiveService.name);
  private readonly sessions = new Map<string, SymbolSession>();

  constructor(private readonly deltaService: DeltaService) {}

  onModuleDestroy(): void {
    for (const key of this.sessions.keys()) {
      this.stopSession(key);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(
    userId: string,
    brokerId: string,
    symbol: string,
    productId: number,
    quantity: number,
    strategyConfig: TripleSyncConfig = {},
  ): Promise<{ started: boolean; symbol: string; candlesLoaded: number }> {
    const key = this.sessionKey(userId, brokerId, symbol);
    if (this.sessions.has(key)) {
      throw new Error(
        `TRIPLE_SYNC live session already running for ${symbol}. Stop it first.`,
      );
    }

    const globalSymbol = this.deltaService.SYMBOL_MAP[symbol] ?? symbol;

    // Disable time filter for crypto (24/7 market)
    const resolvedConfig: TripleSyncConfig = {
      tradeStartMins: 0,
      tradeEndMins: 1439,
      minCandleRange: 0, // crypto-safe default; caller can override
      ...strategyConfig,
    };

    const session: SymbolSession = {
      userId,
      brokerId,
      symbol,
      globalSymbol,
      productId,
      quantity,
      strategyConfig: resolvedConfig,
      candles: [],
      currentCandleTime: null,
      activePositions: [],
      ws: null,
      pollInterval: null,
      running: true,
      lastSignalTime: null,
    };

    this.sessions.set(key, session);

    await this.loadHistory(session);
    this.connectWs(session);

    session.pollInterval = setInterval(
      () => void this.pollPositions(session),
      POLL_INTERVAL_MS,
    );

    this.logger.log(
      `[TripleSyncLive] Session started — ${symbol} productId=${productId} qty=${quantity} candles=${session.candles.length}`,
    );
    return { started: true, symbol, candlesLoaded: session.candles.length };
  }

  stop(
    userId: string,
    brokerId: string,
    symbol: string,
  ): { stopped: boolean; symbol?: string } {
    const key = this.sessionKey(userId, brokerId, symbol);
    return this.stopSession(key);
  }

  getStatus(userId: string): TripleSyncSessionStatus[] {
    const result: TripleSyncSessionStatus[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId) continue;
      result.push({
        symbol: session.symbol,
        running: session.running,
        candleCount: session.candles.length,
        activePositions: session.activePositions.length,
        lastSignal: session.lastSignalTime,
        positions: session.activePositions.map((p) => ({
          side: p.side,
          entryPrice: p.entryPrice,
          slPrice: p.slPrice,
          tp1Price: p.tp1Price,
          tp2Price: p.tp2Price,
          tp3Price: p.tp3Price,
          rrr: p.rrr,
          slOrderId: p.slOrderId,
        })),
      });
    }
    return result;
  }

  // ── Session internals ──────────────────────────────────────────────────────

  private sessionKey(userId: string, brokerId: string, symbol: string): string {
    return `${userId}:${brokerId}:${symbol}`;
  }

  private stopSession(key: string): { stopped: boolean; symbol?: string } {
    const session = this.sessions.get(key);
    if (!session) return { stopped: false };
    session.running = false;
    if (session.ws) {
      session.ws.removeAllListeners();
      session.ws.terminate();
      session.ws = null;
    }
    if (session.pollInterval) {
      clearInterval(session.pollInterval);
      session.pollInterval = null;
    }
    this.sessions.delete(key);
    this.logger.log(`[TripleSyncLive] Session stopped — ${session.symbol}`);
    return { stopped: true, symbol: session.symbol };
  }

  private async loadHistory(session: SymbolSession): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    // Fetch enough bars to warm up the 200-EMA + safety margin
    const fetchStart = now - MAX_BUFFER * 5 * 60;
    try {
      const raw = await this.deltaService.getCandles(
        session.globalSymbol,
        '5m',
        fetchStart,
        now,
      );
      session.candles = raw.map((c) => ({
        time: Math.floor(c.date.getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      this.logger.log(
        `[TripleSyncLive] Loaded ${session.candles.length} history bars for ${session.symbol}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[TripleSyncLive] History load failed for ${session.symbol}: ${err?.message}`,
      );
    }
  }

  private connectWs(session: SymbolSession): void {
    const ws = new WebSocket(DELTA_WS_URL);
    session.ws = ws;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: {
            channels: [
              { name: 'candlestick_5m', symbols: [session.globalSymbol] },
            ],
          },
        }),
      );
      this.logger.log(
        `[TripleSyncLive] WS open — subscribed to candlestick_5m:${session.globalSymbol}`,
      );
    });

    ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (
          msg.type?.startsWith('candlestick_') &&
          msg.symbol === session.globalSymbol
        ) {
          const candle: DeltaCandle = {
            time: Math.floor(Number(msg.candle_start_time) / 1_000_000),
            open: parseFloat(msg.open),
            high: parseFloat(msg.high),
            low: parseFloat(msg.low),
            close: parseFloat(msg.close),
            volume: parseFloat(msg.volume ?? '0'),
          };
          this.onCandleTick(session, candle);
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => {
      if (session.running) {
        this.logger.warn(
          `[TripleSyncLive] WS closed for ${session.symbol} — reconnecting in 5s`,
        );
        setTimeout(() => this.connectWs(session), 5_000);
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(
        `[TripleSyncLive] WS error for ${session.symbol}: ${err.message}`,
      );
    });
  }

  /**
   * Called on every tick from the Delta WS (multiple times per candle).
   * Detects candle close when the candle timestamp advances.
   */
  private onCandleTick(session: SymbolSession, candle: DeltaCandle): void {
    const prevTime = session.currentCandleTime;
    session.currentCandleTime = candle.time;

    // New candle time → previous candle just closed
    if (prevTime !== null && candle.time !== prevTime) {
      const lastStored = session.candles[session.candles.length - 1];
      if (lastStored && lastStored.time === prevTime) {
        this.onCandleClose(session, lastStored);
      }
      // Start fresh bar
      session.candles.push({ ...candle });
      if (session.candles.length > MAX_BUFFER) session.candles.shift();
    } else {
      // Same candle — update running bar
      const last = session.candles[session.candles.length - 1];
      if (last && last.time === candle.time) {
        last.high = Math.max(last.high, candle.high);
        last.low = Math.min(last.low, candle.low);
        last.close = candle.close;
        last.volume = candle.volume;
      } else {
        session.candles.push({ ...candle });
        if (session.candles.length > MAX_BUFFER) session.candles.shift();
      }
    }
  }

  /**
   * Called once per closed 5m candle.
   * Converts the buffer to TripleSyncCandle[], runs the strategy, and if the
   * latest signal lands on the just-closed bar, executes a market order.
   *
   * No new trade is opened if a position is already active (no pyramiding).
   */
  private onCandleClose(session: SymbolSession, closedBar: DeltaCandle): void {
    this.logger.debug(
      `[TripleSyncLive] ✅ Candle closed ${session.symbol} t=${new Date(closedBar.time * 1000).toISOString()} c=${closedBar.close}`,
    );

    // Skip if already in a position
    if (session.activePositions.length > 0) {
      this.logger.debug(
        `[TripleSyncLive] Position active — skipping signal scan for ${session.symbol}`,
      );
      return;
    }

    // Convert buffer to TripleSyncCandle format (date = ISO string from unix seconds)
    const tsCanldes: TripleSyncCandle[] = session.candles.map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      date: new Date(c.time * 1000),
    }));

    // Run the strategy — last candle is the just-closed one
    const signals = detectTripleSyncSignals(tsCanldes, session.strategyConfig);

    if (signals.length === 0) return;

    // Only act if the most recent signal is on the just-closed candle
    const latest = signals[signals.length - 1];
    if (latest.candleIndex !== tsCanldes.length - 1) return;

    const timeStr = new Date(closedBar.time * 1000).toISOString();
    session.lastSignalTime = timeStr;

    this.logger.log(
      `[TripleSyncLive] 🔔 SIGNAL ${latest.signalType} @ ${session.symbol} — entry=${latest.entryPrice} SL=${latest.stopLoss} T1=${latest.target1} T2=${latest.target2} T3=${latest.target3} RRR=${latest.rrr.toFixed(2)} — ${timeStr}`,
    );

    void this.executeSignal(session, latest);
  }

  /**
   * Places a market order for the given signal and, on fill, places a
   * reduce-only SL limit order at signal.stopLoss.
   */
  private async executeSignal(
    session: SymbolSession,
    signal: TripleSyncSignal,
  ): Promise<void> {
    const side: 'buy' | 'sell' = signal.signalType === 'BUY' ? 'buy' : 'sell';

    try {
      const res: any = await this.deltaService.placeOrder(
        session.userId,
        session.brokerId,
        {
          product_id: session.productId,
          side,
          order_type: 'market_order',
          size: session.quantity,
        },
      );

      const orderId: number | null = res?.result?.id ?? null;
      const fillPrice: number =
        parseFloat(res?.result?.average_fill_price ?? '0') || signal.entryPrice;

      this.logger.log(
        `[TripleSyncLive] Market order placed — ${signal.signalType} id=${orderId} approxEntry=${fillPrice}`,
      );

      // Build position — use strategy-computed SL; TP targets are informational
      const position: ActivePosition = {
        side,
        entryPrice: fillPrice,
        slPrice: signal.stopLoss,
        tp1Price: signal.target1,
        tp2Price: signal.target2,
        tp3Price: signal.target3,
        risk: signal.risk,
        rrr: signal.rrr,
        quantity: session.quantity,
        slOrderId: null,
        signal,
      };
      session.activePositions.push(position);

      // Place reduce-only SL limit order
      await this.placeSL(session, position);
    } catch (err: any) {
      this.logger.error(
        `[TripleSyncLive] executeSignal failed for ${session.symbol}: ${err?.message}`,
      );
    }
  }

  private async placeSL(
    session: SymbolSession,
    position: ActivePosition,
  ): Promise<void> {
    const slSide: 'buy' | 'sell' = position.side === 'buy' ? 'sell' : 'buy';
    try {
      const slRes: any = await this.deltaService.placeOrder(
        session.userId,
        session.brokerId,
        {
          product_id: session.productId,
          side: slSide,
          order_type: 'limit_order',
          size: position.quantity,
          limit_price: position.slPrice.toFixed(4),
          reduce_only: true,
        },
      );
      position.slOrderId = slRes?.result?.id ?? null;
      this.logger.log(
        `[TripleSyncLive] SL placed @ ${position.slPrice} id=${position.slOrderId} | TP1=${position.tp1Price} TP2=${position.tp2Price} TP3=${position.tp3Price}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[TripleSyncLive] SL placement failed for ${session.symbol}: ${err?.message}`,
      );
    }
  }

  /**
   * Polls open positions every 20 s.
   * Removes active position tracking when the position is no longer open
   * (i.e., SL or TP was hit outside this service's control).
   */
  private async pollPositions(session: SymbolSession): Promise<void> {
    if (!session.running || session.activePositions.length === 0) return;

    try {
      const res: any = await this.deltaService.getPositions(
        session.userId,
        session.brokerId,
      );
      const openSymbols = new Set<string>(
        (res?.result ?? [])
          .filter((p: any) => parseFloat(p.size ?? '0') !== 0)
          .map((p: any) => String(p.product?.symbol ?? p.symbol ?? '')),
      );

      // If our position is no longer open, clean up local state
      if (!openSymbols.has(session.globalSymbol)) {
        const cleared = session.activePositions.length;
        session.activePositions = [];
        if (cleared > 0) {
          this.logger.log(
            `[TripleSyncLive] Position closed (detected via poll) — ${session.symbol}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `[TripleSyncLive] Poll error for ${session.symbol}: ${err?.message}`,
      );
    }
  }
}

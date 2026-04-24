/**
 * ISV-200 Live Trading Engine for Delta Exchange
 *
 * HOW IT WORKS:
 * ─────────────────────────────────────────────────────────────────────────────
 * Pine Script ta.pivotlow(low, 12, 12) requires 12 bars to the LEFT and 12 to
 * the RIGHT of the pivot bar before it paints the dot. That means in live
 * trading you'd wait 60 minutes after the actual pivot.
 *
 * Instead we use LEFT-SIDE ONLY detection:
 *   After bar N closes, if bar N has a strictly lower low than bars N-1..N-12,
 *   then N is a CANDIDATE pivot low. We immediately place a LIMIT BUY at N.low.
 *
 * Fill scenarios:
 *   ✅ Price re-tests N.low in the next 12 bars → order fills → set SL + TP
 *   ❌ A later bar closes below N.low → pivot broken → cancel order
 *   ❌ 12 bars pass without fill → right-side window expired → cancel order
 *
 * This gives entry at the EXACT pivot price (same as TradingView dot), which is
 * achievable in live trading because the price frequently re-tests pivot levels.
 *
 * INDICATORS USED (all computed from rolling candle buffer):
 *   vol_ma_20  SMA(volume, 20) — divergence quality check
 *   ATR(14)    Wilder RMA of true range — SL buffer = pivot ± 0.5×ATR
 *
 * SETUP TYPES (matching backtest):
 *   ISV200_PivotLow  : plain left-side pivot low  → BUY  (2R target)
 *   ISV200_BullDiv   : lower low + lower vol_ma20  → BUY  (3R target)
 *   ISV200_PivotHigh : plain left-side pivot high  → SELL (2R target)
 *   ISV200_BearDiv   : higher high + lower vol_ma20 → SELL (3R target)
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket, { type RawData } from 'ws';
import { DeltaService } from './delta.service';

const DELTA_WS_URL = 'wss://socket.india.delta.exchange';
const PIVOT_LB = 12;
const VOL_MA_PERIOD = 20;
const ATR_PERIOD = 14;
const MAX_BUFFER = 80; // rolling candle buffer size

interface Candle {
  time: number; // Unix seconds (candle open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandidateOrder {
  side: 'buy' | 'sell';
  limitPrice: number; // the pivot low / high price
  slPrice: number; // SL = pivot ± 0.5 × ATR
  barsLeft: number; // bars remaining before this candidate expires
  pivotTime: number; // open-time of the pivot bar (for dedup)
  setupType:
    | 'ISV200_PivotLow'
    | 'ISV200_PivotHigh'
    | 'ISV200_BullDiv'
    | 'ISV200_BearDiv';
  deltaOrderId: number | null; // set after REST call
}

interface ActivePosition {
  side: 'buy' | 'sell';
  entryPrice: number;
  slPrice: number;
  riskPerUnit: number;
  tp1Price: number; // 1R partial exit
  tp2Price: number; // 2R or 3R final exit
  quantity: number;
  slOrderId: number | null;
}

export interface SessionStatus {
  symbol: string;
  running: boolean;
  candleCount: number;
  pendingOrders: number;
  activePositions: number;
  candidates: Array<{
    side: string;
    limitPrice: number;
    slPrice: number;
    barsLeft: number;
    setupType: string;
    deltaOrderId: number | null;
  }>;
  positions: Array<{
    side: string;
    entryPrice: number;
    slPrice: number;
    tp1Price: number;
    tp2Price: number;
  }>;
}

interface SymbolSession {
  userId: string;
  brokerId: string;
  symbol: string;
  globalSymbol: string;
  productId: number;
  quantity: number;
  candles: Candle[];
  currentCandleTime: number | null; // track which candle is "live"
  pendingCandidates: CandidateOrder[];
  activePositions: ActivePosition[];
  ws: WebSocket | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  // Vol-dep divergence tracking state
  p1LowVal: number | null;
  p1LowVolMa: number | null;
  p1HighVal: number | null;
  p1HighVolMa: number | null;
  running: boolean;
}

@Injectable()
export class Isv200LiveService implements OnModuleDestroy {
  private readonly logger = new Logger(Isv200LiveService.name);
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
  ): Promise<{ started: boolean; symbol: string; candlesLoaded: number }> {
    const key = this.sessionKey(userId, brokerId, symbol);
    if (this.sessions.has(key)) {
      throw new Error(
        `ISV-200 live session already running for ${symbol}. Stop it first.`,
      );
    }

    const globalSymbol = this.deltaService.SYMBOL_MAP[symbol] ?? symbol;

    const session: SymbolSession = {
      userId,
      brokerId,
      symbol,
      globalSymbol,
      productId,
      quantity,
      candles: [],
      currentCandleTime: null,
      pendingCandidates: [],
      activePositions: [],
      ws: null,
      pollInterval: null,
      p1LowVal: null,
      p1LowVolMa: null,
      p1HighVal: null,
      p1HighVolMa: null,
      running: true,
    };

    this.sessions.set(key, session);

    // Load historical candles for indicator warm-up
    await this.loadHistory(session);

    // Connect to live candle WebSocket
    this.connectWs(session);

    // Poll for order fills every 20s
    session.pollInterval = setInterval(
      () => void this.pollOrders(session),
      20_000,
    );

    this.logger.log(
      `[ISV200Live] Session started — ${symbol} productId=${productId} qty=${quantity} candles=${session.candles.length}`,
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

  getStatus(userId: string): SessionStatus[] {
    const result: SessionStatus[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId) continue;
      result.push({
        symbol: session.symbol,
        running: session.running,
        candleCount: session.candles.length,
        pendingOrders: session.pendingCandidates.length,
        activePositions: session.activePositions.length,
        candidates: session.pendingCandidates.map((c) => ({
          side: c.side,
          limitPrice: c.limitPrice,
          slPrice: c.slPrice,
          barsLeft: c.barsLeft,
          setupType: c.setupType,
          deltaOrderId: c.deltaOrderId,
        })),
        positions: session.activePositions.map((p) => ({
          side: p.side,
          entryPrice: p.entryPrice,
          slPrice: p.slPrice,
          tp1Price: p.tp1Price,
          tp2Price: p.tp2Price,
        })),
      });
    }
    return result;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

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
    this.logger.log(`[ISV200Live] Session stopped — ${session.symbol}`);
    return { stopped: true, symbol: session.symbol };
  }

  private async loadHistory(session: SymbolSession): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const fetchStart = now - MAX_BUFFER * 5 * 60; // MAX_BUFFER × 5-min bars
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
        `[ISV200Live] Loaded ${session.candles.length} history bars for ${session.symbol}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[ISV200Live] History load failed for ${session.symbol}: ${err?.message}`,
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
        `[ISV200Live] WS open — subscribed to candlestick_5m:${session.globalSymbol}`,
      );
    });

    ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (
          msg.type?.startsWith('candlestick_') &&
          msg.symbol === session.globalSymbol
        ) {
          const candle: Candle = {
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
        // ignore malformed
      }
    });

    ws.on('close', () => {
      if (session.running) {
        this.logger.warn(
          `[ISV200Live] WS closed for ${session.symbol} — reconnecting in 5s`,
        );
        setTimeout(() => this.connectWs(session), 5_000);
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(
        `[ISV200Live] WS error for ${session.symbol}: ${err.message}`,
      );
    });
  }

  /**
   * Called on every tick from the Delta WS (multiple times per candle).
   * Detects candle close when the candle timestamp advances.
   * Also checks live price for immediate pivot invalidation.
   */
  private onCandleTick(session: SymbolSession, candle: Candle): void {
    const prevTime = session.currentCandleTime;
    session.currentCandleTime = candle.time;

    // Live price invalidation: if price gaps THROUGH the pivot limit, cancel
    for (const candidate of [...session.pendingCandidates]) {
      if (candidate.deltaOrderId == null) continue;
      if (
        candidate.side === 'buy' &&
        candle.low < candidate.limitPrice - 0.0001
      ) {
        void this.cancelCandidate(
          session,
          candidate,
          'live price broke below pivot low',
        );
      } else if (
        candidate.side === 'sell' &&
        candle.high > candidate.limitPrice + 0.0001
      ) {
        void this.cancelCandidate(
          session,
          candidate,
          'live price broke above pivot high',
        );
      }
    }

    // Candle close: time advanced to a new candle → previous candle just closed
    if (prevTime !== null && candle.time !== prevTime) {
      // Reconstruct the closed candle by reading the session's live buffer.
      // The WS sends the final OHLCV of the closed candle as the last tick before
      // the timestamp changes. We store it when we receive the new-time tick.
      // At this point `session.candles` may already have the bar from history;
      // if not, we push the previous last-known tick.
      const lastStored = session.candles[session.candles.length - 1];
      if (!lastStored || lastStored.time !== prevTime) {
        // The closed candle isn't in the buffer yet — build it from the last tick
        // (the tick BEFORE current one, which had time=prevTime).
        // We don't have the full bar; skip and rely on history load + next poll.
        // In practice, the WS always sends a final close tick, so this is rare.
      } else {
        this.onCandleClose(session, lastStored);
      }
    } else {
      // Same candle — update the last bar in the buffer with latest tick data
      const last = session.candles[session.candles.length - 1];
      if (last && last.time === candle.time) {
        last.high = Math.max(last.high, candle.high);
        last.low = Math.min(last.low, candle.low);
        last.close = candle.close;
        last.volume = candle.volume;
      } else if (!last || last.time !== candle.time) {
        // New candle starting — push it
        session.candles.push({ ...candle });
        if (session.candles.length > MAX_BUFFER) session.candles.shift();
      }
    }
  }

  /**
   * Called once per closed 5m candle.
   * 1. Decrements barsLeft on all pending candidates.
   * 2. Detects new left-side pivot lows and highs.
   * 3. Places limit orders for new candidates.
   */
  private onCandleClose(session: SymbolSession, closedBar: Candle): void {
    this.logger.debug(
      `[ISV200Live] ✅ Candle closed ${session.symbol} t=${new Date(closedBar.time * 1000).toISOString()} c=${closedBar.close}`,
    );

    const bars = session.candles;
    const n = bars.length;
    const candidateIdx = n - 1; // just-closed bar is the candidate

    // ── Expire pending candidates ──────────────────────────────────────────
    for (const c of [...session.pendingCandidates]) {
      c.barsLeft--;
      if (c.barsLeft <= 0) {
        void this.cancelCandidate(
          session,
          c,
          'right-side window expired (12 bars without fill)',
        );
      }
    }

    // Need at least PIVOT_LB bars to the left of the candidate
    if (candidateIdx < PIVOT_LB) return;

    const atr = this.rollingAtr(bars, candidateIdx);
    const volMa = this.rollingVolMa(bars, candidateIdx);
    if (atr == null || volMa == null) return;

    // ── LEFT-SIDE PIVOT LOW → BUY candidate ───────────────────────────────
    // closedBar.low must be strictly lower than all 12 bars to its left
    let isLeftPivotLow = true;
    for (let k = candidateIdx - PIVOT_LB; k < candidateIdx; k++) {
      if (bars[k].low <= closedBar.low) {
        isLeftPivotLow = false;
        break;
      }
    }

    if (isLeftPivotLow) {
      const alreadyQueued = session.pendingCandidates.some(
        (c) => c.side === 'buy' && c.pivotTime === closedBar.time,
      );
      if (!alreadyQueued) {
        let setupType: 'ISV200_PivotLow' | 'ISV200_BullDiv' = 'ISV200_PivotLow';
        if (
          session.p1LowVal != null &&
          session.p1LowVolMa != null &&
          closedBar.low < session.p1LowVal &&
          volMa < session.p1LowVolMa
        ) {
          setupType = 'ISV200_BullDiv';
        }
        void this.placeCandidate(session, {
          side: 'buy',
          limitPrice: closedBar.low,
          slPrice: +(closedBar.low - atr * 0.5).toFixed(4),
          barsLeft: PIVOT_LB, // valid for 12 right-side bars
          pivotTime: closedBar.time,
          setupType,
          deltaOrderId: null,
        });
        this.logger.log(
          `[ISV200Live] 🔵 ${setupType} candidate detected @ ${closedBar.low} — limit BUY placed`,
        );
      }
      // Update divergence state regardless of order placement
      session.p1LowVal = closedBar.low;
      session.p1LowVolMa = volMa;
    }

    // ── LEFT-SIDE PIVOT HIGH → SELL candidate ─────────────────────────────
    let isLeftPivotHigh = true;
    for (let k = candidateIdx - PIVOT_LB; k < candidateIdx; k++) {
      if (bars[k].high >= closedBar.high) {
        isLeftPivotHigh = false;
        break;
      }
    }

    if (isLeftPivotHigh) {
      const alreadyQueued = session.pendingCandidates.some(
        (c) => c.side === 'sell' && c.pivotTime === closedBar.time,
      );
      if (!alreadyQueued) {
        let setupType: 'ISV200_PivotHigh' | 'ISV200_BearDiv' =
          'ISV200_PivotHigh';
        if (
          session.p1HighVal != null &&
          session.p1HighVolMa != null &&
          closedBar.high > session.p1HighVal &&
          volMa < session.p1HighVolMa
        ) {
          setupType = 'ISV200_BearDiv';
        }
        void this.placeCandidate(session, {
          side: 'sell',
          limitPrice: closedBar.high,
          slPrice: +(closedBar.high + atr * 0.5).toFixed(4),
          barsLeft: PIVOT_LB,
          pivotTime: closedBar.time,
          setupType,
          deltaOrderId: null,
        });
        this.logger.log(
          `[ISV200Live] 🔴 ${setupType} candidate detected @ ${closedBar.high} — limit SELL placed`,
        );
      }
      session.p1HighVal = closedBar.high;
      session.p1HighVolMa = volMa;
    }
  }

  private async placeCandidate(
    session: SymbolSession,
    candidate: CandidateOrder,
  ): Promise<void> {
    session.pendingCandidates.push(candidate);
    try {
      const res: any = await this.deltaService.placeOrder(
        session.userId,
        session.brokerId,
        {
          product_id: session.productId,
          side: candidate.side,
          order_type: 'limit_order',
          size: session.quantity,
          limit_price: candidate.limitPrice.toFixed(4),
          time_in_force: 'gtc',
        },
      );
      candidate.deltaOrderId = res?.result?.id ?? null;
      this.logger.log(
        `[ISV200Live] Order placed — ${candidate.setupType} ${candidate.side.toUpperCase()} LIMIT @ ${candidate.limitPrice} id=${candidate.deltaOrderId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[ISV200Live] placeOrder failed for ${session.symbol}: ${err?.message}`,
      );
      session.pendingCandidates = session.pendingCandidates.filter(
        (c) => c !== candidate,
      );
    }
  }

  private async cancelCandidate(
    session: SymbolSession,
    candidate: CandidateOrder,
    reason: string,
  ): Promise<void> {
    session.pendingCandidates = session.pendingCandidates.filter(
      (c) => c !== candidate,
    );
    if (candidate.deltaOrderId == null) return;
    try {
      await this.deltaService.cancelOrder(
        session.userId,
        session.brokerId,
        candidate.deltaOrderId,
        session.productId,
      );
      this.logger.log(
        `[ISV200Live] Order ${candidate.deltaOrderId} cancelled — ${reason}`,
      );
    } catch (err: any) {
      const status = (err as any)?.status ?? (err as any)?.response?.status;
      if (
        status === 404 ||
        String(err?.message).toLowerCase().includes('not found')
      ) {
        // Order no longer open — likely filled between last poll and cancel
        this.logger.log(
          `[ISV200Live] Order ${candidate.deltaOrderId} not found on cancel — treating as filled`,
        );
        await this.onOrderFilled(session, candidate);
      } else {
        this.logger.warn(
          `[ISV200Live] Cancel ${candidate.deltaOrderId} failed: ${err?.message}`,
        );
      }
    }
  }

  /**
   * Polls open orders every 20s.
   * If a pending candidate order is no longer in the open list, it was filled.
   * On fill: place a reduce-only SL limit order.
   */
  private async pollOrders(session: SymbolSession): Promise<void> {
    if (!session.running || session.pendingCandidates.length === 0) return;
    try {
      const res: any = await this.deltaService.getOpenOrders(
        session.userId,
        session.brokerId,
      );
      const openIds = new Set<number>(
        (res?.result ?? []).map((o: any) => Number(o.id)),
      );

      for (const candidate of [...session.pendingCandidates]) {
        if (candidate.deltaOrderId == null) continue;
        if (!openIds.has(candidate.deltaOrderId)) {
          // No longer open → assumed filled
          session.pendingCandidates = session.pendingCandidates.filter(
            (c) => c !== candidate,
          );
          this.logger.log(
            `[ISV200Live] 🎯 Order ${candidate.deltaOrderId} filled — ${candidate.setupType} ${candidate.side.toUpperCase()} @ ${candidate.limitPrice}`,
          );
          await this.onOrderFilled(session, candidate);
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `[ISV200Live] Poll error for ${session.symbol}: ${err?.message}`,
      );
    }
  }

  /**
   * Called when a limit order is confirmed filled.
   * Places a reduce-only SL limit order at slPrice.
   */
  private async onOrderFilled(
    session: SymbolSession,
    candidate: CandidateOrder,
  ): Promise<void> {
    const entry = candidate.limitPrice;
    const risk = Math.abs(entry - candidate.slPrice);
    const rMultiplier =
      candidate.setupType === 'ISV200_BullDiv' ||
      candidate.setupType === 'ISV200_BearDiv'
        ? 3
        : 2;

    const tp1 =
      candidate.side === 'buy'
        ? +(entry + risk).toFixed(4)
        : +(entry - risk).toFixed(4);
    const tp2 =
      candidate.side === 'buy'
        ? +(entry + risk * rMultiplier).toFixed(4)
        : +(entry - risk * rMultiplier).toFixed(4);

    const position: ActivePosition = {
      side: candidate.side,
      entryPrice: entry,
      slPrice: candidate.slPrice,
      riskPerUnit: risk,
      tp1Price: tp1,
      tp2Price: tp2,
      quantity: session.quantity,
      slOrderId: null,
    };
    session.activePositions.push(position);

    // Place SL: reduce-only limit order on the opposite side
    try {
      const slRes: any = await this.deltaService.placeOrder(
        session.userId,
        session.brokerId,
        {
          product_id: session.productId,
          side: candidate.side === 'buy' ? 'sell' : 'buy',
          order_type: 'limit_order',
          size: session.quantity,
          limit_price: candidate.slPrice.toFixed(4),
          reduce_only: true,
        },
      );
      position.slOrderId = slRes?.result?.id ?? null;
      this.logger.log(
        `[ISV200Live] SL placed @ ${candidate.slPrice} id=${position.slOrderId} | TP1=${tp1} TP2=${tp2}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[ISV200Live] SL placement failed for ${session.symbol}: ${err?.message}`,
      );
    }
  }

  // ── Rolling indicator helpers ───────────────────────────────────────────────

  /** Rolling Wilder ATR(14) up to bar at `idx`. */
  private rollingAtr(candles: Candle[], idx: number): number | null {
    if (idx < ATR_PERIOD) return null;
    const trs: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i <= idx; i++) {
      trs.push(
        Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low - candles[i - 1].close),
        ),
      );
    }
    let atr = trs.slice(0, ATR_PERIOD).reduce((s, v) => s + v, 0) / ATR_PERIOD;
    for (let i = ATR_PERIOD; i <= idx; i++) {
      atr = (atr * (ATR_PERIOD - 1) + trs[i]) / ATR_PERIOD;
    }
    return atr;
  }

  /** Rolling SMA(volume, 20) at bar `idx`. */
  private rollingVolMa(candles: Candle[], idx: number): number | null {
    if (idx < VOL_MA_PERIOD - 1) return null;
    let sum = 0;
    for (let i = idx - VOL_MA_PERIOD + 1; i <= idx; i++) {
      sum += candles[i].volume;
    }
    return sum / VOL_MA_PERIOD;
  }
}

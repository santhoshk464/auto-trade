import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ScanLogger } from './scan-logger.service';
import { detectLiquidityTrailSignals } from '../../kite/strategies/liquidity-trail.strategy';
import { detectTripleSyncSignals } from '../../kite/strategies/triple-sync.strategy';

const DELTA_BASE = 'https://api.india.delta.exchange/v2';
const DELTA_GLOBAL_BASE = 'https://api.india.delta.exchange/v2';

/** Per-symbol tunable thresholds for all three SCALPING setups. */
type SymbolStrategyProfile = {
  // TrendPullback
  tpNearEmaZone: number;
  tpMinBodyStr: number;
  tpMinLowerWick: number;
  tpPullbackDepthMult: number;
  tpOverextMult: number;
  // LiquiditySweep
  lsSweepLookback: number;
  lsMinBodyStr: number;
  lsCloseInUpperRange: number;
  lsCloseInLowerRange: number;
  // EmaRejection
  erBuyLowMin: number;
  erBuyLowMax: number;
  erSellHighMin: number;
  erSellHighMax: number;
  // EmaRejection soft continuation
  erSoftMinBodyStr: number; // min body/range ratio — avoids dojis
  erSoftMinWick: number; // min wick/range ratio — requires at least a moderate wick
  // LiquiditySweep context
  allowNeutralLiquiditySweep: boolean;
};

@Injectable()
export class DeltaService {
  private readonly logger = new Logger(DeltaService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async getBrokerCredentials(
    userId: string,
    brokerId: string,
  ): Promise<{ apiKey: string; apiSecret: string }> {
    const broker = await this.prisma.broker.findFirst({
      where: { id: brokerId, userId, type: 'DELTA' },
      select: { apiKey: true, apiSecret: true },
    });
    if (!broker) throw new NotFoundException('Delta broker not found');
    if (!broker.apiKey || !broker.apiSecret)
      throw new UnauthorizedException('Delta API credentials not configured');
    return { apiKey: broker.apiKey, apiSecret: broker.apiSecret };
  }

  private sign(
    secret: string,
    method: string,
    path: string,
    queryString: string,
    body: string,
    timestamp: number,
  ): string {
    const message = method + timestamp + path + queryString + body;
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
  }

  private async request<T>(
    userId: string,
    brokerId: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params?: Record<string, string | number>,
    bodyObj?: object,
  ): Promise<T> {
    const { apiKey, apiSecret } = await this.getBrokerCredentials(
      userId,
      brokerId,
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const queryString = params
      ? '?' + new URLSearchParams(params as Record<string, string>).toString()
      : '';
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const sig = this.sign(
      apiSecret,
      method,
      '/v2' + path,
      queryString || '',
      bodyStr,
      timestamp,
    );
    const url = `${DELTA_BASE}${path}${queryString}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      timestamp: String(timestamp),
      signature: sig,
    };
    this.logger.debug(`[Delta] ${method} ${url}`);
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr || undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text };
    }
    if (!res.ok) {
      this.logger.error(
        `[Delta] ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`,
      );
      const message =
        json?.error?.message ||
        json?.message ||
        `Delta API error ${res.status}`;
      throw new HttpException(
        message,
        res.status >= 400 && res.status < 600 ? res.status : 502,
      );
    }
    return json as T;
  }

  async getWallet(userId: string, brokerId: string) {
    return this.request(userId, brokerId, 'GET', '/wallet/balances');
  }

  async getPositions(userId: string, brokerId: string) {
    return this.request(userId, brokerId, 'GET', '/positions/margined');
  }

  async getOrders(userId: string, brokerId: string, state = 'all', page = 1) {
    return this.request(userId, brokerId, 'GET', '/orders', {
      state,
      page,
      page_size: 50,
    });
  }

  async getOpenOrders(userId: string, brokerId: string) {
    return this.request(userId, brokerId, 'GET', '/orders', { state: 'open' });
  }

  async placeOrder(
    userId: string,
    brokerId: string,
    body: {
      product_id: number;
      side: 'buy' | 'sell';
      order_type: 'market_order' | 'limit_order';
      size: number;
      limit_price?: string;
      time_in_force?: string;
      reduce_only?: boolean;
    },
  ) {
    return this.request(userId, brokerId, 'POST', '/orders', undefined, body);
  }

  async cancelOrder(
    userId: string,
    brokerId: string,
    orderId: number,
    productId: number,
  ) {
    return this.request(
      userId,
      brokerId,
      'DELETE',
      `/orders/${orderId}`,
      undefined,
      {
        product_id: productId,
      },
    );
  }

  async getProducts(contractTypes = 'perpetual_futures') {
    const qs =
      '?' + new URLSearchParams({ contract_types: contractTypes }).toString();
    const res = await fetch(`${DELTA_BASE}/products${qs}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (!res.ok)
      throw new Error((json as any)?.message || 'Failed to fetch products');
    return json;
  }

  async getTicker(symbol: string) {
    const res = await fetch(`${DELTA_BASE}/tickers/${symbol}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (!res.ok)
      throw new Error((json as any)?.message || 'Failed to fetch ticker');
    return json;
  }

  //  Candle helpers (public — used by DeltaGateway)

  /** Map frontend interval strings to Delta resolution codes */
  toDeltaResolution(interval: string): string {
    const map: Record<string, string> = {
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '30m': '30m',
      '1h': '1h',
    };
    return map[interval] ?? '5m';
  }

  intervalToSeconds(interval: string): number {
    const map: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '30m': 1800,
      '1h': 3600,
    };
    return map[interval] ?? 300;
  }

  /** Symbol name mapping: frontend name → Delta India symbol (no change needed, same names) */
  readonly SYMBOL_MAP: Record<string, string> = {
    BTCUSD: 'BTCUSD',
    ETHUSD: 'ETHUSD',
    SOLUSD: 'SOLUSD',
    XRPUSD: 'XRPUSD',
    BNBUSD: 'BNBUSD',
  };

  /** Fetch OHLCV candles from Delta Exchange (public, no auth required). */
  async getCandles(
    symbol: string,
    resolution: string,
    startTs: number,
    endTs: number,
  ): Promise<
    Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>
  > {
    const qs = new URLSearchParams({
      symbol,
      resolution,
      start: String(startTs),
      end: String(endTs),
    }).toString();
    const url = `${DELTA_GLOBAL_BASE}/history/candles?${qs}`;
    this.logger.log(`[Delta Candles] ${url}`);
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });
    const json: any = await res.json();
    if (!res.ok)
      throw new Error(json?.message || `Delta candle API error ${res.status}`);

    let raw: any[] = [];
    if (Array.isArray(json?.result?.candles)) raw = json.result.candles;
    else if (Array.isArray(json?.result)) raw = json.result;
    else if (Array.isArray(json)) raw = json;

    if (raw.length === 0) {
      this.logger.warn(`[Delta Candles] No candles returned for ${symbol}`);
    }

    return raw
      .map((item) => {
        if (Array.isArray(item)) {
          const [t, o, h, l, c, v] = item;
          return {
            date: new Date(t * 1000),
            open: +o,
            high: +h,
            low: +l,
            close: +c,
            volume: +v,
          };
        }
        return {
          date: new Date((item.time ?? item.t) * 1000),
          open: +item.open,
          high: +item.high,
          low: +item.low,
          close: +item.close,
          volume: +(item.volume ?? 0),
        };
      })
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // ─── Trade Finder ────────────────────────────────────────────────────────────

  /**
   * Fetch candles for the given date range (paging through Delta's 2000-candle
   * limit) and return all pages merged and de-duplicated.
   */
  private async fetchCandlesRange(
    symbol: string,
    resolution: string,
    startTs: number,
    endTs: number,
  ) {
    const allCandles: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }> = [];

    let from = startTs;
    const pageSize = 2000;
    const stepSeconds = this.intervalToSeconds(resolution) * pageSize;

    while (from < endTs) {
      const to = Math.min(from + stepSeconds, endTs);
      const batch = await this.getCandles(symbol, resolution, from, to);
      allCandles.push(...batch);
      if (batch.length < pageSize) break; // no more data
      from = to + 1;
    }

    // De-duplicate by timestamp
    const seen = new Set<number>();
    return allCandles
      .filter((c) => {
        const ts = c.date.getTime();
        if (seen.has(ts)) return false;
        seen.add(ts);
        return true;
      })
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  private calcEMA(data: number[], period: number): (number | null)[] {
    if (data.length < period) return data.map(() => null);
    const k = 2 / (period + 1);
    const out: (number | null)[] = new Array(period - 1).fill(null);
    const seed = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
    out.push(seed);
    for (let i = period; i < data.length; i++) {
      out.push(data[i] * k + out[i - 1]! * (1 - k));
    }
    return out;
  }

  private calcRSI(data: number[], period = 14): (number | null)[] {
    if (data.length < period + 1) return data.map(() => null);
    const out: (number | null)[] = new Array(period).fill(null);
    let avgGain = 0,
      avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = data[i] - data[i - 1];
      avgGain += d > 0 ? d : 0;
      avgLoss += d < 0 ? -d : 0;
    }
    avgGain /= period;
    avgLoss /= period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < data.length; i++) {
      const d = data[i] - data[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return out;
  }

  private calcSuperTrend(
    candles: Array<{ high: number; low: number; close: number }>,
    period = 10,
    multiplier = 2,
  ): Array<{ value: number; trend: 'up' | 'down' } | null> {
    const n = candles.length;
    if (n < period + 1) return candles.map(() => null);

    const tr: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < n; i++) {
      tr.push(
        Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low - candles[i - 1].close),
        ),
      );
    }
    const atr = new Array(n).fill(0);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    atr[period - 1] = sum / period;
    for (let i = period; i < n; i++)
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;

    const result: Array<{ value: number; trend: 'up' | 'down' } | null> =
      new Array(period - 1).fill(null);
    let ub = 0,
      lb = 0,
      st = 0;
    let trend: 'up' | 'down' = 'up';

    for (let i = period - 1; i < n; i++) {
      const hl2 = (candles[i].high + candles[i].low) / 2;
      const bu = hl2 + multiplier * atr[i];
      const bl = hl2 - multiplier * atr[i];
      const prevClose =
        i === period - 1 ? candles[i].close : candles[i - 1].close;

      const nu = i === period - 1 || bu < ub || prevClose > ub ? bu : ub;
      const nl = i === period - 1 || bl > lb || prevClose < lb ? bl : lb;

      if (i === period - 1) {
        trend = candles[i].close > hl2 ? 'up' : 'down';
      } else if (st === ub) {
        trend = candles[i].close > nu ? 'up' : 'down';
      } else {
        trend = candles[i].close < nl ? 'down' : 'up';
      }

      st = trend === 'up' ? nl : nu;
      ub = nu;
      lb = nl;
      result.push({ value: st, trend });
    }
    return result;
  }

  /** Wilder ATR — returns (number|null)[] with nulls for the first (period-1) bars */
  private calcATR(
    candles: Array<{ high: number; low: number; close: number }>,
    period = 14,
  ): (number | null)[] {
    const n = candles.length;
    if (n < period + 1) return candles.map(() => null);
    const tr: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < n; i++) {
      tr.push(
        Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low - candles[i - 1].close),
        ),
      );
    }
    const out: (number | null)[] = new Array(period - 1).fill(null);
    let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    out.push(atr);
    for (let i = period; i < n; i++) {
      atr = (atr * (period - 1) + tr[i]) / period;
      out.push(atr);
    }
    return out;
  }

  /** Simple SMA — returns nulls for the warm-up period (first period-1 bars). */
  private calcSMA(data: number[], period: number): (number | null)[] {
    if (data.length < period) return data.map(() => null);
    const out: (number | null)[] = new Array(period - 1).fill(null);
    let sum = data.slice(0, period).reduce((s, v) => s + v, 0);
    out.push(sum / period);
    for (let i = period; i < data.length; i++) {
      sum = sum - data[i - period] + data[i];
      out.push(sum / period);
    }
    return out;
  }

  /** Population standard deviation using a rolling window — nulls for warm-up. */
  private calcStdDev(data: number[], period: number): (number | null)[] {
    const sma = this.calcSMA(data, period);
    const out: (number | null)[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1 || sma[i] == null) {
        out.push(null);
        continue;
      }
      const slice = data.slice(i - period + 1, i + 1);
      const mean = sma[i]!;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
      out.push(Math.sqrt(variance));
    }
    return out;
  }

  /** Compress base-TF candles into HTF candles by grouping every `groupSize` bars. */
  private groupCandlesHTF(
    candles: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    groupSize: number,
  ): Array<{
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> {
    const result: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }> = [];
    for (let i = 0; i + groupSize <= candles.length; i += groupSize) {
      const group = candles.slice(i, i + groupSize);
      result.push({
        date: group[0].date,
        open: group[0].open,
        high: Math.max(...group.map((c) => c.high)),
        low: Math.min(...group.map((c) => c.low)),
        close: group[group.length - 1].close,
        volume: group.reduce((s, c) => s + c.volume, 0),
      });
    }
    return result;
  }

  /** Derive higher-timeframe trend bias from EMA20 position + basic HH/HL or LH/LL structure. */
  private getHTFBias(
    htfCandles: Array<{ high: number; low: number; close: number }>,
    htfEma20: (number | null)[],
    htfIdx: number,
  ): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (htfIdx < 8) return 'NEUTRAL';
    const ema = htfEma20[htfIdx];
    if (ema == null) return 'NEUTRAL';
    const close = htfCandles[htfIdx].close;

    const start = Math.max(0, htfIdx - 7);
    const slice = htfCandles.slice(start, htfIdx + 1);
    const half = Math.floor(slice.length / 2);
    if (half < 1) return 'NEUTRAL';

    const recentHigh = Math.max(...slice.slice(-half).map((c) => c.high));
    const prevHigh = Math.max(...slice.slice(0, half).map((c) => c.high));
    const recentLow = Math.min(...slice.slice(-half).map((c) => c.low));
    const prevLow = Math.min(...slice.slice(0, half).map((c) => c.low));

    const hhhl = recentHigh > prevHigh && recentLow > prevLow;
    const lhll = recentHigh < prevHigh && recentLow < prevLow;

    if (close > ema && hhhl) return 'BULLISH';
    if (close < ema && lhll) return 'BEARISH';
    if (close > ema) return 'BULLISH';
    if (close < ema) return 'BEARISH';
    return 'NEUTRAL';
  }

  /** SCALPING strategy: priority-based mutual exclusivity + cooldown. One signal per candle. */
  private runScalpingStrategy(
    candles: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    closes: number[],
    raw: Array<{
      candleIdx: number;
      type: 'BUY' | 'SELL';
      setupType?: string;
      slRef?: number;
      atrAtSignal?: number;
      ema20AtSignal?: number | null;
      reason: string;
    }>,
    symbol: string,
    scanLog: ScanLogger,
  ): void {
    // 1m entry + 5m HTF bias: group every 5 entry candles into one 5m bias candle
    const htfGroupSize = 5;
    const htfCandles = this.groupCandlesHTF(candles, htfGroupSize);
    const htfEma20 = this.calcEMA(
      htfCandles.map((c) => c.close),
      20,
    );
    const ema20 = this.calcEMA(closes, 20);
    const atr14 = this.calcATR(candles, 14);
    const profile = this.getSymbolStrategyProfile(symbol);

    // Cooldown: 7 1m-candles prevents same-side/same-setup rapid-fire duplication
    const COOLDOWN = 7;
    let lastBuyIdx = -COOLDOWN;
    let lastSellIdx = -COOLDOWN;
    const lastSetupIdx: Record<string, number> = {
      TrendPullback: -COOLDOWN,
      LiquiditySweep: -COOLDOWN,
      EmaRejection: -COOLDOWN,
    };

    // HTF-leg lockout: after a setup+side fires, disarm it until price makes a fresh
    // structural extension beyond the swing reference recorded at signal time.
    // This prevents repeated lower-quality re-entries in the same HTF leg.
    const SETUPS = ['TrendPullback', 'LiquiditySweep', 'EmaRejection'] as const;
    const legArmed: Record<string, boolean> = {};
    const legSwingRef: Record<string, number> = {};
    for (const s of SETUPS) {
      legArmed[`${s}_BUY`] = true;
      legArmed[`${s}_SELL`] = true;
      legSwingRef[`${s}_BUY`] = 0; // re-arms when candle high exceeds this
      legSwingRef[`${s}_SELL`] = Infinity; // re-arms when candle low undercuts this
    }

    // Side-wide HTF leg lock: after ANY winner fires on one side, all setups on that
    // side are blocked until a fresh 5m structural extension breaks beyond the swing reference.
    const sideLegArmed = { BUY: true, SELL: true } as Record<string, boolean>;
    const sideLegSwingRef = { BUY: 0, SELL: Infinity } as Record<
      string,
      number
    >;

    for (let i = 30; i < candles.length; i++) {
      const atr = atr14[i];
      const checks: Record<string, string> = {};
      let signalFired: string | null = null;

      if (!atr) {
        checks['atr'] = 'SKIP – ATR not ready';
        scanLog.logCandle({
          idx: i,
          time:
            candles[i].date
              .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
              .replace(' ', 'T') + '+05:30',
          open: candles[i].open,
          high: candles[i].high,
          low: candles[i].low,
          close: candles[i].close,
          ema20: ema20[i],
          atr,
          checks,
          signal: null,
        });
        continue;
      }

      // 1m ATR is naturally smaller; filter at 0.03% (was 0.1% for 5m)
      if (atr < closes[i] * 0.0003) {
        checks['atr_filter'] =
          `SKIP – ATR=${atr.toFixed(6)} < 0.03% of price (${(closes[i] * 0.0003).toFixed(6)})`;
        scanLog.logCandle({
          idx: i,
          time:
            candles[i].date
              .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
              .replace(' ', 'T') + '+05:30',
          open: candles[i].open,
          high: candles[i].high,
          low: candles[i].low,
          close: candles[i].close,
          ema20: ema20[i],
          atr,
          checks,
          signal: null,
        });
        continue;
      }

      const htfIdx = Math.floor(i / htfGroupSize);
      if (htfIdx < 12) {
        checks['htf_warmup'] =
          `SKIP – htfIdx=${htfIdx} < 12 (HTF EMA not warmed up)`;
        scanLog.logCandle({
          idx: i,
          time:
            candles[i].date
              .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
              .replace(' ', 'T') + '+05:30',
          open: candles[i].open,
          high: candles[i].high,
          low: candles[i].low,
          close: candles[i].close,
          ema20: ema20[i],
          atr,
          checks,
          signal: null,
        });
        continue;
      }

      const htfBias = this.getHTFBias(htfCandles, htfEma20, htfIdx);
      checks['htf_bias'] = `htfIdx=${htfIdx} bias=${htfBias}`;
      checks['atr_filter'] = `PASS ATR=${atr.toFixed(6)} >= 0.1% of price`;

      // Setup-level structural re-arm: stricter 1.5× ATR threshold
      for (const s of SETUPS) {
        if (
          !legArmed[`${s}_BUY`] &&
          candles[i].high > legSwingRef[`${s}_BUY`] + atr * 1.5
        )
          legArmed[`${s}_BUY`] = true;
        if (
          !legArmed[`${s}_SELL`] &&
          candles[i].low < legSwingRef[`${s}_SELL`] - atr * 1.5
        )
          legArmed[`${s}_SELL`] = true;
      }

      // Side-wide re-arm: only when a completed 5m candle breaks beyond the recorded swing reference
      const htfC = htfCandles[htfIdx];
      if (!sideLegArmed.BUY && htfC && htfC.high > sideLegSwingRef.BUY)
        sideLegArmed.BUY = true;
      if (!sideLegArmed.SELL && htfC && htfC.low < sideLegSwingRef.SELL)
        sideLegArmed.SELL = true;
      checks['sideLock'] =
        `BUY=${sideLegArmed.BUY ? 'armed' : 'locked'} SELL=${sideLegArmed.SELL ? 'armed' : 'locked'}`;

      // Run all three setups
      const ls = this.checkLiquiditySweep(candles, htfBias, i, profile);
      const er = this.checkEmaRejection(candles, ema20, htfBias, i, profile);
      const tp = this.checkTrendPullback(
        candles,
        ema20,
        htfBias,
        i,
        atr,
        profile,
      );

      // Apply setup-level AND side-wide leg lock before building candidate list
      const lsSetupOk = ls ? legArmed[`LiquiditySweep_${ls.type}`] : false;
      const lsSideOk = ls ? sideLegArmed[ls.type] : false;
      const lsFiltered = ls && lsSetupOk && lsSideOk ? ls : null;

      const erSetupOk = er ? legArmed[`EmaRejection_${er.type}`] : false;
      const erSideOk = er ? sideLegArmed[er.type] : false;
      const erFiltered = er && erSetupOk && erSideOk ? er : null;

      const tpSetupOk = tp ? legArmed[`TrendPullback_${tp.type}`] : false;
      const tpSideOk = tp ? sideLegArmed[tp.type] : false;
      const tpFiltered = tp && tpSetupOk && tpSideOk ? tp : null;

      checks['liquiditySweep'] = ls
        ? `MATCH ${ls.type}${!lsFiltered ? (!lsSetupOk ? ' (leg-locked)' : ' (side-locked)') : ''}`
        : 'no match';
      checks['emaRejection'] = er
        ? `MATCH ${er.type}${!erFiltered ? (!erSetupOk ? ' (leg-locked)' : ' (side-locked)') : ''}`
        : 'no match';
      checks['trendPullback'] = tp
        ? `MATCH ${tp.type}${!tpFiltered ? (!tpSetupOk ? ' (leg-locked)' : ' (side-locked)') : ''}`
        : 'no match';

      // Priority order: LiquiditySweep > EmaRejection > TrendPullback
      // One signal per candle; skip if within COOLDOWN bars of same side or same setup
      type Candidate = {
        type: 'BUY' | 'SELL';
        setupType: string;
        reason: string;
        slRef: number;
      };
      const candidates: (Candidate | null)[] = [
        lsFiltered ? { ...lsFiltered, setupType: 'LiquiditySweep' } : null,
        erFiltered ? { ...erFiltered, setupType: 'EmaRejection' } : null,
        tpFiltered ? { ...tpFiltered, setupType: 'TrendPullback' } : null,
      ];

      let winner: Candidate | null = null;
      for (const candidate of candidates) {
        if (!candidate) continue;
        const sideCooldownOk =
          candidate.type === 'BUY'
            ? i - lastBuyIdx >= COOLDOWN
            : i - lastSellIdx >= COOLDOWN;
        const setupCooldownOk =
          i - (lastSetupIdx[candidate.setupType] ?? -COOLDOWN) >= COOLDOWN;
        if (sideCooldownOk && setupCooldownOk) {
          winner = candidate;
          break;
        }
      }

      if (winner) {
        raw.push({
          candleIdx: i,
          type: winner.type,
          setupType: winner.setupType,
          slRef: winner.slRef,
          atrAtSignal: atr,
          ema20AtSignal: ema20[i] ?? null,
          reason: winner.reason,
        });
        if (winner.type === 'BUY') lastBuyIdx = i;
        else lastSellIdx = i;
        lastSetupIdx[winner.setupType] = i;
        signalFired = `${winner.type}:${winner.setupType}`;
        checks[winner.setupType] = `SIGNAL ${winner.type} (winner)`;
        // Disarm setup-level leg lock for this specific setup+side
        const legKey = `${winner.setupType}_${winner.type}`;
        legArmed[legKey] = false;
        if (winner.type === 'BUY') {
          legSwingRef[legKey] = Math.max(
            ...candles.slice(Math.max(0, i - 19), i + 1).map((cc) => cc.high),
          );
        } else {
          legSwingRef[legKey] = Math.min(
            ...candles.slice(Math.max(0, i - 19), i + 1).map((cc) => cc.low),
          );
        }
        // Disarm side-wide leg lock — re-arm requires a fresh 5m swing extension
        sideLegArmed[winner.type] = false;
        const htfIdxNow = Math.floor(i / htfGroupSize);
        if (winner.type === 'BUY') {
          const hStart = Math.max(0, htfIdxNow - 3);
          sideLegSwingRef.BUY = Math.max(
            ...htfCandles.slice(hStart, htfIdxNow + 1).map((cc) => cc.high),
          );
        } else {
          const hStart = Math.max(0, htfIdxNow - 3);
          sideLegSwingRef.SELL = Math.min(
            ...htfCandles.slice(hStart, htfIdxNow + 1).map((cc) => cc.low),
          );
        }
      }

      scanLog.logCandle({
        idx: i,
        time:
          candles[i].date
            .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
            .replace(' ', 'T') + '+05:30',
        open: candles[i].open,
        high: candles[i].high,
        low: candles[i].low,
        close: candles[i].close,
        ema20: ema20[i],
        atr,
        htfBias,
        checks,
        signal: signalFired,
      });
    }
  }

  /** Returns true if price closed ≥ minExpansion away from EMA20 in the recent lookback,
   *  confirming a prior impulse leg before the current pullback. */
  private hasFreshImpulse(
    candles: Array<{ high: number; low: number; close: number }>,
    ema20: (number | null)[],
    direction: 'BUY' | 'SELL',
    i: number,
    lookback = 25, // 25 1m-candles = ~25 min lookback for prior impulse
    minExpansion = 0.003,
  ): boolean {
    const end = Math.max(0, i - 1);
    const start = Math.max(0, end - lookback);
    for (let j = start; j < end; j++) {
      const ema = ema20[j];
      if (!ema) continue;
      if (direction === 'BUY' && candles[j].close >= ema * (1 + minExpansion))
        return true;
      if (direction === 'SELL' && candles[j].close <= ema * (1 - minExpansion))
        return true;
    }
    return false;
  }

  /** SCALPING Setup 1: Trend Pullback — strict: EMA slope + strong body + close requirements. */
  private checkTrendPullback(
    candles: Array<{ open: number; high: number; low: number; close: number }>,
    ema20: (number | null)[],
    htfBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    i: number,
    atr: number,
    profile: SymbolStrategyProfile,
  ): { type: 'BUY' | 'SELL'; reason: string; slRef: number } | null {
    if (htfBias === 'NEUTRAL' || i < 5) return null;
    const c = candles[i];
    const prev = candles[i - 1];
    const ema = ema20[i];
    const emaP = ema20[i - 1];
    const em5 = ema20[i - 5];
    if (!ema || !emaP || !em5) return null;

    // Reject flat/sideways EMA
    const emaSlope = (ema - em5) / em5;
    if (Math.abs(emaSlope) < 0.0005) return null;

    const range = c.high - c.low;
    if (range === 0) return null;
    const body = Math.abs(c.close - c.open);
    const bodyStrength = body / range;
    const lowerWick = (Math.min(c.open, c.close) - c.low) / range;
    const upperWick = (c.high - Math.max(c.open, c.close)) / range;

    if (htfBias === 'BULLISH') {
      const nearEma =
        prev.low <= emaP * (1 + profile.tpNearEmaZone) &&
        prev.low >= emaP * (1 - profile.tpNearEmaZone);
      const bullishC = c.close > c.open;
      const aboveEma = c.close > ema;
      const abovePrevClose = c.close > prev.close;
      const strongBody = bodyStrength > profile.tpMinBodyStr;
      const hasLowerWick = lowerWick > profile.tpMinLowerWick;
      const freshImpulse = this.hasFreshImpulse(candles, ema20, 'BUY', i);
      const recentHigh = Math.max(
        ...candles.slice(Math.max(0, i - 20), i).map((x) => x.high),
      );
      const hasDepth =
        recentHigh - prev.low >= atr * profile.tpPullbackDepthMult;
      const notOverextended = c.close - ema <= atr * profile.tpOverextMult;

      if (
        nearEma &&
        bullishC &&
        aboveEma &&
        abovePrevClose &&
        strongBody &&
        hasLowerWick &&
        freshImpulse &&
        hasDepth &&
        notOverextended
      ) {
        return {
          type: 'BUY',
          reason: `Trend Pullback BUY: HTF bullish, pulled back to EMA20 (${ema.toFixed(4)}), strong reclaim`,
          slRef: prev.low,
        };
      }
    }

    if (htfBias === 'BEARISH') {
      const nearEma =
        prev.high >= emaP * (1 - profile.tpNearEmaZone) &&
        prev.high <= emaP * (1 + profile.tpNearEmaZone);
      const bearishC = c.close < c.open;
      const belowEma = c.close < ema;
      const belowPrevClose = c.close < prev.close;
      const strongBody = bodyStrength > profile.tpMinBodyStr;
      const hasUpperWick = upperWick > profile.tpMinLowerWick;
      const freshImpulse = this.hasFreshImpulse(candles, ema20, 'SELL', i);
      const recentLow = Math.min(
        ...candles.slice(Math.max(0, i - 20), i).map((x) => x.low),
      );
      const hasDepth =
        prev.high - recentLow >= atr * profile.tpPullbackDepthMult;
      const notOverextended = ema - c.close <= atr * profile.tpOverextMult;

      if (
        nearEma &&
        bearishC &&
        belowEma &&
        belowPrevClose &&
        strongBody &&
        hasUpperWick &&
        freshImpulse &&
        hasDepth &&
        notOverextended
      ) {
        return {
          type: 'SELL',
          reason: `Trend Pullback SELL: HTF bearish, pulled back to EMA20 (${ema.toFixed(4)}), strong rejection`,
          slRef: prev.high,
        };
      }
    }

    return null;
  }

  /** SCALPING Setup 2: Liquidity Sweep — sweep of recent swing then strong reclaim/rejection. */
  private checkLiquiditySweep(
    candles: Array<{ open: number; high: number; low: number; close: number }>,
    htfBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    i: number,
    profile: SymbolStrategyProfile,
  ): { type: 'BUY' | 'SELL'; reason: string; slRef: number } | null {
    const lookback = profile.lsSweepLookback;
    // Need at least lookback+1 candles so the reference window excludes prev (the sweep candle)
    if (i < lookback + 1) return null;
    const c = candles[i];
    const prev = candles[i - 1];
    const range = c.high - c.low;
    if (range === 0) return null;

    // Reference window excludes prev so prev.low/high can genuinely break the swing
    const refWindow = candles.slice(i - lookback, i - 1);
    const swingHigh = Math.max(...refWindow.map((x) => x.high));
    const swingLow = Math.min(...refWindow.map((x) => x.low));
    const bodyStr = Math.abs(c.close - c.open) / range;

    // BUY: only in BULLISH HTF context (or NEUTRAL if explicitly enabled in profile)
    const buyBiasOk =
      htfBias === 'BULLISH' ||
      (htfBias === 'NEUTRAL' && profile.allowNeutralLiquiditySweep);
    if (buyBiasOk) {
      const prevSweepBuy = prev.low < swingLow && c.close > swingLow;
      const selfSweepBuy = c.low < swingLow && c.close > swingLow;
      const closeInUpperRange =
        c.close >= c.low + range * profile.lsCloseInUpperRange;
      if (
        (prevSweepBuy || selfSweepBuy) &&
        c.close > c.open &&
        bodyStr > profile.lsMinBodyStr &&
        closeInUpperRange
      ) {
        const sweepLow = prevSweepBuy ? prev.low : c.low;
        return {
          type: 'BUY',
          reason: `Liquidity Sweep BUY: swept swing low (${swingLow.toFixed(4)}), strong bullish reclaim`,
          slRef: sweepLow,
        };
      }
    }

    // SELL: only in BEARISH HTF context (or NEUTRAL if explicitly enabled in profile)
    const sellBiasOk =
      htfBias === 'BEARISH' ||
      (htfBias === 'NEUTRAL' && profile.allowNeutralLiquiditySweep);
    if (sellBiasOk) {
      const prevSweepSell = prev.high > swingHigh && c.close < swingHigh;
      const selfSweepSell = c.high > swingHigh && c.close < swingHigh;
      const closeInLowerRange =
        c.close <= c.low + range * profile.lsCloseInLowerRange;
      if (
        (prevSweepSell || selfSweepSell) &&
        c.close < c.open &&
        bodyStr > profile.lsMinBodyStr &&
        closeInLowerRange
      ) {
        const sweepHigh = prevSweepSell ? prev.high : c.high;
        return {
          type: 'SELL',
          reason: `Liquidity Sweep SELL: swept swing high (${swingHigh.toFixed(4)}), strong bearish rejection`,
          slRef: sweepHigh,
        };
      }
    }

    return null;
  }

  /** SCALPING Setup 3: EMA Rejection — strong wick off EMA20, close on correct side, EMA not flat. */
  private checkEmaRejection(
    candles: Array<{ open: number; high: number; low: number; close: number }>,
    ema20: (number | null)[],
    htfBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    i: number,
    profile: SymbolStrategyProfile,
  ): { type: 'BUY' | 'SELL'; reason: string; slRef: number } | null {
    if (htfBias === 'NEUTRAL' || i < 5) return null;
    const c = candles[i];
    const ema = ema20[i];
    const em5 = ema20[i - 5];
    if (!ema || !em5) return null;

    const emaSlope = (ema - em5) / em5;
    if (Math.abs(emaSlope) < 0.0005) return null; // flat EMA — skip

    const range = c.high - c.low;
    if (range === 0) return null;
    const body = Math.abs(c.close - c.open);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);

    if (htfBias === 'BULLISH') {
      const touchedEma =
        c.low <= ema * profile.erBuyLowMax &&
        c.low >= ema * profile.erBuyLowMin;
      const closeAboveEma = c.close > ema;
      const bullishClose = c.close > c.open;

      // Strict mode: strong wick rejection — primary / A+ setup
      const strongLowWick = lowerWick > body * 1.2 && lowerWick / range > 0.3;
      if (touchedEma && closeAboveEma && strongLowWick && bullishClose) {
        return {
          type: 'BUY',
          reason: `EMA Rejection BUY (strict wick rejection): strong lower wick off EMA20 (${ema.toFixed(4)})`,
          slRef: c.low,
        };
      }

      // Soft continuation mode: HTF bullish, EMA sloping up, touch + clean close back above EMA,
      // decent body (avoids dojis), at least a moderate lower wick
      const softBodyOk = body / range >= profile.erSoftMinBodyStr;
      const softWickOk = lowerWick / range >= profile.erSoftMinWick;
      const slopeBullish = emaSlope > 0;
      if (
        touchedEma &&
        closeAboveEma &&
        bullishClose &&
        softBodyOk &&
        softWickOk &&
        slopeBullish
      ) {
        return {
          type: 'BUY',
          reason: `EMA Rejection BUY (soft continuation close-back-above-EMA): EMA20 (${ema.toFixed(4)})`,
          slRef: c.low,
        };
      }
    }

    if (htfBias === 'BEARISH') {
      const touchedEma =
        c.high >= ema * profile.erSellHighMin &&
        c.high <= ema * profile.erSellHighMax;
      const closeBelowEma = c.close < ema;
      const bearishClose = c.close < c.open;

      // Strict mode: strong wick rejection — primary / A+ setup
      const strongUpWick = upperWick > body * 1.2 && upperWick / range > 0.3;
      if (touchedEma && closeBelowEma && strongUpWick && bearishClose) {
        return {
          type: 'SELL',
          reason: `EMA Rejection SELL (strict wick rejection): strong upper wick off EMA20 (${ema.toFixed(4)})`,
          slRef: c.high,
        };
      }

      // Soft continuation mode: HTF bearish, EMA sloping down, touch + clean close back below EMA,
      // decent body (avoids dojis), at least a moderate upper wick
      const softBodyOk = body / range >= profile.erSoftMinBodyStr;
      const softWickOk = upperWick / range >= profile.erSoftMinWick;
      const slopeBearish = emaSlope < 0;
      if (
        touchedEma &&
        closeBelowEma &&
        bearishClose &&
        softBodyOk &&
        softWickOk &&
        slopeBearish
      ) {
        return {
          type: 'SELL',
          reason: `EMA Rejection SELL (soft continuation close-back-below-EMA): EMA20 (${ema.toFixed(4)})`,
          slRef: c.high,
        };
      }
    }

    return null;
  }

  /** Symbol-specific strategy profile: per-symbol threshold tuning for setup detection. */
  private getSymbolStrategyProfile(symbol: string): SymbolStrategyProfile {
    const s = symbol.toUpperCase();
    if (s.startsWith('XRP')) {
      // Slightly tightened vs previous XRP version — still looser than ETH/SOL default
      return {
        tpNearEmaZone: 0.004,
        tpMinBodyStr: 0.32,
        tpMinLowerWick: 0.19,
        tpPullbackDepthMult: 0.9,
        tpOverextMult: 2.2,
        lsSweepLookback: 11,
        lsMinBodyStr: 0.37,
        lsCloseInUpperRange: 0.57,
        lsCloseInLowerRange: 0.43,
        erBuyLowMin: 0.989,
        erBuyLowMax: 1.005,
        erSellHighMin: 0.995,
        erSellHighMax: 1.011,
        erSoftMinBodyStr: 0.32,
        erSoftMinWick: 0.1,
        allowNeutralLiquiditySweep: false,
      };
    }
    // Default (ETH, SOL, and all others)
    return {
      tpNearEmaZone: 0.003,
      tpMinBodyStr: 0.35,
      tpMinLowerWick: 0.2,
      tpPullbackDepthMult: 1.0,
      tpOverextMult: 2.0,
      lsSweepLookback: 10,
      lsMinBodyStr: 0.4,
      lsCloseInUpperRange: 0.6,
      lsCloseInLowerRange: 0.4,
      erBuyLowMin: 0.99,
      erBuyLowMax: 1.004,
      erSellHighMin: 0.996,
      erSellHighMax: 1.01,
      erSoftMinBodyStr: 0.35,
      erSoftMinWick: 0.1,
      allowNeutralLiquiditySweep: false,
    };
  }

  /**
   * Checks a completed 5m candle for structural weakness to exit a runner trade.
   * Returns the exit reason string or null if no weakness detected.
   */
  private detect5mRunnerExit(
    htfCandles: Array<{
      open: number;
      high: number;
      low: number;
      close: number;
    }>,
    htfEma20: (number | null)[],
    fiveIdx: number,
    direction: 'BUY' | 'SELL',
  ):
    | 'RUNNER_EXIT_5M_EMA'
    | 'RUNNER_EXIT_5M_SWING'
    | 'RUNNER_EXIT_5M_REVERSAL'
    | null {
    if (fiveIdx < 3 || fiveIdx >= htfCandles.length) return null;
    const fc = htfCandles[fiveIdx];
    const prevFc = htfCandles[fiveIdx - 1];
    const ema = htfEma20[fiveIdx];

    if (direction === 'BUY') {
      // 1. Swing break: close below lowest low of previous 3 completed 5m candles
      const swingLow = Math.min(
        htfCandles[fiveIdx - 1].low,
        htfCandles[fiveIdx - 2].low,
        htfCandles[fiveIdx - 3].low,
      );
      if (fc.close < swingLow) return 'RUNNER_EXIT_5M_SWING';
      // 2. EMA failure: 5m close below EMA20
      if (ema != null && fc.close < ema) return 'RUNNER_EXIT_5M_EMA';
      // 3. Reversal: strong bearish 5m candle (body >60% range, close < prev close)
      const range = fc.high - fc.low;
      const body = Math.abs(fc.close - fc.open);
      if (
        range > 0 &&
        body / range > 0.6 &&
        fc.close < fc.open &&
        fc.close < prevFc.close
      )
        return 'RUNNER_EXIT_5M_REVERSAL';
    }

    if (direction === 'SELL') {
      // 1. Swing break: close above highest high of previous 3 completed 5m candles
      const swingHigh = Math.max(
        htfCandles[fiveIdx - 1].high,
        htfCandles[fiveIdx - 2].high,
        htfCandles[fiveIdx - 3].high,
      );
      if (fc.close > swingHigh) return 'RUNNER_EXIT_5M_SWING';
      // 2. EMA failure: 5m close above EMA20
      if (ema != null && fc.close > ema) return 'RUNNER_EXIT_5M_EMA';
      // 3. Reversal: strong bullish 5m candle (body >60% range, close > prev close)
      const range = fc.high - fc.low;
      const body = Math.abs(fc.close - fc.open);
      if (
        range > 0 &&
        body / range > 0.6 &&
        fc.close > fc.open &&
        fc.close > prevFc.close
      )
        return 'RUNNER_EXIT_5M_REVERSAL';
    }

    return null;
  }

  /** Per-setup runner trade management: partial exit, delayed BE move, max runner cap. */
  private getSetupTradeConfig(setupType: string): {
    partialAtR: number | null;
    partialPct: number;
    moveToBeAtR: number; // price level (in R) at which we move the SL
    lockedProfitR: number; // SL moves HERE (in R from entry), NOT to 0/entry
    maxTargetR: number;
  } {
    switch (setupType) {
      case 'TrendPullback':
        return {
          partialAtR: 1.0,
          partialPct: 0.5,
          moveToBeAtR: 1.2,
          lockedProfitR: 0.5,
          maxTargetR: 5.0,
        };
      case 'EmaRejection':
        return {
          partialAtR: 1.0,
          partialPct: 0.5,
          moveToBeAtR: 1.2,
          lockedProfitR: 0.5,
          maxTargetR: 5.0,
        };
      case 'LiquiditySweep':
        return {
          partialAtR: 1.0,
          partialPct: 0.5,
          moveToBeAtR: 1.3,
          lockedProfitR: 0.5,
          maxTargetR: 5.0,
        };
      case 'EmaBounce':
      case 'ShootingStar':
      case 'EmaBreakoutLong':
      case 'EmaBreakoutShort':
        // Reversal/breakout setups: take half off quickly, lock in 0.5R on runner
        // Worst case after partial: 50%×1R + 50%×0.5R = +0.75R (vs old +0.25R)
        return {
          partialAtR: 1.0,
          partialPct: 0.5,
          moveToBeAtR: 1.2,
          lockedProfitR: 0.5,
          maxTargetR: 3.0,
        };
      case 'MomentumLong':
      case 'MomentumShort':
        // Momentum runs further — take 40% early, lock runner at +0.5R
        // Worst case after partial: 40%×1R + 60%×0.5R = +0.70R (vs old +0.25R)
        return {
          partialAtR: 1.0,
          partialPct: 0.4,
          moveToBeAtR: 1.5,
          lockedProfitR: 0.5,
          maxTargetR: 5.0,
        };
      case 'ISV200_PivotLow':
      case 'ISV200_PivotHigh':
        return {
          partialAtR: 1.0,
          partialPct: 0.5,
          moveToBeAtR: 1.2,
          lockedProfitR: 0.5,
          maxTargetR: 2.0,
        };
      case 'ISV200_BullDiv':
      case 'ISV200_BearDiv':
        return {
          partialAtR: 1.0,
          partialPct: 0.5,
          moveToBeAtR: 1.2,
          lockedProfitR: 0.5,
          maxTargetR: 3.0,
        };
      case 'LiquidityTrail':
        // Fixed SL at trail — no break-even movement, no partial, full exit at 5R.
        return {
          partialAtR: null,
          partialPct: 0,
          moveToBeAtR: 9999,
          lockedProfitR: 0,
          maxTargetR: 5.0,
        };
      case 'TripleSync':
        // Trend-following: minRRR=1.5 so first target is 1.5R.
        // Take half off at 1.5R, move SL to BE (0R), let runner go to 3R (target3).
        return {
          partialAtR: 1.5,
          partialPct: 0.5,
          moveToBeAtR: 1.5,
          lockedProfitR: 0,   // SL moves to exact entry (break-even)
          maxTargetR: 3.0,
        };
      default:
        return {
          partialAtR: 1.0,
          partialPct: 0.5,
          moveToBeAtR: 1.2,
          lockedProfitR: 0.5,
          maxTargetR: 5.0,
        };
    }
  }

  /**
   * Scan candles and return buy/sell signals based on the selected strategy.
   * Each signal is forward-simulated to determine SL/Target outcome and P&L.
   * Strategies: EMA_CROSS | RSI | SUPERTREND | EMA_RSI | SCALPING | LIQUIDITY_TRAIL
   */
  async findTradeSignals(
    symbol: string,
    interval: string,
    fromDate: string,
    toDate: string,
    strategy: string,
  ): Promise<
    Array<{
      time: string;
      type: 'BUY' | 'SELL';
      price: number;
      reason: string;
      open: number;
      high: number;
      low: number;
      close: number;
      stopLoss: number;
      target1R: number;
      target: number;
      outcome:
        | 'FULL_SL'
        | 'BE'
        | 'PARTIAL_BE'
        | 'RUNNER_EXIT_5M_EMA'
        | 'RUNNER_EXIT_5M_SWING'
        | 'RUNNER_EXIT_5M_REVERSAL'
        | 'MAX_TARGET_HIT'
        | 'OPEN';
      exitPrice: number | null;
      exitTime: string | null;
      partialExitPrice: number | null;
      pnlPoints: number | null;
      pnlPct: number | null;
      setupType: string | undefined;
    }>
  > {
    // SCALPING always uses 1m entry candles; HTF bias is built by grouping 1m → 5m internally
    // ANALYZE_DATA / PATTERN_SIGNAL / ISV_200 always use 5m as primary timeframe (1m fetched separately)
    const resolution =
      strategy === 'SCALPING'
        ? '1m'
        : strategy === 'ANALYZE_DATA' ||
            strategy === 'PATTERN_SIGNAL' ||
            strategy === 'ISV_200' ||
            strategy === 'TRIPLE_SYNC'
          ? '5m'
          : this.toDeltaResolution(interval);
    // Use IST (UTC+05:30) so the user's selected calendar date maps to the correct local day
    const startTs = Math.floor(
      new Date(fromDate + 'T00:00:00+05:30').getTime() / 1000,
    );
    const endTs = Math.floor(
      new Date(toDate + 'T23:59:59+05:30').getTime() / 1000,
    );

    // TRIPLE_SYNC needs 200+ candles for EMA warm-up. Pre-fetch extra history
    // before the user's selected start date so signals fire on day 1 of any range.
    const TRIPLE_SYNC_WARMUP = 210; // candles (each 5 min → ~17.5 h of history)
    let warmupOffset = 0; // number of prepended candles (used to filter signals later)
    let allCandles = await this.fetchCandlesRange(
      symbol,
      resolution,
      startTs,
      endTs,
    );
    if (strategy === 'TRIPLE_SYNC') {
      const warmupStart = startTs - TRIPLE_SYNC_WARMUP * 5 * 60;
      const warmupCandles = await this.fetchCandlesRange(
        symbol,
        resolution,
        warmupStart,
        startTs - 1,
      );
      warmupOffset = warmupCandles.length;
      allCandles = [...warmupCandles, ...allCandles];
    }
    const candles = allCandles;
    if (candles.length < 30) return [];

    const closes = candles.map((c) => c.close);

    // Internal raw signals with candle index for simulation
    type RawSignal = {
      candleIdx: number;
      type: 'BUY' | 'SELL';
      setupType?: string;
      slRef?: number; // setup-specific SL price reference
      atrAtSignal?: number; // ATR at signal candle for buffer
      ema20AtSignal?: number | null; // EMA20 at signal candle for stretch check
      exitAtCandleIdx?: number; // forced exit when next signal fires (e.g. LiquidityTrail)
      reason: string;
    };
    const raw: RawSignal[] = [];

    // ── Candle scan log ────────────────────────────────────────────────────────
    const scanLog = new ScanLogger(symbol, strategy);

    if (strategy === 'EMA_CROSS' || strategy === 'EMA_RSI') {
      const ema9 = this.calcEMA(closes, 9);
      const ema21 = this.calcEMA(closes, 21);
      const rsi = strategy === 'EMA_RSI' ? this.calcRSI(closes, 14) : null;

      for (let i = 22; i < candles.length; i++) {
        const e9 = ema9[i],
          e9p = ema9[i - 1];
        const e21 = ema21[i],
          e21p = ema21[i - 1];

        let signalFired: string | null = null;
        const checks: Record<string, string> = {};

        if (e9 == null || e9p == null || e21 == null || e21p == null) {
          checks['indicators'] = 'SKIP – EMA values not yet ready';
        } else {
          const crossUp = e9p <= e21p && e9 > e21;
          const crossDown = e9p >= e21p && e9 < e21;
          checks['ema9_vs_ema21'] =
            `EMA9=${e9.toFixed(4)} EMA21=${e21.toFixed(4)} crossUp=${crossUp} crossDown=${crossDown}`;

          if (strategy === 'EMA_RSI') {
            const r = rsi ? rsi[i] : null;
            checks['rsi_filter'] =
              r != null ? `RSI=${r.toFixed(2)}` : 'SKIP – RSI null';
            if (crossUp && r != null && r > 40) {
              const reason = `EMA9 crossed above EMA21 (RSI ${r.toFixed(1)})`;
              raw.push({ candleIdx: i, type: 'BUY', reason });
              signalFired = `BUY – ${reason}`;
            } else if (crossDown && r != null && r < 60) {
              const reason = `EMA9 crossed below EMA21 (RSI ${r.toFixed(1)})`;
              raw.push({ candleIdx: i, type: 'SELL', reason });
              signalFired = `SELL – ${reason}`;
            }
          } else {
            if (crossUp) {
              const reason = `EMA9 (${e9.toFixed(2)}) crossed above EMA21 (${e21.toFixed(2)})`;
              raw.push({ candleIdx: i, type: 'BUY', reason });
              signalFired = `BUY – ${reason}`;
            } else if (crossDown) {
              const reason = `EMA9 (${e9.toFixed(2)}) crossed below EMA21 (${e21.toFixed(2)})`;
              raw.push({ candleIdx: i, type: 'SELL', reason });
              signalFired = `SELL – ${reason}`;
            }
          }
        }

        scanLog.logCandle({
          idx: i,
          time:
            candles[i].date
              .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
              .replace(' ', 'T') + '+05:30',
          open: candles[i].open,
          high: candles[i].high,
          low: candles[i].low,
          close: candles[i].close,
          ema9: ema9[i],
          ema21: ema21[i],
          rsi: rsi ? rsi[i] : null,
          checks,
          signal: signalFired,
        });
      }
    } else if (strategy === 'RSI') {
      const rsiArr = this.calcRSI(closes, 14);

      for (let i = 15; i < candles.length; i++) {
        const r = rsiArr[i],
          rp = rsiArr[i - 1];
        let signalFired: string | null = null;
        const checks: Record<string, string> = {};

        if (r == null || rp == null) {
          checks['rsi'] = 'SKIP – RSI values not ready';
        } else {
          checks['rsi'] = `RSI_prev=${rp.toFixed(2)} RSI_cur=${r.toFixed(2)}`;
          if (rp <= 30 && r > 30) {
            const reason = `RSI crossed above 30 (${r.toFixed(1)}) — oversold recovery`;
            raw.push({ candleIdx: i, type: 'BUY', reason });
            signalFired = `BUY – ${reason}`;
          } else if (rp >= 70 && r < 70) {
            const reason = `RSI crossed below 70 (${r.toFixed(1)}) — overbought reversal`;
            raw.push({ candleIdx: i, type: 'SELL', reason });
            signalFired = `SELL – ${reason}`;
          }
        }

        scanLog.logCandle({
          idx: i,
          time:
            candles[i].date
              .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
              .replace(' ', 'T') + '+05:30',
          open: candles[i].open,
          high: candles[i].high,
          low: candles[i].low,
          close: candles[i].close,
          rsi: r,
          checks,
          signal: signalFired,
        });
      }
    } else if (strategy === 'SUPERTREND') {
      const st = this.calcSuperTrend(candles, 10, 2);

      for (let i = 11; i < candles.length; i++) {
        const cur = st[i],
          prev = st[i - 1];
        let signalFired: string | null = null;
        const checks: Record<string, string> = {};

        if (!cur || !prev) {
          checks['supertrend'] = 'SKIP – SuperTrend values not ready';
        } else {
          checks['supertrend'] =
            `value=${cur.value.toFixed(4)} trend=${cur.trend} prev=${prev.trend}`;
          if (prev.trend === 'down' && cur.trend === 'up') {
            const reason = `SuperTrend flipped UP (support: ${cur.value.toFixed(2)})`;
            raw.push({ candleIdx: i, type: 'BUY', reason });
            signalFired = `BUY – ${reason}`;
          } else if (prev.trend === 'up' && cur.trend === 'down') {
            const reason = `SuperTrend flipped DOWN (resistance: ${cur.value.toFixed(2)})`;
            raw.push({ candleIdx: i, type: 'SELL', reason });
            signalFired = `SELL – ${reason}`;
          }
        }

        scanLog.logCandle({
          idx: i,
          time:
            candles[i].date
              .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
              .replace(' ', 'T') + '+05:30',
          open: candles[i].open,
          high: candles[i].high,
          low: candles[i].low,
          close: candles[i].close,
          checks,
          signal: signalFired,
        });
      }
    } else if (strategy === 'SCALPING') {
      this.runScalpingStrategy(candles, closes, raw, symbol, scanLog);
    } else if (strategy === 'PATTERN_SIGNAL') {
      // Fetch 1m for micro-confirmation; falls through to forward sim (not logging-only)
      const candles1m = await this.fetchCandlesRange(
        symbol,
        '1m',
        startTs,
        endTs,
      );
      this.runPatternSignalStrategy(
        candles,
        candles1m,
        closes,
        raw,
        symbol,
        scanLog,
      );
    } else if (strategy === 'ANALYZE_DATA') {
      // Fetch 1m candles for micro-analysis within each 5m candle
      const candles1m = await this.fetchCandlesRange(
        symbol,
        '1m',
        startTs,
        endTs,
      );
      this.runAnalyzeDataStrategy(candles, candles1m, scanLog, symbol);
    } else if (strategy === 'ISV_200') {
      this.runIsv200Strategy(candles, closes, raw, scanLog);
    } else if (strategy === 'LIQUIDITY_TRAIL') {
      const signals = detectLiquidityTrailSignals(candles, {});
      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];
        raw.push({
          candleIdx: sig.candleIndex,
          type: sig.signalType,
          setupType: 'LiquidityTrail',
          slRef: sig.stopLoss,
          atrAtSignal: 0, // trail already embeds ATR × mult — no extra buffer
          exitAtCandleIdx:
            i + 1 < signals.length ? signals[i + 1].candleIndex : undefined,
          reason: sig.reason,
        });
      }
    } else if (strategy === 'TRIPLE_SYNC') {
      const signals = detectTripleSyncSignals(candles, {
        tradeStartMins: 0,
        tradeEndMins: 1439,
        minCandleRange: 0,
      });
      for (const sig of signals) {
        // Skip signals that fired on the pre-fetched warm-up prefix
        if (sig.candleIndex < warmupOffset) continue;
        raw.push({
          candleIdx: sig.candleIndex,
          type: sig.signalType,
          setupType: 'TripleSync',
          slRef: sig.stopLoss,
          atrAtSignal: 0, // strategy already computed the exact SL — no extra ATR buffer
          reason: sig.reason,
        });
      }
    }

    // ANALYZE_DATA is logging-only — no forward trade simulation needed
    if (strategy === 'ANALYZE_DATA') {
      scanLog.logSummary(candles.length, 0);
      scanLog.close();
      this.logger.log(
        `[AnalyzeData] Analysis complete — ${symbol}: ${candles.length} 5m candles analyzed. Log: ${scanLog.logFilePath}`,
      );
      return [];
    }

    scanLog.logSummary(candles.length, raw.length);
    this.logger.log(
      `[TradeFind] Scan complete — ${symbol} ${strategy}: ${raw.length} signals. Log: ${scanLog.logFilePath}`,
    );

    // ── 5m HTF candles for SCALPING runner exit detection ──────────────────────
    const htfCandles5m =
      strategy === 'SCALPING'
        ? this.groupCandlesHTF(candles, 5)
        : ([] as typeof candles);
    const htfEma20_5m =
      strategy === 'SCALPING'
        ? this.calcEMA(
            htfCandles5m.map((c) => c.close),
            20,
          )
        : ([] as (number | null)[]);

    // ── Forward-simulate each signal ─────────────────────────────────────────────
    const simResults = raw.flatMap(
      ({
        candleIdx,
        type,
        reason,
        setupType,
        slRef,
        atrAtSignal,
        ema20AtSignal,
        exitAtCandleIdx,
      }) => {
        const signalCandle = candles[candleIdx];
        const c = signalCandle;

        // ── Stretched-entry guard (SCALPING TP + ER only) ─────────────────────
        let entry = signalCandle.close;
        let simStartIdx = candleIdx + 1;
        let entryMode: 'IMMEDIATE' | 'RETRACEMENT' = 'IMMEDIATE';

        if (
          (setupType === 'TrendPullback' || setupType === 'EmaRejection') &&
          ema20AtSignal != null &&
          atrAtSignal != null
        ) {
          const candleRange = signalCandle.high - signalCandle.low;
          const distFromEma =
            type === 'BUY'
              ? signalCandle.close - ema20AtSignal
              : ema20AtSignal - signalCandle.close;
          const stretched =
            distFromEma > atrAtSignal * 0.6 ||
            (candleRange > 0 && distFromEma > candleRange * 0.45);

          if (stretched) {
            // Limit entry: midpoint of signal candle (50% retrace toward EMA)
            const limitEntry = +(
              (signalCandle.open + signalCandle.close) /
              2
            ).toFixed(8);
            const FILL_WINDOW = 3;
            let filled = false;
            for (
              let w = candleIdx + 1;
              w <= candleIdx + FILL_WINDOW && w < candles.length;
              w++
            ) {
              const wc = candles[w];
              if (
                type === 'BUY' ? wc.low <= limitEntry : wc.high >= limitEntry
              ) {
                entry = limitEntry;
                simStartIdx = w; // simulation (SL / target checks) starts on fill candle
                entryMode = 'RETRACEMENT';
                filled = true;
                break;
              }
            }
            if (!filled) return []; // no fill within window → skip trade entirely
          }
        }

        let stopLoss: number;
        let risk: number;

        if (setupType && slRef != null) {
          // Setup-specific SL with 0.5× ATR buffer (falls back to 0.3% of price)
          const buf = atrAtSignal != null ? atrAtSignal * 0.5 : entry * 0.003;
          stopLoss = +(type === 'BUY' ? slRef - buf : slRef + buf).toFixed(8);
          risk = Math.abs(entry - stopLoss);
          if (!(risk > 0)) {
            stopLoss = +(type === 'BUY' ? entry * 0.99 : entry * 1.01).toFixed(
              8,
            );
            risk = Math.abs(entry - stopLoss);
          }
        } else {
          // Generic fallback for non-scalping strategies — swing extreme of last 3 candles
          const lookback = candles.slice(
            Math.max(0, candleIdx - 2),
            candleIdx + 1,
          );
          if (type === 'BUY') {
            const validLows = lookback
              .map((x) => x.low)
              .filter(
                (v): v is number =>
                  typeof v === 'number' && isFinite(v) && v > 0,
              );
            const swingLow =
              validLows.length > 0 ? Math.min(...validLows) : entry * 0.99;
            stopLoss = +(swingLow * 0.999).toFixed(8);
            risk = entry - stopLoss;
            if (!(risk > 0)) {
              stopLoss = +(entry * 0.99).toFixed(8);
              risk = entry - stopLoss;
            }
          } else {
            const validHighs = lookback
              .map((x) => x.high)
              .filter(
                (v): v is number =>
                  typeof v === 'number' && isFinite(v) && v > 0,
              );
            const swingHigh =
              validHighs.length > 0 ? Math.max(...validHighs) : entry * 1.01;
            stopLoss = +(swingHigh * 1.001).toFixed(8);
            risk = stopLoss - entry;
            if (!(risk > 0)) {
              stopLoss = +(entry * 1.01).toFixed(8);
              risk = stopLoss - entry;
            }
          }
        }

        const target1R = +(
          type === 'BUY' ? entry + risk : entry - risk
        ).toFixed(8);

        // Setup-specific runner management (partial, delayed BE, max cap)
        const cfg = setupType ? this.getSetupTradeConfig(setupType) : null;
        const partialLevel =
          cfg && cfg.partialAtR !== null && cfg.partialPct > 0
            ? +(
                type === 'BUY'
                  ? entry + risk * cfg.partialAtR
                  : entry - risk * cfg.partialAtR
              ).toFixed(8)
            : null;
        // BE moves to entry only after price reaches moveToBeAtR (delayed, separate from partial)
        const beLevel = cfg
          ? +(
              type === 'BUY'
                ? entry + risk * cfg.moveToBeAtR
                : entry - risk * cfg.moveToBeAtR
            ).toFixed(8)
          : null;
        // Non-scalping fallback: fixed 2R exit
        const legacyFinalTarget = +(
          type === 'BUY' ? entry + risk * 2 : entry - risk * 2
        ).toFixed(8);
        // Max runner cap (scalping: cfg.maxTargetR; non-scalping: 2R)
        const maxTargetLevel = cfg
          ? +(
              type === 'BUY'
                ? entry + risk * cfg.maxTargetR
                : entry - risk * cfg.maxTargetR
            ).toFixed(8)
          : legacyFinalTarget;

        let outcome:
          | 'FULL_SL'
          | 'BE'
          | 'PARTIAL_BE'
          | 'RUNNER_EXIT_5M_EMA'
          | 'RUNNER_EXIT_5M_SWING'
          | 'RUNNER_EXIT_5M_REVERSAL'
          | 'MAX_TARGET_HIT'
          | 'OPEN' = 'OPEN';
        let exitPrice: number | null = null;
        let exitTime: string | null = null;
        let partialExitPrice: number | null = null;
        let trailingSL = stopLoss;
        let beActivated = false;
        let runnerActive = false;
        let partialTaken = false;

        for (let j = simStartIdx; j < candles.length; j++) {
          const fc = candles[j];

          if (type === 'BUY') {
            // 1. Hard SL — always first, price-based, never delayed
            if (fc.low <= trailingSL) {
              outcome = partialTaken
                ? 'PARTIAL_BE'
                : beActivated
                  ? 'BE'
                  : 'FULL_SL';
              exitPrice = trailingSL;
              exitTime = fc.date.toISOString();
              break;
            }
            // 1.5. Direct max-target exit for no-partial setups (e.g. LiquidityTrail — SL never moves)
            if (cfg && cfg.partialAtR === null && fc.high >= maxTargetLevel) {
              outcome = 'MAX_TARGET_HIT';
              exitPrice = maxTargetLevel;
              exitTime = fc.date.toISOString();
              break;
            }
            // 1.6. Next-signal exit (LiquidityTrail: trail flipped — close at this candle's close)
            if (exitAtCandleIdx !== undefined && j >= exitAtCandleIdx) {
              outcome = 'RUNNER_EXIT_5M_REVERSAL';
              exitPrice = fc.close;
              exitTime = fc.date.toISOString();
              break;
            }
            // 2. Partial exit at partialAtR — activates runner but does NOT yet move BE
            if (
              !partialTaken &&
              partialLevel !== null &&
              fc.high >= partialLevel
            ) {
              partialTaken = true;
              partialExitPrice = partialLevel;
              if (!runnerActive) runnerActive = true;
            }
            // 3. Delayed SL lock — move SL to lockedProfitR above entry (NOT to zero/entry)
            if (cfg && !beActivated && beLevel !== null && fc.high >= beLevel) {
              beActivated = true;
              trailingSL = +(entry + risk * cfg.lockedProfitR).toFixed(8);
            }
            // 4. Non-scalping fallback: lock SL at entry (legacy)
            if (!cfg && !beActivated && fc.high >= target1R) {
              beActivated = true;
              trailingSL = entry;
            }
            // 5. Non-scalping fixed 2R target
            if (!cfg && fc.high >= legacyFinalTarget) {
              outcome = 'MAX_TARGET_HIT';
              exitPrice = legacyFinalTarget;
              exitTime = fc.date.toISOString();
              break;
            }
            // 6. Scalping max runner cap
            if (runnerActive && fc.high >= maxTargetLevel) {
              outcome = 'MAX_TARGET_HIT';
              exitPrice = maxTargetLevel;
              exitTime = fc.date.toISOString();
              break;
            }
            // 7. 5m close-based runner exit (checked on first 1m of a new 5m group)
            if (
              runnerActive &&
              j > 0 &&
              Math.floor(j / 5) > Math.floor((j - 1) / 5)
            ) {
              const fiveIdx = Math.floor((j - 1) / 5);
              if (fiveIdx >= 3 && fiveIdx < htfCandles5m.length) {
                const runnerExit = this.detect5mRunnerExit(
                  htfCandles5m,
                  htfEma20_5m,
                  fiveIdx,
                  'BUY',
                );
                if (runnerExit) {
                  outcome = runnerExit;
                  exitPrice = htfCandles5m[fiveIdx].close;
                  exitTime = candles[j - 1].date.toISOString();
                  break;
                }
              }
            }
          } else {
            // 1. Hard SL
            if (fc.high >= trailingSL) {
              outcome = partialTaken
                ? 'PARTIAL_BE'
                : beActivated
                  ? 'BE'
                  : 'FULL_SL';
              exitPrice = trailingSL;
              exitTime = fc.date.toISOString();
              break;
            }
            // 1.5. Direct max-target exit for no-partial setups (e.g. LiquidityTrail — SL never moves)
            if (cfg && cfg.partialAtR === null && fc.low <= maxTargetLevel) {
              outcome = 'MAX_TARGET_HIT';
              exitPrice = maxTargetLevel;
              exitTime = fc.date.toISOString();
              break;
            }
            // 1.6. Next-signal exit (LiquidityTrail: trail flipped — close at this candle's close)
            if (exitAtCandleIdx !== undefined && j >= exitAtCandleIdx) {
              outcome = 'RUNNER_EXIT_5M_REVERSAL';
              exitPrice = fc.close;
              exitTime = fc.date.toISOString();
              break;
            }
            // 2. Partial exit — activates runner but does NOT yet move BE
            if (
              !partialTaken &&
              partialLevel !== null &&
              fc.low <= partialLevel
            ) {
              partialTaken = true;
              partialExitPrice = partialLevel;
              if (!runnerActive) runnerActive = true;
            }
            // 3. Delayed SL lock — move SL to lockedProfitR below entry (NOT to zero/entry)
            if (cfg && !beActivated && beLevel !== null && fc.low <= beLevel) {
              beActivated = true;
              trailingSL = +(entry - risk * cfg.lockedProfitR).toFixed(8);
            }
            // 4. Non-scalping fallback: lock SL at entry (legacy)
            if (!cfg && !beActivated && fc.low <= target1R) {
              beActivated = true;
              trailingSL = entry;
            }
            // 5. Non-scalping fixed 2R target
            if (!cfg && fc.low <= legacyFinalTarget) {
              outcome = 'MAX_TARGET_HIT';
              exitPrice = legacyFinalTarget;
              exitTime = fc.date.toISOString();
              break;
            }
            // 6. Scalping max runner cap
            if (runnerActive && fc.low <= maxTargetLevel) {
              outcome = 'MAX_TARGET_HIT';
              exitPrice = maxTargetLevel;
              exitTime = fc.date.toISOString();
              break;
            }
            // 7. 5m close-based runner exit
            if (
              runnerActive &&
              j > 0 &&
              Math.floor(j / 5) > Math.floor((j - 1) / 5)
            ) {
              const fiveIdx = Math.floor((j - 1) / 5);
              if (fiveIdx >= 3 && fiveIdx < htfCandles5m.length) {
                const runnerExit = this.detect5mRunnerExit(
                  htfCandles5m,
                  htfEma20_5m,
                  fiveIdx,
                  'SELL',
                );
                if (runnerExit) {
                  outcome = runnerExit;
                  exitPrice = htfCandles5m[fiveIdx].close;
                  exitTime = candles[j - 1].date.toISOString();
                  break;
                }
              }
            }
          }
        }

        // P&L: blended if partial taken, straight otherwise
        let pnlPoints: number;
        const dir = type === 'BUY' ? 1 : -1;
        if (partialTaken && cfg && partialExitPrice !== null) {
          const remainderExit = exitPrice ?? candles[candles.length - 1].close;
          pnlPoints = +(
            dir * (partialExitPrice - entry) * cfg.partialPct +
            dir * (remainderExit - entry) * (1 - cfg.partialPct)
          ).toFixed(8);
        } else {
          const refPrice = exitPrice ?? candles[candles.length - 1].close;
          pnlPoints = +(dir * (refPrice - entry)).toFixed(8);
        }
        const pnlPct = +((pnlPoints / entry) * 100).toFixed(4);

        return [
          {
            time: c.date.toISOString(),
            type,
            price: entry,
            reason,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            stopLoss,
            target1R,
            target: maxTargetLevel,
            outcome,
            exitPrice,
            exitTime,
            partialExitPrice,
            pnlPoints,
            pnlPct,
            entryMode,
            setupType,
          },
        ];
      },
    );

    scanLog.close();

    // Write P&L summary to a standalone file (separate from ScanLogger fd)
    try {
      const n = simResults.length;
      if (n > 0) {
        const outcomeMap = new Map<string, number>();
        const setupMap = new Map<
          string,
          { w: number; l: number; o: number; pnl: number }
        >();
        let totalPnl = 0;
        let wins = 0;
        let losses = 0;
        let open = 0;
        for (const r of simResults) {
          outcomeMap.set(r.outcome, (outcomeMap.get(r.outcome) ?? 0) + 1);
          const stKey = r.setupType ?? 'Unknown';
          const sg = setupMap.get(stKey) ?? { w: 0, l: 0, o: 0, pnl: 0 };
          if (r.pnlPoints != null && r.pnlPoints > 0) {
            wins++;
            sg.w++;
          } else if (r.pnlPoints != null && r.pnlPoints < 0) {
            losses++;
            sg.l++;
          } else {
            open++;
            sg.o++;
          }
          if (r.pnlPoints != null) {
            totalPnl += r.pnlPoints;
            sg.pnl += r.pnlPoints;
          }
          setupMap.set(stKey, sg);
        }
        const sep = '='.repeat(72);
        const now =
          new Date()
            .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
            .replace(' ', 'T') + '+05:30';
        let out = `${sep}\nSIMULATION P&L SUMMARY  ${now}\n${sep}\n`;
        out += `Trades=${n}  Wins=${wins}  Losses=${losses}  Open=${open}\n`;
        out += `WinRate=${((wins / n) * 100).toFixed(1)}%  TotalPnL=${totalPnl.toFixed(4)}  AvgPnL=${(totalPnl / n).toFixed(4)}\n\nOutcomes:\n`;
        for (const [oc, cnt] of [...outcomeMap.entries()].sort())
          out += `  ${oc.padEnd(30)} ${cnt}\n`;
        out += '\nBy Setup:\n';
        for (const [st, sg] of [...setupMap.entries()].sort()) {
          const tot = sg.w + sg.l + sg.o;
          out += `  ${st.padEnd(18)} W=${sg.w} L=${sg.l} O=${sg.o}  WR=${tot > 0 ? ((sg.w / tot) * 100).toFixed(0) : 0}%  PnL=${sg.pnl.toFixed(4)}\n`;
        }
        out += `${sep}\n`;
        const summaryFile = require('path').join(
          'D:/Work/My-Work/trading/auto-trade/docs/deltaexchange',
          `pnl-summary-${symbol}-${strategy}.txt`,
        );
        require('fs').writeFileSync(summaryFile, out, 'utf8');
      }
    } catch {
      /* ignore */
    }

    return simResults;
  }

  // ─── Analyze the Data Strategy ──────────────────────────────────────────────

  /**
   * Classify a candle by its body/wick structure into a human-readable label.
   * Used by the ANALYZE_DATA strategy to describe candle formations.
   */
  private classifyCandleType(c: {
    open: number;
    high: number;
    low: number;
    close: number;
  }): string {
    const range = c.high - c.low;
    if (range === 0) return 'FLAT (No movement)';
    const body = Math.abs(c.close - c.open);
    const isGreen = c.close >= c.open;
    const bodyPct = (body / range) * 100;
    const upperWick = isGreen ? c.high - c.close : c.high - c.open;
    const lowerWick = isGreen ? c.open - c.low : c.close - c.low;
    const upperPct = (upperWick / range) * 100;
    const lowerPct = (lowerWick / range) * 100;

    if (bodyPct < 10) {
      if (upperPct > 40 && lowerPct > 40)
        return 'DOJI (High Wave — equal wicks, indecision)';
      if (upperPct > 50) return 'DOJI with LONG UPPER WICK (Bearish rejection)';
      if (lowerPct > 50) return 'DOJI with LONG LOWER WICK (Bullish rejection)';
      return 'DOJI (Indecision)';
    }

    if (isGreen) {
      if (bodyPct >= 70 && upperPct < 15 && lowerPct < 15)
        return 'FULL GREEN BODY (Strong Bullish — minimal wicks)';
      if (bodyPct >= 50 && lowerPct >= 35)
        return 'BULLISH HAMMER (Green body + long lower wick — demand below)';
      if (bodyPct >= 50 && upperPct >= 35)
        return 'GREEN with LONG UPPER WICK (Exhaustion/distribution attempt)';
      if (bodyPct >= 50) return 'GREEN SOLID (Moderate bullish)';
      if (lowerPct >= 50 && bodyPct < 30)
        return 'HAMMER (Long lower wick — strong demand zone tested)';
      if (upperPct >= 50 && bodyPct < 30)
        return 'INVERTED HAMMER / Bearish Shooting Star (Rejection above)';
      if (upperPct >= 30 && lowerPct >= 30)
        return 'GREEN SPINNING TOP (Small body, equal wicks — indecision)';
      return 'GREEN (Weak — small body)';
    } else {
      if (bodyPct >= 70 && upperPct < 15 && lowerPct < 15)
        return 'FULL RED BODY (Strong Bearish — minimal wicks)';
      if (bodyPct >= 50 && lowerPct >= 35)
        return 'RED with LONG LOWER WICK (Potential bullish reversal / demand below)';
      if (bodyPct >= 50 && upperPct >= 35)
        return 'SHOOTING STAR (Red body + long upper wick — supply above)';
      if (bodyPct >= 50) return 'RED SOLID (Moderate bearish)';
      if (lowerPct >= 50 && bodyPct < 30)
        return 'BEARISH HAMMER (Long lower wick, red — demand but bears in control)';
      if (upperPct >= 50 && bodyPct < 30)
        return 'SHOOTING STAR / BEARISH REVERSAL (Long upper wick — supply zone)';
      if (upperPct >= 30 && lowerPct >= 30)
        return 'RED SPINNING TOP (Small body, equal wicks — indecision)';
      return 'RED (Weak — small body)';
    }
  }

  // ─── ISV-200 Strategy ────────────────────────────────────────────────────────

  /**
   * ISV_200 strategy — Volume Depletion Divergence at Pivot Highs/Lows.
   *
   * Translated from the TradingView Pine Script "ISV-200 - PRO (Vol-Depletion Logic)".
   *
   * Signal logic:
   *  BUY  (Bullish Divergence): Pivot Low makes a LOWER LOW compared to the previous
   *       pivot low, BUT the Vol SMA(20) at that pivot is LOWER than at the previous
   *       pivot → selling pressure is depleting → potential reversal up.
   *
   *  SELL (Bearish Divergence): Pivot High makes a HIGHER HIGH compared to the previous
   *       pivot high, BUT the Vol SMA(20) at that pivot is LOWER than at the previous
   *       pivot → buying pressure is depleting → potential reversal down.
   *
   * Indicators used:
   *  - Bollinger Bands BB(200, 2) — basis (SMA200), upper, lower (context only)
   *  - Volume SMA(20)  — depletion check at each pivot
   *  - ATR(14)         — SL buffer sizing
   *  - Pivot High/Low  — lookback = 12 (same as Pine Script default)
   *
   * Entry  : Close of the pivot-confirmation candle (12 bars after pivot)
   * SL     : The pivot price minus/plus 0.5× ATR buffer
   * Config : Partial 50% @ 1R, delayed BE @ 1.2R (locks 0.5R), max 3R
   */
  /**
   * ISV-200 strategy — matches TradingView "ISV-200 PRO (Vol-Depletion Logic)".
   *
   * INDICATORS:
   *   - vol_ma_20  : SMA(volume, 20) — used for divergence quality check
   *   - ATR(14)    : Wilder RMA of True Range — used for SL buffer (slRef ± 0.5×ATR)
   *   - Pivot Low  : ta.pivotlow(low, 12, 12)  → BUY  (blue dot on chart)
   *   - Pivot High : ta.pivothigh(high, 12, 12) → SELL (red dot on chart)
   *
   * TIMESTAMP NOTE:
   *   Pine Script plots the dot at the pivot bar (offset=-lookback).
   *   We therefore record candleIdx = pivotIdx (the pivot bar), not the detection bar.
   *   This makes all signal timestamps match TradingView exactly.
   *
   * DIVERGENCE (quality upgrade only — not a gate):
   *   BullDiv  : lower low  + lower vol_ma_20 vs previous pivot low  → ISV200_BullDiv  (3R)
   *   BearDiv  : higher high + lower vol_ma_20 vs previous pivot high → ISV200_BearDiv (3R)
   *   Plain pivot → ISV200_PivotLow / ISV200_PivotHigh (2R)
   */
  private runIsv200Strategy(
    candles: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    closes: number[],
    raw: Array<{
      candleIdx: number;
      type: 'BUY' | 'SELL';
      setupType?: string;
      slRef?: number;
      atrAtSignal?: number;
      ema20AtSignal?: number | null;
      reason: string;
    }>,
    scanLog: ScanLogger,
  ): void {
    const n = candles.length;
    const PIVOT_LB = 12; // ta.pivotlow/ta.pivothigh leftBars = rightBars = 12
    const VOL_MA_PERIOD = 20; // vol_ma_20 = ta.sma(volume, 20)
    const ATR_PERIOD = 14; // ATR(14, RMA)

    // ── Indicators ────────────────────────────────────────────────────────────
    // BB200 is NOT used as a signal condition — display-only in Pine Script.
    // Skip it to avoid wasting 200-bar warmup (~17 hours of 5m candles).
    const volumes = candles.map((c) => c.volume);
    const volSma20 = this.calcSMA(volumes, VOL_MA_PERIOD);
    const atr14arr = this.calcATR(candles, ATR_PERIOD);

    // ── Pivot divergence state ─────────────────────────────────────────────────
    // Mirrors Pine Script's var float p1_low_val / p1_high_val etc.
    let p1LowVal: number | null = null;
    let p1LowVolMa: number | null = null;
    let p1HighVal: number | null = null;
    let p1HighVolMa: number | null = null;

    // Minimum bar index at which loop starts:
    //   pivotIdx = i - PIVOT_LB must have PIVOT_LB bars to its left → i >= 2*PIVOT_LB (=24)
    //   volSma20[pivotIdx] valid when pivotIdx >= VOL_MA_PERIOD-1 → i >= PIVOT_LB+VOL_MA_PERIOD-1 (=31)
    //   atr14arr[i] valid when i >= ATR_PERIOD-1 (=13)
    const startIdx = Math.max(
      2 * PIVOT_LB,
      PIVOT_LB + VOL_MA_PERIOD - 1,
      ATR_PERIOD - 1,
    );

    for (let i = startIdx; i < n; i++) {
      // pivotIdx is the actual pivot bar — TradingView shows the dot HERE (offset=-lookback)
      const pivotIdx = i - PIVOT_LB;
      const pivotCandle = candles[pivotIdx];

      const atr = atr14arr[i];
      const volMaAtPivot = volSma20[pivotIdx]; // = vol_ma_20[lookback] in Pine Script

      if (atr == null || volMaAtPivot == null) continue;

      const pivotTimeStr =
        pivotCandle.date
          .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
          .replace(' ', 'T') + '+05:30';

      // ── Pivot Low detection — ta.pivotlow(low, 12, 12) ──────────────────────
      // Every bar in [pivotIdx-12 .. pivotIdx-1] AND [pivotIdx+1 .. pivotIdx+12]
      // must have a strictly HIGHER low than the pivot bar.
      const pivotLowVal = pivotCandle.low;
      let isPivotLow = true;
      for (let k = pivotIdx - PIVOT_LB; k < pivotIdx && isPivotLow; k++) {
        if (candles[k].low <= pivotLowVal) isPivotLow = false;
      }
      for (let k = pivotIdx + 1; k <= i && isPivotLow; k++) {
        if (candles[k].low <= pivotLowVal) isPivotLow = false;
      }

      // ── Pivot High detection — ta.pivothigh(high, 12, 12) ───────────────────
      // Every bar in [pivotIdx-12 .. pivotIdx-1] AND [pivotIdx+1 .. pivotIdx+12]
      // must have a strictly LOWER high than the pivot bar.
      const pivotHighVal = pivotCandle.high;
      let isPivotHigh = true;
      for (let k = pivotIdx - PIVOT_LB; k < pivotIdx && isPivotHigh; k++) {
        if (candles[k].high >= pivotHighVal) isPivotHigh = false;
      }
      for (let k = pivotIdx + 1; k <= i && isPivotHigh; k++) {
        if (candles[k].high >= pivotHighVal) isPivotHigh = false;
      }

      const checks: Record<string, string> = {
        detectionBar: `${i}`,
        pivotIdx: `${pivotIdx}`,
        isPivotLow: `${isPivotLow}`,
        isPivotHigh: `${isPivotHigh}`,
        volMA20: `${volMaAtPivot.toFixed(0)}`,
        atr: `${atr.toFixed(4)}`,
      };
      let signalFired: string | null = null;

      // ── PIVOT LOW → BUY (every pivot low = signal; divergence upgrades to BullDiv)
      if (isPivotLow) {
        let setupType = 'ISV200_PivotLow';
        if (
          p1LowVal != null &&
          p1LowVolMa != null &&
          pivotLowVal < p1LowVal &&
          volMaAtPivot < p1LowVolMa
        ) {
          setupType = 'ISV200_BullDiv';
        }
        const reason =
          setupType === 'ISV200_BullDiv'
            ? `ISV-200 BullDiv: LL low=${pivotLowVal.toFixed(4)}<${p1LowVal!.toFixed(4)} volMA20=${volMaAtPivot.toFixed(0)}<${p1LowVolMa!.toFixed(0)}`
            : `ISV-200 PivotLow: low=${pivotLowVal.toFixed(4)} volMA20=${volMaAtPivot.toFixed(0)}`;
        raw.push({
          candleIdx: pivotIdx,
          type: 'BUY',
          setupType,
          slRef: pivotLowVal,
          atrAtSignal: atr,
          reason,
        });
        signalFired = `BUY – ${reason}`;
        p1LowVal = pivotLowVal;
        p1LowVolMa = volMaAtPivot;
      }

      // ── PIVOT HIGH → SELL (every pivot high = signal; divergence upgrades to BearDiv)
      if (isPivotHigh) {
        let setupType = 'ISV200_PivotHigh';
        if (
          p1HighVal != null &&
          p1HighVolMa != null &&
          pivotHighVal > p1HighVal &&
          volMaAtPivot < p1HighVolMa
        ) {
          setupType = 'ISV200_BearDiv';
        }
        const reason =
          setupType === 'ISV200_BearDiv'
            ? `ISV-200 BearDiv: HH high=${pivotHighVal.toFixed(4)}>${p1HighVal!.toFixed(4)} volMA20=${volMaAtPivot.toFixed(0)}<${p1HighVolMa!.toFixed(0)}`
            : `ISV-200 PivotHigh: high=${pivotHighVal.toFixed(4)} volMA20=${volMaAtPivot.toFixed(0)}`;
        raw.push({
          candleIdx: pivotIdx,
          type: 'SELL',
          setupType,
          slRef: pivotHighVal,
          atrAtSignal: atr,
          reason,
        });
        signalFired =
          (signalFired ? signalFired + ' | ' : '') + `SELL – ${reason}`;
        p1HighVal = pivotHighVal;
        p1HighVolMa = volMaAtPivot;
      }

      scanLog.logCandle({
        idx: pivotIdx,
        time: pivotTimeStr,
        open: pivotCandle.open,
        high: pivotCandle.high,
        low: pivotCandle.low,
        close: pivotCandle.close,
        volume: pivotCandle.volume,
        atr,
        checks,
        signal: signalFired,
      });
    }
  }

  /**
   * PATTERN_SIGNAL strategy — fires BUY/SELL signals based on the six
   * confirmed candle patterns derived from statistical analysis of SOLUSD
   * Jan-Feb and March 2026 data (16,992 + 6,775 5m candles):
   *
   *  1. EMA Bounce Long      — Hammer/Doji-lower + EMA touched + 1m bullish
   *  2. Shooting Star Short  — Shooting star/Doji-upper + near Swing High + 1m bearish
   *  3. Momentum Long        — Full/Solid green body + above rising EMA + 1m bullish
   *  4. Momentum Short       — Full/Solid red body  + below falling EMA + 1m bearish
   *  5. EMA Breakout Long    — 2+ prior candles below EMA coiling, first close above EMA
   *  6. EMA Breakout Short   — 2+ prior candles above EMA coiling, first close below EMA
   *
   * 1m data is used for confirmation when available; signals still fire on
   * 5m structure alone when 1m history has expired (older date ranges).
   * Signals enter the standard forward-simulation engine for P&L tracking.
   */
  private runPatternSignalStrategy(
    candles: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    candles1m: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    closes: number[],
    raw: Array<{
      candleIdx: number;
      type: 'BUY' | 'SELL';
      setupType?: any;
      slRef?: number;
      atrAtSignal?: number;
      ema20AtSignal?: number | null;
      reason: string;
    }>,
    symbol: string,
    scanLog: ScanLogger,
  ): void {
    const ema20arr = this.calcEMA(closes, 20);
    const atr14arr = this.calcATR(candles, 14);
    const SWING_LB = 20;

    // ── Per-setup cooldowns (5m candles) ─────────────────────────────────────
    // EmaBounce / ShootingStar: 30 candles = ~2.5 hours between same setup
    // MomentumLong / Short: 72 candles = ~6 hours (one strong trend per session)
    const COOLDOWN_REVERSAL = 30;
    const COOLDOWN_MOMENTUM = 72;
    const lastSignalIdx: Record<string, number> = {
      EmaBounce: -COOLDOWN_REVERSAL,
      ShootingStar: -COOLDOWN_REVERSAL,
      MomentumLong: -COOLDOWN_MOMENTUM,
      MomentumShort: -COOLDOWN_MOMENTUM,
      EmaBreakoutLong: -COOLDOWN_REVERSAL,
      EmaBreakoutShort: -COOLDOWN_REVERSAL,
    };

    for (let i = SWING_LB; i < candles.length; i++) {
      const c = candles[i];
      const ema20 = ema20arr[i];
      const atr = atr14arr[i];

      const timeStr =
        c.date
          .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
          .replace(' ', 'T') + '+05:30';

      if (ema20 == null || atr == null || atr <= 0) {
        scanLog.logCandle({
          idx: i,
          time: timeStr,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          ema20: ema20,
          atr,
          checks: { warmup: 'SKIP – indicators not ready' },
          signal: null,
        });
        continue;
      }

      // ── Candle structure ────────────────────────────────────────────────────
      const range = c.high - c.low;
      if (range === 0) continue;
      const body = Math.abs(c.close - c.open);
      const isGreen = c.close >= c.open;
      const upperWick = isGreen ? c.high - c.close : c.high - c.open;
      const lowerWick = isGreen ? c.open - c.low : c.close - c.low;
      const bodyPct = (body / range) * 100;
      const upperWickPct = (upperWick / range) * 100;
      const lowerWickPct = (lowerWick / range) * 100;
      const candleType = this.classifyCandleType(c);

      // ── EMA position & slope (measured over 10-candle window = 50m) ─────────
      const emaTouched = ema20 >= c.low && ema20 <= c.high;
      const aboveEma = c.close > ema20;
      const belowEma = c.close < ema20;
      const ema10ago = ema20arr[i - 10];
      const emaSlope =
        ema10ago != null ? ((ema20 - ema10ago) / ema10ago) * 100 : 0;
      // Momentum requires a strong trend (>0.30% over 50m); anything less = chop
      const emaRisingStrong = emaSlope > 0.3;
      const emaFallingStrong = emaSlope < -0.3;

      // ── Swing high/low over last SWING_LB candles ───────────────────────────
      const lookback = candles.slice(i - SWING_LB, i);
      const swingHigh = Math.max(...lookback.map((x) => x.high));
      const swingLow = Math.min(...lookback.map((x) => x.low));
      // Tightened thresholds: 0.3 ATR for shooting star/EMA bounce (was 0.5)
      const nearSwingHigh = swingHigh - c.close < atr * 0.3;
      const nearSwingLow = c.close - swingLow < atr * 0.5;

      // ── 1m micro-candles inside this 5m window ──────────────────────────────
      const winStart = c.date.getTime();
      const winEnd = winStart + 5 * 60 * 1000;
      const micro = candles1m.filter(
        (m) => m.date.getTime() >= winStart && m.date.getTime() < winEnd,
      );
      const greenCount1m = micro.filter((m) => m.close >= m.open).length;
      const redCount1m = micro.length - greenCount1m;
      const has1m = micro.length >= 4; // need at least 4 of 5 micro-candles
      const bias1m = has1m
        ? greenCount1m > redCount1m
          ? 'BULLISH'
          : 'BEARISH'
        : 'UNKNOWN';
      // Strong 1m alignment: 4+ of 5 candles in same direction
      const strong1mBull = has1m && greenCount1m >= 4;
      const strong1mBear = has1m && redCount1m >= 4;

      // Closing reversal: last 1m strong counter-candle ≥60% body
      let closingReversal = false;
      if (micro.length > 0) {
        const last = micro[micro.length - 1];
        const lr = last.high - last.low;
        const lb = Math.abs(last.close - last.open);
        const lastIsGreen = last.close >= last.open;
        if (lr > 0 && (lb / lr) * 100 >= 60) {
          if ((isGreen && !lastIsGreen) || (!isGreen && lastIsGreen))
            closingReversal = true;
        }
      }

      // ── Strict candle type matching ─────────────────────────────────────────
      // EMA Bounce: only genuine hammer types, NOT weak/bearish control candles
      const isGenuineHammer =
        candleType.startsWith('HAMMER') ||
        candleType.startsWith('BULLISH HAMMER') ||
        candleType.startsWith('DOJI with LONG LOWER WICK');
      // Shooting Star: only genuine reversal top candles
      const isGenuineShootingStar =
        candleType.startsWith('SHOOTING STAR') ||
        candleType.startsWith('DOJI with LONG UPPER WICK') ||
        candleType.startsWith('INVERTED HAMMER');
      // Momentum: full-body only (≥70%) — solid bodies no longer qualify (too many false)
      const isFullGreen = isGreen && bodyPct >= 70;
      const isFullRed = !isGreen && bodyPct >= 70;

      // ── EMA Bounce quality gate ──────────────────────────────────────────────
      // True EMA bounce: candle low dipped to/through EMA AND closed back above it
      // This prevents EMA touches where price never actually tested EMA as support
      const emaBouncedFromBelow = ema20 >= c.low && c.close > ema20;
      // Lower wick must be meaningful in absolute terms (not just % of tiny doji)
      const lowerWickAbsMin = lowerWick >= atr * 0.3;

      // ── Diagnostics ──────────────────────────────────────────────────────────
      const checks: Record<string, string> = {};
      checks['ema20'] =
        `EMA20=${ema20.toFixed(4)} aboveEma=${aboveEma} touched=${emaTouched} slope=${emaSlope.toFixed(3)}%`;
      checks['candle'] =
        `body=${bodyPct.toFixed(1)}% upper=${upperWickPct.toFixed(1)}% lower=${lowerWickPct.toFixed(1)}% | ${candleType}`;
      checks['levels'] =
        `swingH=${swingHigh.toFixed(4)} swingL=${swingLow.toFixed(4)} nearSH=${nearSwingHigh} nearSL=${nearSwingLow} ATR=${atr.toFixed(4)}`;
      checks['1m'] =
        `candles=${micro.length} G=${greenCount1m} R=${redCount1m} bias=${bias1m} strongBull=${strong1mBull} strongBear=${strong1mBear} closingRev=${closingReversal}`;

      // ── EMA Coil detection — used by EmaBreakout signals ──────────────────
      // Count consecutive prior candles on the same side of EMA + how many
      // of those had EMA touched (the "coiling at EMA" signature).
      const COIL_MAX = 6;
      let coilAboveCount = 0; // consecutive prior closes > EMA  (SHORT setup)
      let coilBelowCount = 0; // consecutive prior closes < EMA  (LONG setup)
      let coilAboveTouches = 0; // EMA touches during coil-above period
      let coilBelowTouches = 0; // EMA touches during coil-below period
      for (let j = i - 1; j >= Math.max(i - COIL_MAX, SWING_LB); j--) {
        const pc = candles[j];
        const pEma = ema20arr[j];
        if (pEma == null) break;
        const pTouch = pEma >= pc.low && pEma <= pc.high;
        if (pc.close > pEma) {
          if (coilBelowCount > 0) break; // mixed sequence — stop
          coilAboveCount++;
          if (pTouch) coilAboveTouches++;
        } else if (pc.close < pEma) {
          if (coilAboveCount > 0) break; // mixed sequence — stop
          coilBelowCount++;
          if (pTouch) coilBelowTouches++;
        }
        // pc.close === pEma: ambiguous — don't break, don't count
      }
      checks['emaCoil'] =
        `coilAbove=${coilAboveCount}(T=${coilAboveTouches}) coilBelow=${coilBelowCount}(T=${coilBelowTouches})`;

      let signalFired: string | null = null;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SIGNAL 1 — EMA BOUNCE LONG
      // Genuine hammer + candle LOW dipped to/through EMA AND closed above it
      // + lower wick ≥ 50% of range (dominant rejection wick)
      // + lower wick ≥ 0.3 ATR (meaningful size)
      // + EMA must be rising (slope > 0) — only long WITH the trend, not counter
      // + 1m BULLISH bias (3+/5 green micro-candles)
      // SL: below THIS CANDLE'S LOW (tight — candle low already tested EMA as support)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (
        i - lastSignalIdx['EmaBounce'] >= COOLDOWN_REVERSAL &&
        isGenuineHammer &&
        emaBouncedFromBelow &&
        lowerWickPct >= 50 &&
        lowerWickAbsMin &&
        emaSlope > 0 &&
        !closingReversal &&
        bias1m === 'BULLISH'
      ) {
        const reason = `EMA Bounce Long — ${candleType} | EMA20 touched | 1m bias: ${bias1m}`;
        raw.push({
          candleIdx: i,
          type: 'BUY',
          setupType: 'EmaBounce',
          slRef: c.low, // tight SL at candle low, not 20-bar swing
          atrAtSignal: atr,
          ema20AtSignal: ema20,
          reason,
        });
        signalFired = `BUY – ${reason}`;
        lastSignalIdx['EmaBounce'] = i;
        checks['signal'] = '▲ FIRED: EMA_BOUNCE_LONG';
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SIGNAL 2 — SHOOTING STAR SHORT
      // Genuine shooting star/inverted hammer + near swing high (0.3 ATR)
      // 1m must be BEARISH (strict — UNKNOWN no longer qualifies)
      // SL: above THIS CANDLE'S HIGH (tight — candle high already rejected at resistance)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (
        signalFired === null &&
        i - lastSignalIdx['ShootingStar'] >= COOLDOWN_REVERSAL &&
        isGenuineShootingStar &&
        nearSwingHigh &&
        bias1m === 'BEARISH'
      ) {
        const reason =
          `Shooting Star Short — ${candleType} | Near Swing High` +
          (closingReversal ? ' + Closing Reversal' : '') +
          ` | 1m bias: ${bias1m}`;
        raw.push({
          candleIdx: i,
          type: 'SELL',
          setupType: 'ShootingStar',
          slRef: c.high, // tight SL at candle high, not 20-bar swing
          atrAtSignal: atr,
          ema20AtSignal: ema20,
          reason,
        });
        signalFired = `SELL – ${reason}`;
        lastSignalIdx['ShootingStar'] = i;
        checks['signal'] = '▼ FIRED: SHOOTING_STAR_SHORT';
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SIGNAL 3 — MOMENTUM LONG
      // Full body green (≥70%) + strong rising EMA (>0.25% over 50m) + above EMA
      // + body >= 0.5 ATR (meaningful move, not noise) + NOT near resistance
      // + 1m STRONGLY bullish (4+/5 — strict, UNKNOWN no longer qualifies)
      // SL: below this candle's low
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (
        signalFired === null &&
        i - lastSignalIdx['MomentumLong'] >= COOLDOWN_MOMENTUM &&
        isFullGreen &&
        body >= atr * 0.5 &&
        aboveEma &&
        emaRisingStrong &&
        !nearSwingHigh &&
        strong1mBull
      ) {
        const reason = `Momentum Long — ${candleType} | Above EMA (rising ${emaSlope.toFixed(2)}%) | 1m: ${bias1m}`;
        raw.push({
          candleIdx: i,
          type: 'BUY',
          setupType: 'MomentumLong',
          slRef: c.low,
          atrAtSignal: atr,
          ema20AtSignal: ema20,
          reason,
        });
        signalFired = `BUY – ${reason}`;
        lastSignalIdx['MomentumLong'] = i;
        checks['signal'] = '▲ FIRED: MOMENTUM_LONG';
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SIGNAL 4 — MOMENTUM SHORT
      // Full body red (≥70%) + strong falling EMA (<-0.25% over 50m) + below EMA
      // + body >= 0.5 ATR (meaningful move, not noise) + NOT near support
      // + 1m STRONGLY bearish (4+/5 — strict, UNKNOWN no longer qualifies)
      // SL: above this candle's high
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (
        signalFired === null &&
        i - lastSignalIdx['MomentumShort'] >= COOLDOWN_MOMENTUM &&
        isFullRed &&
        body >= atr * 0.5 &&
        belowEma &&
        emaFallingStrong &&
        !nearSwingLow &&
        strong1mBear
      ) {
        const reason = `Momentum Short — ${candleType} | Below EMA (falling ${Math.abs(emaSlope).toFixed(2)}%) | 1m: ${bias1m}`;
        raw.push({
          candleIdx: i,
          type: 'SELL',
          setupType: 'MomentumShort',
          slRef: c.high,
          atrAtSignal: atr,
          ema20AtSignal: ema20,
          reason,
        });
        signalFired = `SELL – ${reason}`;
        lastSignalIdx['MomentumShort'] = i;
        checks['signal'] = '▼ FIRED: MOMENTUM_SHORT';
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SIGNAL 5 — EMA BREAKOUT LONG
      // Price coiled BELOW EMA (≥3 consecutive prior closes < EMA, ≥2 EMA touches)
      // Signal candle: EMA touched + FIRST close ABOVE EMA
      // + candle is GREEN with body ≥ 50% (directional, not doji/spinning top)
      // + 1m BULLISH bias (soft: 3+/5 green) — confirms direction
      // + no closing reversal (last 1m candle is not a strong counter red)
      // SL: below this candle's low
      // Observed: 22-Mar 07:30 (4 candles coiling below, 1m 5G/0R, green breakout)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (
        signalFired === null &&
        i - lastSignalIdx['EmaBreakoutLong'] >= COOLDOWN_REVERSAL &&
        coilBelowCount >= 4 &&
        coilBelowTouches >= 2 &&
        emaTouched &&
        aboveEma &&
        isGreen &&
        bodyPct >= 65 &&
        !closingReversal &&
        strong1mBull
      ) {
        const reason = `EMA Breakout Long — ${coilBelowCount} candles below EMA (${coilBelowTouches} touches) | ${candleType} | 1m: ${bias1m}`;
        raw.push({
          candleIdx: i,
          type: 'BUY',
          setupType: 'EmaBreakoutLong',
          slRef: c.low,
          atrAtSignal: atr,
          ema20AtSignal: ema20,
          reason,
        });
        signalFired = `BUY – ${reason}`;
        lastSignalIdx['EmaBreakoutLong'] = i;
        checks['signal'] = '▲ FIRED: EMA_BREAKOUT_LONG';
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SIGNAL 6 — EMA BREAKOUT SHORT
      // Price coiled ABOVE EMA (≥3 consecutive prior closes > EMA, ≥2 EMA touches)
      // Signal candle: EMA touched + FIRST close BELOW EMA
      // + candle is RED with body ≥ 50% (directional, not doji/spinning top)
      // + 1m BEARISH bias (soft: 3+/5 red) — confirms direction
      // + no closing reversal (last 1m candle is not a strong counter green)
      // SL: above this candle's high
      // Observed: 19-Mar 16:05, 17:00 / 20-Mar 14:30 / 22-Mar 10:40
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (
        signalFired === null &&
        i - lastSignalIdx['EmaBreakoutShort'] >= COOLDOWN_REVERSAL &&
        coilAboveCount >= 4 &&
        coilAboveTouches >= 2 &&
        emaTouched &&
        belowEma &&
        !isGreen &&
        bodyPct >= 65 &&
        !closingReversal &&
        strong1mBear
      ) {
        const reason = `EMA Breakout Short — ${coilAboveCount} candles above EMA (${coilAboveTouches} touches) | ${candleType} | 1m: ${bias1m}`;
        raw.push({
          candleIdx: i,
          type: 'SELL',
          setupType: 'EmaBreakoutShort',
          slRef: c.high,
          atrAtSignal: atr,
          ema20AtSignal: ema20,
          reason,
        });
        signalFired = `SELL – ${reason}`;
        lastSignalIdx['EmaBreakoutShort'] = i;
        checks['signal'] = '▼ FIRED: EMA_BREAKOUT_SHORT';
      }

      scanLog.logCandle({
        idx: i,
        time: timeStr,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        ema20: ema20arr[i],
        atr,
        checks,
        signal: signalFired,
      });
    }
  }

  /**
   * ANALYZE_DATA strategy — logs comprehensive candle-by-candle data for each
   * 5m candle: body/wick classification, EMA20 position, key levels (Day H/L,
   * Prev Day H/L, Swing H/L), ATR, and a full 1m candle breakdown showing
   * pullbacks and reversals inside each 5m candle range.
   *
   * No trade signals are generated — this is a pure data-collection strategy.
   */
  private runAnalyzeDataStrategy(
    candles5m: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    candles1m: Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
    scanLog: ScanLogger,
    symbol: string,
  ): void {
    const closes5m = candles5m.map((c) => c.close);
    const ema20_5m = this.calcEMA(closes5m, 20);
    const atr14_5m = this.calcATR(candles5m, 14);

    // ── Pre-build per-calendar-day high/low (IST) from the full 5m dataset ──
    const dayBuckets = new Map<string, { high: number; low: number }>();
    for (const c of candles5m) {
      const dayStr = c.date
        .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
        .slice(0, 10);
      const existing = dayBuckets.get(dayStr);
      if (!existing) {
        dayBuckets.set(dayStr, { high: c.high, low: c.low });
      } else {
        existing.high = Math.max(existing.high, c.high);
        existing.low = Math.min(existing.low, c.low);
      }
    }
    const sortedDays = [...dayBuckets.keys()].sort();

    // ── Pre-compute per-index: dayStr + rolling day H/L in a single O(n) pass ──
    // This avoids an O(n²) nested loop and repeated toLocaleString calls.
    const candleDayStr: string[] = [];
    const rollingDayHL: Array<{ high: number; low: number }> = [];
    {
      let curDay = '';
      let curHigh = 0;
      let curLow = Infinity;
      for (let k = 0; k < candles5m.length; k++) {
        const d = candles5m[k].date
          .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
          .slice(0, 10);
        candleDayStr.push(d);
        if (d !== curDay) {
          curDay = d;
          curHigh = candles5m[k].high;
          curLow = candles5m[k].low;
        } else {
          curHigh = Math.max(curHigh, candles5m[k].high);
          curLow = Math.min(curLow, candles5m[k].low);
        }
        rollingDayHL.push({ high: curHigh, low: curLow });
      }
    }
    // O(1) day-index lookup to avoid sortedDays.indexOf() O(n) per iteration
    const dayStrIndexMap = new Map<string, number>(
      sortedDays.map((d, idx) => [d, idx]),
    );

    const SWING_LOOKBACK = 20; // candles to look back for swing H/L

    scanLog.writeRaw(
      `\n${'━'.repeat(80)}\n` +
        `  ANALYZE THE DATA — ${symbol}  |  5m primary | 1m micro breakdown\n` +
        `  Total 5m candles: ${candles5m.length}  |  Total 1m candles: ${candles1m.length}\n` +
        `${'━'.repeat(80)}\n`,
    );

    for (let i = SWING_LOOKBACK; i < candles5m.length; i++) {
      const c5 = candles5m[i];
      const ema20 = ema20_5m[i];
      const atr = atr14_5m[i];

      const timeStr =
        c5.date
          .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
          .replace(' ', 'T') + '+05:30';
      const dayStr = candleDayStr[i];

      // ── Candle structure ────────────────────────────────────────────────────
      const range = c5.high - c5.low;
      const body = Math.abs(c5.close - c5.open);
      const isGreen = c5.close >= c5.open;
      const upperWick = isGreen ? c5.high - c5.close : c5.high - c5.open;
      const lowerWick = isGreen ? c5.open - c5.low : c5.close - c5.low;
      const bodyPct = range > 0 ? (body / range) * 100 : 0;
      const upperWickPct = range > 0 ? (upperWick / range) * 100 : 0;
      const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;
      const midPoint = (c5.high + c5.low) / 2;
      const candleType = this.classifyCandleType(c5);

      // ── EMA20 position ──────────────────────────────────────────────────────
      let emaLine = 'EMA20=N/A (warming up)';
      let emaRelation = '';
      if (ema20 != null) {
        const dist = c5.close - ema20;
        const distPct = (dist / ema20) * 100;
        emaRelation =
          dist > 0
            ? `ABOVE EMA20 by ${dist.toFixed(4)} pts (${distPct.toFixed(3)}%)`
            : `BELOW EMA20 by ${Math.abs(dist).toFixed(4)} pts (${Math.abs(distPct).toFixed(3)}%)`;
        const wickToEma = isGreen
          ? c5.low - ema20 // positive = low is above EMA (no touch)
          : ema20 - c5.high; // positive = high is below EMA (no touch)
        const emaTouched = wickToEma <= 0;
        emaLine = `EMA20=${ema20.toFixed(4)} | Close: ${emaRelation} | EMA Touched this candle: ${emaTouched ? 'YES ⚡' : 'NO'}`;
      }

      // ── Rolling Day High/Low (candles up to this one in same day) — O(1) ───
      const { high: dayHigh, low: dayLow } = rollingDayHL[i];
      const nearDayHigh = Math.abs(c5.close - dayHigh) < (atr ?? range) * 0.5;
      const nearDayLow = Math.abs(c5.close - dayLow) < (atr ?? range) * 0.5;

      // ── Previous Day High/Low ───────────────────────────────────────────────
      const dayIdx = dayStrIndexMap.get(dayStr) ?? -1;
      let prevDayHigh: number | null = null;
      let prevDayLow: number | null = null;
      if (dayIdx > 0) {
        const pd = dayBuckets.get(sortedDays[dayIdx - 1]);
        if (pd) {
          prevDayHigh = pd.high;
          prevDayLow = pd.low;
        }
      }

      // ── Swing High/Low (last SWING_LOOKBACK 5m candles) ────────────────────
      const lookbackSlice = candles5m.slice(
        Math.max(0, i - SWING_LOOKBACK + 1),
        i + 1,
      );
      const swingHigh = Math.max(...lookbackSlice.map((c) => c.high));
      const swingLow = Math.min(...lookbackSlice.map((c) => c.low));
      const nearSwingHigh =
        Math.abs(c5.close - swingHigh) < (atr ?? range) * 0.5;
      const nearSwingLow = Math.abs(c5.close - swingLow) < (atr ?? range) * 0.5;

      // ── 1m candles inside this 5m window ───────────────────────────────────
      const fiveStart = c5.date.getTime();
      const fiveEnd = fiveStart + 5 * 60 * 1000;
      const inside1m = candles1m.filter((c) => {
        const t = c.date.getTime();
        return t >= fiveStart && t < fiveEnd;
      });

      // ── Build the log entry ─────────────────────────────────────────────────
      const sep = '─'.repeat(80);
      let log =
        `\n${sep}\n` +
        `[${i.toString().padStart(4, '0')}] ${timeStr}\n` +
        `\n` +
        `5m CANDLE  O=${c5.open}  H=${c5.high}  L=${c5.low}  C=${c5.close}  V=${c5.volume.toFixed(2)}\n` +
        `  Direction:    ${isGreen ? '▲ GREEN (Bullish)' : c5.close < c5.open ? '▼ RED  (Bearish)' : '◆ DOJI (Neutral)'}\n` +
        `  Body:         ${body.toFixed(4)} pts  |  Range: ${range.toFixed(4)} pts  |  Body%: ${bodyPct.toFixed(1)}%\n` +
        `  Upper Wick:   ${upperWick.toFixed(4)} pts (${upperWickPct.toFixed(1)}% of range)\n` +
        `  Lower Wick:   ${lowerWick.toFixed(4)} pts (${lowerWickPct.toFixed(1)}% of range)\n` +
        `  Mid-Point:    ${midPoint.toFixed(4)}\n` +
        `  ATR14(5m):    ${atr != null ? atr.toFixed(4) : 'N/A'}\n` +
        `  Candle Type:  ${candleType}\n` +
        `\n` +
        `EMA20 ANALYSIS:\n` +
        `  ${emaLine}\n` +
        `\n` +
        `KEY LEVELS:\n` +
        `  Day High:       ${dayHigh.toFixed(4)}  →  Close ${c5.close < dayHigh ? `${(dayHigh - c5.close).toFixed(4)} pts BELOW` : 'AT/ABOVE'} Day High${nearDayHigh ? '  ⚠ NEAR DAY HIGH' : ''}\n` +
        `  Day Low:        ${dayLow.toFixed(4)}  →  Close ${c5.close > dayLow ? `${(c5.close - dayLow).toFixed(4)} pts ABOVE` : 'AT/BELOW'} Day Low${nearDayLow ? '  ⚠ NEAR DAY LOW' : ''}\n` +
        `  Prev Day High:  ${prevDayHigh != null ? `${prevDayHigh.toFixed(4)}  →  Close ${Math.abs(c5.close - prevDayHigh).toFixed(4)} pts ${c5.close < prevDayHigh ? 'BELOW' : 'ABOVE'} Prev Day High` : 'N/A (first day in dataset)'}\n` +
        `  Prev Day Low:   ${prevDayLow != null ? `${prevDayLow.toFixed(4)}  →  Close ${Math.abs(c5.close - prevDayLow).toFixed(4)} pts ${c5.close > prevDayLow ? 'ABOVE' : 'BELOW'} Prev Day Low` : 'N/A (first day in dataset)'}\n` +
        `  Swing High(${SWING_LOOKBACK}): ${swingHigh.toFixed(4)}  →  Close ${(swingHigh - c5.close).toFixed(4)} pts ${c5.close < swingHigh ? 'BELOW' : 'AT/ABOVE'} Swing High${nearSwingHigh ? '  ⚠ NEAR SWING HIGH' : ''}\n` +
        `  Swing Low (${SWING_LOOKBACK}): ${swingLow.toFixed(4)}  →  Close ${(c5.close - swingLow).toFixed(4)} pts ${c5.close > swingLow ? 'ABOVE' : 'AT/BELOW'} Swing Low${nearSwingLow ? '  ⚠ NEAR SWING LOW' : ''}\n`;

      // ── 1m breakdown ─────────────────────────────────────────────────────────
      if (inside1m.length > 0) {
        log += `\n1m CANDLE BREAKDOWN (${inside1m.length} micro-candles inside this 5m):\n`;

        let green1m = 0;
        let red1m = 0;
        const pullbackAt: number[] = [];
        let highestInside = -Infinity;
        let lowestInside = Infinity;

        for (let m = 0; m < inside1m.length; m++) {
          const m1 = inside1m[m];
          const m1Time =
            m1.date
              .toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
              .replace(' ', 'T') + '+05:30';
          const m1Range = m1.high - m1.low;
          const m1Body = Math.abs(m1.close - m1.open);
          const m1IsGreen = m1.close >= m1.open;
          const m1BodyPct = m1Range > 0 ? (m1Body / m1Range) * 100 : 0;
          const m1UpperWick = m1IsGreen
            ? m1.high - m1.close
            : m1.high - m1.open;
          const m1LowerWick = m1IsGreen ? m1.open - m1.low : m1.close - m1.low;

          if (m1IsGreen) green1m++;
          else red1m++;

          highestInside = Math.max(highestInside, m1.high);
          lowestInside = Math.min(lowestInside, m1.low);

          // Pullback: counter-trend candle
          const isPullback = (isGreen && !m1IsGreen) || (!isGreen && m1IsGreen);
          if (isPullback) pullbackAt.push(m + 1);

          const pullbackMark = isPullback ? '  ← PULLBACK' : '';
          log +=
            `  [1m-${(m + 1).toString().padStart(2, '0')}] ${m1Time}  ` +
            `${m1IsGreen ? '▲ GREEN' : '▼ RED  '}  ` +
            `O=${m1.open}  H=${m1.high}  L=${m1.low}  C=${m1.close}  ` +
            `body=${m1Body.toFixed(4)} (${m1BodyPct.toFixed(1)}%)  ` +
            `upper=${m1UpperWick.toFixed(4)}  lower=${m1LowerWick.toFixed(4)}` +
            `${pullbackMark}\n`;
        }

        // 1m summary
        const dominantBias =
          green1m > red1m ? 'BULLISH' : green1m < red1m ? 'BEARISH' : 'MIXED';
        const consistentWith5m =
          (isGreen && dominantBias === 'BULLISH') ||
          (!isGreen && dominantBias === 'BEARISH');

        log += `\n  1m SUMMARY:\n`;
        log += `    Green: ${green1m}  |  Red: ${red1m}  |  1m Bias: ${dominantBias}  |  Consistent with 5m: ${consistentWith5m ? 'YES ✓' : 'NO — divergence ⚠'}\n`;
        log += `    Pullbacks (counter-trend 1m candles): ${pullbackAt.length > 0 ? `${pullbackAt.length} at candle(s) #${pullbackAt.join(', #')}` : 'NONE'}\n`;

        const retracePct =
          range > 0 && pullbackAt.length > 0
            ? (() => {
                const deepestClose = isGreen
                  ? Math.min(
                      ...pullbackAt.map((idx) => inside1m[idx - 1].close),
                    )
                  : Math.max(
                      ...pullbackAt.map((idx) => inside1m[idx - 1].close),
                    );
                const retraceFromStart = isGreen
                  ? c5.open - deepestClose
                  : deepestClose - c5.open;
                return ((retraceFromStart / range) * 100).toFixed(1);
              })()
            : null;

        if (retracePct !== null) {
          log += `    Max Retracement Depth: ~${retracePct}% of 5m range\n`;
        }

        log += `    5m Midpoint: ${midPoint.toFixed(4)}  |  1m range high: ${highestInside.toFixed(4)}  |  1m range low: ${lowestInside.toFixed(4)}\n`;

        // Reversal detection (last 1m candle is counter-trend AND large body)
        const last1m = inside1m[inside1m.length - 1];
        if (last1m) {
          const lastIsGreen = last1m.close >= last1m.open;
          const lastBody = Math.abs(last1m.close - last1m.open);
          const lastRange = last1m.high - last1m.low;
          const lastBodyPct = lastRange > 0 ? (lastBody / lastRange) * 100 : 0;
          const closingReversal =
            (isGreen && !lastIsGreen && lastBodyPct >= 50) ||
            (!isGreen && lastIsGreen && lastBodyPct >= 50);
          if (closingReversal) {
            log += `    ⚠ CLOSING REVERSAL: Last 1m candle is strong counter-trend (${lastIsGreen ? 'GREEN' : 'RED'} ${lastBodyPct.toFixed(1)}% body) — watch for reversal!\n`;
          }
        }
      } else {
        log += `\n1m CANDLE BREAKDOWN: No 1m candles found for this 5m window\n`;
      }

      log += '\n';
      scanLog.writeRaw(log);
    }
  }
}

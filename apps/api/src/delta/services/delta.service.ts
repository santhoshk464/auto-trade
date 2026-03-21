import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ScanLogger } from './scan-logger.service';

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
  erSoftMinWick: number;    // min wick/range ratio — requires at least a moderate wick
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
      path,
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
    const json: any = await res.json();
    if (!res.ok) {
      this.logger.error(
        `[Delta] ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`,
      );
      throw new Error(
        json?.error?.message ||
          json?.message ||
          `Delta API error ${res.status}`,
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
      if (touchedEma && closeAboveEma && bullishClose && softBodyOk && softWickOk && slopeBullish) {
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
      if (touchedEma && closeBelowEma && bearishClose && softBodyOk && softWickOk && slopeBearish) {
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
        erSoftMinWick: 0.10,
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
      erSoftMinWick: 0.10,
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
    moveToBeAtR: number; // delayed BE — SL only moves to entry after price reaches this
    maxTargetR: number;
  } {
    switch (setupType) {
      case 'TrendPullback':
        return {
          partialAtR: 1.0,
          partialPct: 0.25,
          moveToBeAtR: 1.2,
          maxTargetR: 5.0,
        };
      case 'EmaRejection':
        return {
          partialAtR: 1.0,
          partialPct: 0.25,
          moveToBeAtR: 1.2,
          maxTargetR: 5.0,
        };
      case 'LiquiditySweep':
        return {
          partialAtR: 1.0,
          partialPct: 0.25,
          moveToBeAtR: 1.3,
          maxTargetR: 5.0,
        };
      default:
        return {
          partialAtR: 1.0,
          partialPct: 0.25,
          moveToBeAtR: 1.2,
          maxTargetR: 5.0,
        };
    }
  }

  /**
   * Scan candles and return buy/sell signals based on the selected strategy.
   * Each signal is forward-simulated to determine SL/Target outcome and P&L.
   * Strategies: EMA_CROSS | RSI | SUPERTREND | EMA_RSI | SCALPING
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
    }>
  > {
    // SCALPING always uses 1m entry candles; HTF bias is built by grouping 1m → 5m internally
    const resolution =
      strategy === 'SCALPING' ? '1m' : this.toDeltaResolution(interval);
    // Use IST (UTC+05:30) so the user's selected calendar date maps to the correct local day
    const startTs = Math.floor(
      new Date(fromDate + 'T00:00:00+05:30').getTime() / 1000,
    );
    const endTs = Math.floor(
      new Date(toDate + 'T23:59:59+05:30').getTime() / 1000,
    );

    const candles = await this.fetchCandlesRange(
      symbol,
      resolution,
      startTs,
      endTs,
    );
    if (candles.length < 30) return [];

    const closes = candles.map((c) => c.close);

    // Internal raw signals with candle index for simulation
    type RawSignal = {
      candleIdx: number;
      type: 'BUY' | 'SELL';
      setupType?: 'TrendPullback' | 'LiquiditySweep' | 'EmaRejection';
      slRef?: number; // setup-specific SL price reference
      atrAtSignal?: number; // ATR at signal candle for buffer
      ema20AtSignal?: number | null; // EMA20 at signal candle for stretch check
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
    }

    scanLog.logSummary(candles.length, raw.length);
    scanLog.close();
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
    return raw.flatMap(
      ({
        candleIdx,
        type,
        reason,
        setupType,
        slRef,
        atrAtSignal,
        ema20AtSignal,
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
            // 3. Delayed BE move — only after price reaches moveToBeAtR
            if (cfg && !beActivated && beLevel !== null && fc.high >= beLevel) {
              beActivated = true;
              trailingSL = entry;
            }
            // 4. Non-scalping BE at 1R
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
            // 3. Delayed BE move — only after price reaches moveToBeAtR
            if (cfg && !beActivated && beLevel !== null && fc.low <= beLevel) {
              beActivated = true;
              trailingSL = entry;
            }
            // 4. Non-scalping BE at 1R
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
          },
        ];
      },
    );
  }
}

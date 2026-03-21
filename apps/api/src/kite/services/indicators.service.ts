/**
 * IndicatorsService
 *
 * Pure-math helpers that are completely broker-agnostic.
 * No DB access, no API calls — just numbers in, numbers out.
 *
 * Extracted from KiteService so the same indicator logic can be reused by
 * any future broker adapter (Delta, Angel, etc.) without copy-pasting.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class IndicatorsService {
  // ─── Trend Indicators ────────────────────────────────────────────────────────

  /**
   * Exponential Moving Average.
   * Returns an array of the same length as `data`; the first `period-1`
   * values are `null` (not enough data yet).
   */
  calculateEMA(data: number[], period: number): (number | null)[] {
    if (data.length < period) return data.map(() => null);

    const ema: (number | null)[] = [];
    const multiplier = 2 / (period + 1);

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
      ema.push(null);
    }
    const sma = sum / period;
    ema[period - 1] = sma;

    for (let i = period; i < data.length; i++) {
      const currentEMA = (data[i] - ema[i - 1]!) * multiplier + ema[i - 1]!;
      ema.push(currentEMA);
    }
    return ema;
  }

  /**
   * Relative Strength Index (Wilder smoothing).
   * Returns an array of the same length as `data`; first `period` values null.
   */
  calculateRSI(data: number[], period = 14): (number | null)[] {
    if (data.length < period + 1) return data.map(() => null);

    const rsi: (number | null)[] = [];
    let gains: number[] = [];
    let losses: number[] = [];

    for (let i = 0; i < period; i++) {
      rsi.push(null);
      if (i === 0) continue;
      const change = data[i] - data[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }

    let avgGain = gains.reduce((s, v) => s + v, 0) / period;
    let avgLoss = losses.reduce((s, v) => s + v, 0) / period;

    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return rsi;
  }

  /**
   * SuperTrend indicator (Wilder ATR).
   * Returns null for the first `period-1` candles.
   */
  calculateSuperTrend(
    candles: Array<{ high: number; low: number; close: number }>,
    period = 10,
    multiplier = 2,
  ): Array<{ superTrend: number; trend: 'up' | 'down' } | null> {
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

    const atr: number[] = new Array(n).fill(0);
    let sumTR = 0;
    for (let i = 0; i < period; i++) sumTR += tr[i];
    atr[period - 1] = sumTR / period;
    for (let i = period; i < n; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    const result: Array<{ superTrend: number; trend: 'up' | 'down' } | null> =
      new Array(period - 1).fill(null);
    let upperBand = 0,
      lowerBand = 0,
      superTrend = 0;
    let trend: 'up' | 'down' = 'up';

    for (let i = period - 1; i < n; i++) {
      const hl2 = (candles[i].high + candles[i].low) / 2;
      const basicUpper = hl2 + multiplier * atr[i];
      const basicLower = hl2 - multiplier * atr[i];
      const prevClose =
        i === period - 1 ? candles[i].close : candles[i - 1].close;

      const newUpper =
        i === period - 1 || basicUpper < upperBand || prevClose > upperBand
          ? basicUpper
          : upperBand;
      const newLower =
        i === period - 1 || basicLower > lowerBand || prevClose < lowerBand
          ? basicLower
          : lowerBand;

      if (i === period - 1) {
        trend = candles[i].close > hl2 ? 'up' : 'down';
      } else if (superTrend === upperBand) {
        trend = candles[i].close > newUpper ? 'up' : 'down';
      } else {
        trend = candles[i].close < newLower ? 'down' : 'up';
      }

      superTrend = trend === 'up' ? newLower : newUpper;
      upperBand = newUpper;
      lowerBand = newLower;
      result.push({ superTrend, trend });
    }
    return result;
  }

  /** VWAP — resets each session; pass only today's candles. */
  calculateVWAP(
    candles: Array<{
      high: number;
      low: number;
      close: number;
      volume: number;
    }>,
  ): number[] {
    let tpv = 0,
      vol = 0;
    return candles.map((c) => {
      const tp = (c.high + c.low + c.close) / 3;
      tpv += tp * c.volume;
      vol += c.volume;
      return vol > 0 ? tpv / vol : tp;
    });
  }

  // ─── Candle Structure ─────────────────────────────────────────────────────────

  /** Higher-highs + higher-lows = bullish; lower-highs + lower-lows = bearish. */
  detectCandleStructure(
    candles: Array<{ high: number; low: number }>,
  ): 'bullish' | 'bearish' | 'neutral' {
    if (candles.length < 3) return 'neutral';
    const c = candles.slice(-3);
    const hhhl =
      c[2].high > c[1].high &&
      c[1].high > c[0].high &&
      c[2].low > c[1].low &&
      c[1].low > c[0].low;
    const lhll =
      c[2].high < c[1].high &&
      c[1].high < c[0].high &&
      c[2].low < c[1].low &&
      c[1].low < c[0].low;
    if (hhhl) return 'bullish';
    if (lhll) return 'bearish';
    return 'neutral';
  }

  // ─── SL / Target ──────────────────────────────────────────────────────────────

  /**
   * Basic SL + target using candle high/low and a 3:1 RRR.
   */
  calculateStopLossAndTarget(
    entryPrice: number,
    type: 'BUY' | 'SELL',
    candle: any,
  ): { stopLoss: number; target: number } {
    const targetRRR = 3;
    if (type === 'BUY') {
      const risk = entryPrice - candle.low;
      return { stopLoss: candle.low, target: entryPrice + risk * targetRRR };
    } else {
      const risk = candle.high - entryPrice;
      return { stopLoss: candle.high, target: entryPrice - risk * targetRRR };
    }
  }

  // ─── Bullish Candle Patterns ──────────────────────────────────────────────────

  private isBullishEngulfing(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    return (
      prev.close < prev.open &&
      curr.close > curr.open &&
      curr.open < prev.close &&
      curr.close > prev.open &&
      Math.abs(curr.close - curr.open) > Math.abs(prev.close - prev.open)
    );
  }

  private isHammer(candle: any): boolean {
    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const totalRange = candle.high - candle.low;
    return (
      lowerWick > body * 2 && upperWick < body * 0.3 && body < totalRange * 0.3
    );
  }

  private isMorningStar(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    return (
      first.close < first.open &&
      Math.abs(first.close - first.open) > (first.high - first.low) * 0.6 &&
      Math.abs(second.close - second.open) <
        Math.abs(first.close - first.open) * 0.3 &&
      third.close > third.open &&
      Math.abs(third.close - third.open) > (third.high - third.low) * 0.6 &&
      third.close > (first.open + first.close) / 2
    );
  }

  private isInvertedHammer(candle: any): boolean {
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const totalRange = candle.high - candle.low;
    return (
      upperWick > body * 2 && lowerWick < body * 0.3 && body < totalRange * 0.3
    );
  }

  private isThreeInsideUp(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    const firstMidpoint = (first.open + first.close) / 2;
    return (
      first.close < first.open &&
      Math.abs(first.close - first.open) > (first.high - first.low) * 0.6 &&
      second.close > second.open &&
      second.open > first.close &&
      second.close > firstMidpoint &&
      second.close < first.open &&
      third.close > third.open &&
      third.close > first.open
    );
  }

  private isThreeOutsideUp(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    return (
      first.close < first.open &&
      second.close > second.open &&
      second.open < first.close &&
      second.close > first.open &&
      third.close > third.open &&
      third.close > second.close
    );
  }

  private isTweezerBottom(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    return (
      prev.close < prev.open &&
      curr.close > curr.open &&
      Math.abs(prev.low - curr.low) < ((prev.low + curr.low) / 2) * 0.002
    );
  }

  private isLadderBottom(candles: any[], index: number): boolean {
    if (index < 4) return false;
    const [c1, c2, c3, c4, c5] = [
      candles[index - 4],
      candles[index - 3],
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    const b = (c: any) => Math.abs(c.close - c.open);
    return (
      c1.close < c1.open &&
      c2.close < c2.open &&
      c3.close < c3.open &&
      b(c1) > (c1.high - c1.low) * 0.5 &&
      b(c2) > (c2.high - c2.low) * 0.5 &&
      b(c3) > (c3.high - c3.low) * 0.5 &&
      b(c4) < b(c3) * 0.5 &&
      c5.close > c5.open &&
      b(c5) > (c5.high - c5.low) * 0.6
    );
  }

  private isMeetingLines(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);
    return (
      prev.close < prev.open &&
      curr.close > curr.open &&
      prevBody > (prev.high - prev.low) * 0.6 &&
      currBody > (curr.high - curr.low) * 0.6 &&
      curr.open < prev.close &&
      Math.abs(prev.close - curr.close) <
        ((prev.close + curr.close) / 2) * 0.003
    );
  }

  /** Returns the name of the first matching bullish pattern, or null. */
  detectBullishPattern(candles: any[], index: number): string | null {
    if (this.isBullishEngulfing(candles, index)) return 'Bullish Engulfing';
    if (this.isHammer(candles[index])) return 'Hammer';
    if (this.isMorningStar(candles, index)) return 'Morning Star';
    if (this.isInvertedHammer(candles[index])) return 'Inverted Hammer';
    if (this.isThreeInsideUp(candles, index)) return 'Three Inside Up';
    if (this.isThreeOutsideUp(candles, index)) return 'Three Outside Up';
    if (this.isTweezerBottom(candles, index)) return 'Tweezer Bottom';
    if (this.isLadderBottom(candles, index)) return 'Ladder Bottom';
    if (this.isMeetingLines(candles, index)) return 'Meeting Lines';
    return null;
  }

  // ─── Bearish Candle Patterns ──────────────────────────────────────────────────

  private isBearishEngulfing(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    return (
      prev.close > prev.open &&
      curr.close < curr.open &&
      curr.open > prev.close &&
      curr.close < prev.open &&
      Math.abs(curr.close - curr.open) > Math.abs(prev.close - prev.open)
    );
  }

  private isBearishBeltHold(candle: any): boolean {
    const body = Math.abs(candle.close - candle.open);
    const totalRange = candle.high - candle.low;
    return (
      candle.close < candle.open &&
      body > totalRange * 0.7 &&
      candle.open >= candle.high * 0.998 &&
      candle.high - Math.max(candle.open, candle.close) < body * 0.1 &&
      Math.min(candle.open, candle.close) - candle.low < body * 0.3
    );
  }

  private isBearishHangingMan(candle: any): boolean {
    const body = Math.abs(candle.close - candle.open);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const totalRange = candle.high - candle.low;
    return (
      lowerWick > body * 2 && upperWick < body * 0.3 && body < totalRange * 0.3
    );
  }

  private isUpsideGapTwoCrows(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    return (
      first.close > first.open &&
      second.close < second.open &&
      third.close < third.open &&
      second.open > first.close &&
      third.close < second.close &&
      third.close > first.close
    );
  }

  private isBearishEveningStar(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    return (
      first.close > first.open &&
      Math.abs(first.close - first.open) > (first.high - first.low) * 0.6 &&
      Math.abs(second.close - second.open) <
        Math.abs(first.close - first.open) * 0.3 &&
      third.close < third.open &&
      Math.abs(third.close - third.open) > (third.high - third.low) * 0.6 &&
      third.close < (first.open + first.close) / 2
    );
  }

  private isBearishShootingStar(candle: any): boolean {
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const totalRange = candle.high - candle.low;
    return (
      upperWick > body * 2 && lowerWick < body * 0.3 && body < totalRange * 0.3
    );
  }

  private isBearishHarami(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);
    return (
      prev.close > prev.open &&
      prevBody > (prev.high - prev.low) * 0.6 &&
      curr.close < curr.open &&
      curr.open < prev.close &&
      curr.close > prev.open &&
      currBody < prevBody * 0.5
    );
  }

  private isBearishDojiStar(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);
    return (
      prev.close > prev.open &&
      prevBody > (prev.high - prev.low) * 0.6 &&
      currBody < (curr.high - curr.low) * 0.1
    );
  }

  private isBearishAbandonedBaby(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    const secondBody = Math.abs(second.close - second.open);
    return (
      first.close > first.open &&
      secondBody < (second.high - second.low) * 0.1 &&
      third.close < third.open &&
      second.low > first.high &&
      third.high < second.low
    );
  }

  private isBearishTweezerTops(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    return (
      prev.close > prev.open &&
      curr.close < curr.open &&
      Math.abs(prev.high - curr.high) < ((prev.high + curr.high) / 2) * 0.002
    );
  }

  private isBearishThreeInsideDown(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    const firstMidpoint = (first.open + first.close) / 2;
    return (
      first.close > first.open &&
      Math.abs(first.close - first.open) > (first.high - first.low) * 0.6 &&
      second.close < second.open &&
      second.open < first.close &&
      second.close < firstMidpoint &&
      second.close > first.open &&
      third.close < third.open &&
      third.close < first.open
    );
  }

  private isDarkCloudCover(candles: any[], index: number): boolean {
    if (index < 1) return false;
    const prev = candles[index - 1];
    const curr = candles[index];
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);
    const prevMidpoint = (prev.open + prev.close) / 2;
    return (
      prev.close > prev.open &&
      prevBody > (prev.high - prev.low) * 0.6 &&
      curr.close < curr.open &&
      currBody > (curr.high - curr.low) * 0.6 &&
      curr.open > prev.high &&
      curr.close < prevMidpoint &&
      curr.close > prev.open
    );
  }

  private isBearishThreeOutsideDown(candles: any[], index: number): boolean {
    if (index < 2) return false;
    const [first, second, third] = [
      candles[index - 2],
      candles[index - 1],
      candles[index],
    ];
    return (
      first.close > first.open &&
      second.close < second.open &&
      second.open > first.close &&
      second.close < first.open &&
      third.close < third.open &&
      third.close < second.close
    );
  }

  /** Returns the name of the first matching bearish pattern, or null. */
  detectBearishPattern(candles: any[], index: number): string | null {
    if (this.isBearishEngulfing(candles, index)) return 'Bearish Engulfing';
    if (this.isBearishBeltHold(candles[index])) return 'Bearish Belt Hold';
    if (this.isBearishHangingMan(candles[index])) return 'Hanging Man';
    if (this.isUpsideGapTwoCrows(candles, index)) return 'Upside Gap Two Crows';
    if (this.isBearishEveningStar(candles, index)) return 'Evening Star';
    if (this.isBearishShootingStar(candles[index])) return 'Shooting Star';
    if (this.isBearishHarami(candles, index)) return 'Bearish Harami';
    if (this.isBearishDojiStar(candles, index)) return 'Doji Star';
    if (this.isBearishAbandonedBaby(candles, index)) return 'Abandoned Baby';
    if (this.isBearishTweezerTops(candles, index)) return 'Tweezer Tops';
    if (this.isBearishThreeInsideDown(candles, index))
      return 'Three Inside Down';
    if (this.isDarkCloudCover(candles, index)) return 'Dark Cloud Cover';
    if (this.isBearishThreeOutsideDown(candles, index))
      return 'Three Outside Down';
    return null;
  }
}

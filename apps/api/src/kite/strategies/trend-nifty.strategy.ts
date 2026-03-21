/**
 * Trend Nifty Strategy — Standalone
 *
 * Uses SuperTrend(10,2) + VWAP + Candle Structure for 3/3 confluence.
 * When all three align bullish or bearish, sells an OTM option in the
 * trending direction.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma.
 *   - Requires `indicators` (IndicatorsService) and `logger` (NestJS Logger)
 *     to be injected by the caller (kite.service.ts).
 */

import type { IndicatorsService } from '../services/indicators.service';
import type { Logger } from '@nestjs/common';

export type KiteInstrument = {
  instrument_token: number;
  tradingsymbol: string;
  name?: string;
  segment?: string;
  exchange?: string;
  instrument_type?: string;
  strike?: number;
  expiry?: string | Date | object;
  lot_size?: number;
};

export async function executeTrendNiftyStrategy(
  kc: any,
  otmDistance: number,
  targetDate: string,
  allInstruments: KiteInstrument[],
  indicators: IndicatorsService,
  logger: Logger,
  interval: string = '15minute',
): Promise<{ options: any[] }> {
  const todayStr = targetDate;
  const yesterday = new Date(targetDate);
  yesterday.setDate(yesterday.getDate() - 1);
  if (yesterday.getDay() === 0) yesterday.setDate(yesterday.getDate() - 2);
  else if (yesterday.getDay() === 6) yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const niftyIndex = allInstruments.find(
    (i) => i.segment === 'INDICES' && i.tradingsymbol === 'NIFTY 50',
  );
  if (!niftyIndex) {
    logger.error('[TREND_NIFTY] NIFTY 50 index instrument not found');
    return { options: [] };
  }

  try {
    const yesterdayCandles = await kc.getHistoricalData(
      niftyIndex.instrument_token,
      interval,
      `${yesterdayStr} 09:15:00`,
      `${yesterdayStr} 15:30:00`,
    );
    const todayCandles = await kc.getHistoricalData(
      niftyIndex.instrument_token,
      interval,
      `${todayStr} 09:15:00`,
      `${todayStr} 09:31:00`,
    );

    if (!todayCandles || todayCandles.length === 0) {
      logger.warn(
        '[TREND_NIFTY] No 9:30 candle for NIFTY 50. Market may be closed.',
      );
      return { options: [] };
    }

    const warmup = (yesterdayCandles || []).slice(-20);
    const allCandles = [...warmup, ...todayCandles];
    const last = allCandles[allCandles.length - 1];
    const spotPrice: number = last.close;

    // === SuperTrend(10, 2) ===
    const stResults = indicators.calculateSuperTrend(allCandles, 10, 2);
    const lastST = stResults[stResults.length - 1];
    if (!lastST) {
      logger.warn(
        '[TREND_NIFTY] Not enough data for SuperTrend (need 11+ candles)',
      );
      return { options: [] };
    }
    const superTrendSignal: 'bullish' | 'bearish' =
      lastST.trend === 'up' ? 'bullish' : 'bearish';

    // === VWAP (today session only) ===
    const vwapValues = indicators.calculateVWAP(todayCandles);
    const lastVWAP = vwapValues[vwapValues.length - 1];
    const vwapSignal: 'bullish' | 'bearish' | 'neutral' =
      spotPrice > lastVWAP
        ? 'bullish'
        : spotPrice < lastVWAP
          ? 'bearish'
          : 'neutral';

    // === Candle Structure ===
    const structureSignal = indicators.detectCandleStructure(allCandles);

    logger.log(
      `[TREND_NIFTY] Spot=${spotPrice.toFixed(2)} VWAP=${lastVWAP.toFixed(2)} STLine=${lastST.superTrend.toFixed(2)} | ST=${superTrendSignal} | VWAP=${vwapSignal} | Structure=${structureSignal}`,
    );

    const trendInfo: any = {
      superTrend: superTrendSignal,
      vwap: vwapSignal,
      structure: structureSignal,
      confluence: false,
      spotPrice,
      vwapPrice: lastVWAP,
      superTrendLine: lastST.superTrend,
    };

    // === 3/3 Confluence ===
    const allBullish =
      superTrendSignal === 'bullish' &&
      vwapSignal === 'bullish' &&
      structureSignal === 'bullish';
    const allBearish =
      superTrendSignal === 'bearish' &&
      vwapSignal === 'bearish' &&
      structureSignal === 'bearish';

    if (!allBullish && !allBearish) {
      logger.log(`[TREND_NIFTY] No 3/3 confluence — no signal.`);
      return { options: [{ noTrade: true, trendInfo }] };
    }

    trendInfo.confluence = true;
    const trendDirection = allBullish ? 'bullish' : 'bearish';
    const optionType = allBullish ? 'PE' : 'CE';

    // === OTM strike ===
    const strikeInterval = 50;
    const atmStrike = Math.round(spotPrice / strikeInterval) * strikeInterval;
    const otmOffset = Math.round(otmDistance / strikeInterval) * strikeInterval;
    const otmStrike = allBullish
      ? atmStrike - otmOffset
      : atmStrike + otmOffset;

    // === Nearest weekly expiry ===
    const expiries = new Set<string>();
    allInstruments
      .filter((i) => {
        let name = i.name;
        if (name?.startsWith('"') && name?.endsWith('"'))
          name = name.slice(1, -1);
        return (
          name === 'NIFTY' &&
          i.exchange === 'NFO' &&
          (i.instrument_type === 'CE' || i.instrument_type === 'PE')
        );
      })
      .forEach((i) => {
        let exp = i.expiry as any;
        if (typeof exp === 'object' && exp !== null)
          exp = exp.toISOString().split('T')[0];
        if (exp >= todayStr) expiries.add(exp);
      });

    const nearestExpiry = Array.from(expiries).sort()[0];
    if (!nearestExpiry) {
      logger.warn('[TREND_NIFTY] No future expiry found in instruments cache');
      return { options: [] };
    }

    // === Find the option instrument ===
    const optionInst = allInstruments.find((i) => {
      let name = i.name;
      if (name?.startsWith('"') && name?.endsWith('"'))
        name = name.slice(1, -1);
      let exp = i.expiry as any;
      if (typeof exp === 'object' && exp !== null)
        exp = exp.toISOString().split('T')[0];
      return (
        name === 'NIFTY' &&
        i.exchange === 'NFO' &&
        i.instrument_type === optionType &&
        i.strike === otmStrike &&
        exp === nearestExpiry
      );
    });

    if (!optionInst) {
      logger.warn(
        `[TREND_NIFTY] Instrument not found: NIFTY ${otmStrike} ${optionType} exp=${nearestExpiry}`,
      );
      return { options: [] };
    }

    // === LTP ===
    let ltp = 0;
    try {
      const key = `NFO:${optionInst.tradingsymbol}`;
      const q = await kc.getQuote([key]);
      if (q && q[key]) ltp = q[key].last_price;
    } catch (e: any) {
      logger.warn(`[TREND_NIFTY] LTP fetch failed: ${e.message}`);
    }

    // === Risk Management ===
    const slPts = 30;
    const sl = ltp + slPts;
    const t1 = ltp - slPts * 2;
    const t2 = ltp - slPts * 3;
    const t3 = ltp - slPts * 4;

    const signal = {
      type: 'SELL',
      recommendation: 'SELL',
      price: ltp,
      stopLoss: sl,
      target: t1,
      target2: t2,
      target3: t3,
      breakeven: ltp,
      text: `${trendDirection.toUpperCase()} TREND — Sell ${optionInst.tradingsymbol} @ ₹${ltp}`,
      reason: `SuperTrend(10,2)=${superTrendSignal} | VWAP=${vwapSignal} | Structure=${structureSignal} | OTM=${otmDistance}pts | Exp=${nearestExpiry}`,
      trailingActive: false,
    };

    logger.log(
      `[TREND_NIFTY] SIGNAL: SELL ${optionInst.tradingsymbol} | Entry=${ltp} SL=${sl} T1=${t1} T2=${t2} T3=${t3}`,
    );

    return {
      options: [
        {
          symbol: 'NIFTY',
          strike: otmStrike,
          optionType,
          tradingsymbol: optionInst.tradingsymbol,
          instrumentToken: optionInst.instrument_token,
          signals: [signal],
          ltp,
          lotSize: optionInst.lot_size,
          candles: [],
          trendInfo: {
            ...trendInfo,
            trendDirection,
            otmStrike,
            nearestExpiry,
          },
        },
      ],
    };
  } catch (err: any) {
    logger.error(`[TREND_NIFTY] Unexpected error: ${err.message}`, err.stack);
    return { options: [] };
  }
}

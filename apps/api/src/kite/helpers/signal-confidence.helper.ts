/**
 * Signal Confidence Helper
 *
 * Scores each sell signal from 0–8 and grades it A++ / A / B / C.
 * Purely ADDITIVE — does NOT block signals. Use enableNiftyTrendFilter for hard blocking.
 *
 * Score breakdown (8 points max):
 *   2 pts — SuperTrend aligned   — NIFTY Futures 5m OR BANKNIFTY Futures 5m
 *   2 pts — VWAP aligned         — NIFTY Futures 5m OR BANKNIFTY Futures 5m
 *   2 pts — Daily 20-EMA trend   — NIFTY OR BANKNIFTY (either index confirms = points awarded)
 *   1 pt  — INDIA VIX direction aligned (VIX rising → bearish, VIX falling → bullish)
 *   1 pt  — Option prevDay close position (closed near low = bearish option momentum)
 *
 * Bank Nifty co-relation: since BANKNIFTY moves strongly with NIFTY, if either index
 * confirms the direction for ST/VWAP/Daily, the point is awarded (OR logic).
 * Individual BANKNIFTY results are stored as bnSuperTrend / bnVwap / bnDailyTrend
 * for transparency in the UI breakdown.
 *
 * Grade mapping:
 *   7–8 → A++  (take with high confidence, 2× qty)
 *   5–6 → A    (take with normal qty)
 *   3–4 → B    (reduced qty or paper only)
 *   0–2 → C    (skip)
 *
 * Usage:
 *   const confidence = await computeSignalConfidence({ kc, prisma, ... });
 *   // Store confidence.score + confidence.grade on Signal DB record.
 */

import { PrismaClient } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KiteInstance = any;

export type ConfidenceGrade = 'A++' | 'A' | 'B' | 'C';

export interface SignalConfidenceResult {
  score: number;
  grade: ConfidenceGrade;
  breakdown: {
    superTrend: boolean; // 2 pts — NIFTY OR BANKNIFTY
    vwap: boolean; // 2 pts — NIFTY OR BANKNIFTY
    dailyTrend: boolean; // 2 pts — NIFTY OR BANKNIFTY
    vix: boolean; // 1 pt
    prevDayOption: boolean; // 1 pt
    /** Individual NIFTY results (for UI transparency) */
    nSuperTrend?: boolean;
    nVwap?: boolean;
    nDailyTrend?: boolean;
    /** Individual BANKNIFTY results (for UI transparency) */
    bnSuperTrend?: boolean;
    bnVwap?: boolean;
    bnDailyTrend?: boolean;
  };
  /** Human-readable log string */
  reason: string;
}

export interface ComputeConfidenceOptions {
  kc: KiteInstance;
  prisma: PrismaClient;
  /** NIFTY, BANKNIFTY, FINNIFTY, etc. */
  symbol: string;
  /** Signal candle date string "YYYY-MM-DD" */
  date: string;
  /** Signal candle UTC timestamp in ms */
  signalTimestampMs: number;
  /** CE or PE */
  optionType: 'CE' | 'PE';
  /**
   * Yesterday's option intraday candles — already fetched by caller for EMA seeding.
   * Used for prevDay H/L/C check at zero extra API cost.
   * Pass an empty array [] if unavailable.
   */
  prevDayOptionCandles: Array<{ high: number; low: number; close: number }>;
}

// ─── SuperTrend (10, 2) — same implementation as nifty-trend.helper.ts ────────

interface Candle {
  high: number;
  low: number;
  close: number;
  volume: number;
}

function calcSuperTrend(
  candles: Candle[],
  period = 10,
  multiplier = 2,
): Array<{ value: number; direction: 'UP' | 'DOWN' }> {
  const result: Array<{ value: number; direction: 'UP' | 'DOWN' }> = [];

  const atrs: number[] = [];
  let prevATR = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    if (i < period) {
      atrs.push(tr);
      if (i === period - 1) {
        prevATR = atrs.reduce((a, b) => a + b, 0) / period;
        atrs.push(prevATR);
      }
    } else {
      prevATR = (prevATR * (period - 1) + tr) / period;
      atrs.push(prevATR);
    }
  }

  let prevUpper = 0;
  let prevLower = 0;
  let prevDir: 'UP' | 'DOWN' = 'DOWN';
  let prevST = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push({ value: candles[i].close, direction: 'DOWN' });
      continue;
    }
    const c = candles[i];
    const atr = atrs[i];
    const hl2 = (c.high + c.low) / 2;
    let upperBand = hl2 + multiplier * atr;
    let lowerBand = hl2 - multiplier * atr;

    if (i > 0) {
      if (!(lowerBand < prevLower || candles[i - 1].close < prevLower)) {
        lowerBand = Math.max(lowerBand, prevLower);
      }
      if (!(upperBand > prevUpper || candles[i - 1].close > prevUpper)) {
        upperBand = Math.min(upperBand, prevUpper);
      }
    }

    let dir: 'UP' | 'DOWN';
    let st: number;

    if (prevDir === 'DOWN') {
      if (c.close <= prevST) {
        dir = 'DOWN';
        st = upperBand;
      } else {
        dir = 'UP';
        st = lowerBand;
      }
    } else {
      if (c.close >= prevST) {
        dir = 'UP';
        st = lowerBand;
      } else {
        dir = 'DOWN';
        st = upperBand;
      }
    }

    prevUpper = upperBand;
    prevLower = lowerBand;
    prevDir = dir;
    prevST = st;
    result.push({ value: st, direction: dir });
  }

  return result;
}

function calcVWAP(candles: Array<Candle & { date?: Date }>): number[] {
  const vwaps: number[] = [];
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    vwaps.push(cumVol > 0 ? cumTPV / cumVol : c.close);
  }
  return vwaps;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      ema = values[0];
    } else {
      ema = values[i] * k + ema * (1 - k);
    }
    result.push(ema);
  }
  return result;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function computeSignalConfidence(
  opts: ComputeConfidenceOptions,
): Promise<SignalConfidenceResult> {
  const {
    kc,
    prisma,
    symbol,
    date,
    signalTimestampMs,
    optionType,
    prevDayOptionCandles,
  } = opts;

  // Default — all false, score 0
  const breakdown = {
    superTrend: false,
    vwap: false,
    dailyTrend: false,
    vix: false,
    prevDayOption: false,
    nSuperTrend: false,
    nVwap: false,
    nDailyTrend: false,
    bnSuperTrend: false,
    bnVwap: false,
    bnDailyTrend: false,
  };

  try {
    // ── IST time helpers ─────────────────────────────────────────────────────
    // Kite API always uses IST (UTC+5:30) for all date/time strings.
    // signalTimestampMs is a raw UTC ms value (from Date.getTime()).
    // If the Node server runs in UTC (common in production), getHours() gives
    // UTC hours, not IST. Using UTC hours with a Kite API string silently moves
    // the cutoff to before market open → zero today candles → ST/VWAP all fail.
    // Fix: always add +5:30 and read UTC hours from the shifted value.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 330 min
    const signalIST = new Date(signalTimestampMs + IST_OFFSET_MS);
    const hh = String(signalIST.getUTCHours()).padStart(2, '0');
    const mm = String(signalIST.getUTCMinutes()).padStart(2, '0');

    // ── 1. Find NIFTY Futures contract ──────────────────────────────────────
    const futInstrument = await prisma.instrument.findFirst({
      where: {
        name: symbol,
        instrumentType: 'FUT',
        segment: symbol === 'SENSEX' ? 'BFO-FUT' : 'NFO-FUT',
        expiry: { not: null, gte: date },
      },
      orderBy: { expiry: 'asc' },
    });

    if (futInstrument) {
      // ── 2. Fetch 5m Futures candles for SuperTrend + VWAP ───────────────
      // SuperTrend(10,2) needs ≥10 candles to produce a valid direction.
      // Early signals (e.g. 09:35 = only 5 candles since open) would all fail
      // if we only fetch from today 09:15. Fix: fetch from 3 days back so we
      // always have enough history for warmup regardless of signal time.
      //
      // VWAP resets daily, so it must be calculated using ONLY today's candles.
      // We fetch a combined range but separate the two computations.
      //
      // stFrom: subtract 3 calendar days using UTC date parts to avoid DST/tz issues.
      const [yr, mo, dy] = date.split('-').map(Number);
      const stFromDate = new Date(Date.UTC(yr, mo - 1, dy - 3));
      const stFrom = stFromDate.toISOString().split('T')[0] + ' 09:15:00';

      const todayFrom = `${date} 09:15:00`;
      const todayTo = `${date} ${hh}:${mm}:59`;

      // todayStartMs: the UTC equivalent of today 09:15 IST.
      // 09:15 IST = 03:45 UTC. Kite returns candle dates as UTC ISO strings,
      // so comparing candle UTC ms against this correctly filters to today's session.
      const todayStartMs = new Date(`${date}T03:45:00.000Z`).getTime();

      const raw5m = await kc.getHistoricalData(
        futInstrument.instrumentToken,
        '5minute',
        stFrom,
        todayTo,
      );

      if (raw5m && raw5m.length >= 1) {
        const candles5m = raw5m.map((c: any) => ({
          date: new Date(c.date),
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        }));

        // For VWAP: only today's candles (VWAP resets at session open)
        const todayCandles = candles5m.filter(
          (c: Candle & { date: Date }) => c.date.getTime() >= todayStartMs,
        );

        const lastIdx = candles5m.length - 1;
        const last = candles5m[lastIdx];
        const price = last.close;

        // SuperTrend (NIFTY) — uses full history for warmup
        const stResults = calcSuperTrend(candles5m, 10, 2);
        const st = stResults[lastIdx];
        const aboveST = price > st.value && st.direction === 'UP';
        const niftyST =
          (optionType === 'CE' && !aboveST) || (optionType === 'PE' && aboveST);

        // VWAP (NIFTY) — uses only today's candles
        let niftyVWAP = false;
        if (todayCandles.length >= 1) {
          const vwaps = calcVWAP(todayCandles);
          const vwap = vwaps[vwaps.length - 1];
          const aboveVWAP = price > vwap;
          niftyVWAP =
            (optionType === 'CE' && !aboveVWAP) ||
            (optionType === 'PE' && aboveVWAP);
        }

        // ── 2b. BANKNIFTY Futures 5m — co-relation check ────────────────
        // BankNifty moves strongly with Nifty; if BN confirms, award the point (OR logic).
        let bnST = false;
        let bnVWAP = false;
        try {
          const bnFut = await prisma.instrument.findFirst({
            where: {
              name: 'BANKNIFTY',
              instrumentType: 'FUT',
              segment: 'NFO-FUT',
              expiry: { not: null, gte: date },
            },
            orderBy: { expiry: 'asc' },
          });

          if (bnFut) {
            const rawBN5m = await kc.getHistoricalData(
              bnFut.instrumentToken,
              '5minute',
              stFrom,
              todayTo,
            );

            if (rawBN5m && rawBN5m.length >= 1) {
              const bnCandles5m = rawBN5m.map((c: any) => ({
                date: new Date(c.date),
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume ?? 0,
              }));

              const bnTodayCandles = bnCandles5m.filter(
                (c: Candle & { date: Date }) =>
                  c.date.getTime() >= todayStartMs,
              );

              const bnLastIdx = bnCandles5m.length - 1;
              const bnLast = bnCandles5m[bnLastIdx];
              const bnPrice = bnLast.close;

              // SuperTrend (BankNifty) — uses full history for warmup
              const bnStResults = calcSuperTrend(bnCandles5m, 10, 2);
              const bnStVal = bnStResults[bnLastIdx];
              const bnAboveST =
                bnPrice > bnStVal.value && bnStVal.direction === 'UP';
              bnST =
                (optionType === 'CE' && !bnAboveST) ||
                (optionType === 'PE' && bnAboveST);

              // VWAP (BankNifty) — uses only today's candles
              if (bnTodayCandles.length >= 1) {
                const bnVwaps = calcVWAP(bnTodayCandles);
                const bnVwapVal = bnVwaps[bnVwaps.length - 1];
                const bnAboveVWAP = bnPrice > bnVwapVal;
                bnVWAP =
                  (optionType === 'CE' && !bnAboveVWAP) ||
                  (optionType === 'PE' && bnAboveVWAP);
              }
            }
          }
        } catch {
          // BankNifty 5m check failed — leave false, don't throw
        }

        breakdown.bnSuperTrend = bnST;
        breakdown.bnVwap = bnVWAP;
        breakdown.nSuperTrend = niftyST;
        breakdown.nVwap = niftyVWAP;
        // OR: award points if either NIFTY or BANKNIFTY confirms
        breakdown.superTrend = niftyST || bnST;
        breakdown.vwap = niftyVWAP || bnVWAP;
      }
    }

    // ── 3. Daily NIFTY + BANKNIFTY trend — 20-EMA on Futures daily chart ────
    // Uses Futures tokens only (no spot/index). Futures daily candles reflect
    // the same directional bias with slightly more volume-weighted accuracy.
    // Award 2 pts if EITHER NIFTY daily OR BANKNIFTY daily confirms direction.
    try {
      const dailyFrom = (() => {
        const d = new Date(date);
        d.setDate(d.getDate() - 40);
        return d.toISOString().split('T')[0] + ' 09:15:00';
      })();
      const dailyTo = `${date} 15:30:00`;

      // ── NIFTY Futures daily ───────────────────────────────────────────────
      let niftyDaily = false;
      if (futInstrument?.instrumentToken) {
        const rawDaily = await kc.getHistoricalData(
          futInstrument.instrumentToken,
          'day',
          dailyFrom,
          dailyTo,
        );

        if (rawDaily && rawDaily.length >= 21) {
          const closes = rawDaily.map((c: any) => c.close as number);
          const ema20 = calcEMA(closes, 20);
          const lastClose = closes[closes.length - 1];
          const lastEma = ema20[ema20.length - 1];
          const tolerance = lastEma * 0.003;
          const aboveEma = lastClose > lastEma + tolerance;
          const belowEma = lastClose < lastEma - tolerance;
          niftyDaily =
            (optionType === 'CE' && belowEma) ||
            (optionType === 'PE' && aboveEma);
        }
      }

      // ── BANKNIFTY Futures daily ───────────────────────────────────────────
      let bnDaily = false;
      try {
        const bnFutDaily = await prisma.instrument.findFirst({
          where: {
            name: 'BANKNIFTY',
            instrumentType: 'FUT',
            segment: 'NFO-FUT',
            expiry: { not: null, gte: date },
          },
          orderBy: { expiry: 'asc' },
          select: { instrumentToken: true },
        });

        if (bnFutDaily?.instrumentToken) {
          const rawBNDaily = await kc.getHistoricalData(
            bnFutDaily.instrumentToken,
            'day',
            dailyFrom,
            dailyTo,
          );

          if (rawBNDaily && rawBNDaily.length >= 21) {
            const bnCloses = rawBNDaily.map((c: any) => c.close as number);
            const bnEma20 = calcEMA(bnCloses, 20);
            const bnLastClose = bnCloses[bnCloses.length - 1];
            const bnLastEma = bnEma20[bnEma20.length - 1];
            const bnTolerance = bnLastEma * 0.003;
            const bnAboveEma = bnLastClose > bnLastEma + bnTolerance;
            const bnBelowEma = bnLastClose < bnLastEma - bnTolerance;
            bnDaily =
              (optionType === 'CE' && bnBelowEma) ||
              (optionType === 'PE' && bnAboveEma);
          }
        }
      } catch {
        // BankNifty daily check failed — leave false
      }

      breakdown.bnDailyTrend = bnDaily;
      breakdown.nDailyTrend = niftyDaily;
      // OR: award 2 pts if either NIFTY or BANKNIFTY daily confirms
      breakdown.dailyTrend = niftyDaily || bnDaily;
    } catch {
      // Daily trend check failed — leave false, don't throw
    }

    // ── 4. INDIA VIX direction ───────────────────────────────────────────────
    // Kite instrument token for INDIA VIX = 264969 (NSE exchange, INDICES segment)
    // VIX rising → market fear rising → bearish for CE sellers (blocked), good for PE sellers
    // VIX falling → market calm → bearish for PE sellers, good for CE sellers
    try {
      const vixToken = 264969;
      const vixFrom = `${date} 09:15:00`;
      const vixTo = `${date} ${hh}:${mm}:59`;
      const rawVix = await kc.getHistoricalData(
        vixToken,
        '5minute',
        vixFrom,
        vixTo,
      );

      if (rawVix && rawVix.length >= 3) {
        const first = rawVix[0].close as number;
        const last = rawVix[rawVix.length - 1].close as number;
        const vixRising = last > first * 1.002; // >0.2% rise to filter noise
        const vixFalling = last < first * 0.998;
        // VIX rising = fear increasing = bearish → CE sell confirmation, PE sell caution
        // VIX falling = calm = bullish → PE sell confirmation, CE sell caution
        breakdown.vix =
          (optionType === 'CE' && vixRising) ||
          (optionType === 'PE' && vixFalling);
      }
    } catch {
      // VIX check failed — leave false
    }

    // ── 5. Option prevDay close position ────────────────────────────────────
    // Uses the already-fetched yesterday intraday candles (zero extra API call).
    // prevDay close near its LOW → option was losing value yesterday → direction confirmed.
    if (prevDayOptionCandles.length >= 5) {
      const prevHigh = Math.max(...prevDayOptionCandles.map((c) => c.high));
      const prevLow = Math.min(...prevDayOptionCandles.map((c) => c.low));
      const prevClose =
        prevDayOptionCandles[prevDayOptionCandles.length - 1].close;
      const range = prevHigh - prevLow;

      if (range > 0) {
        const closePosition = (prevClose - prevLow) / range; // 0=closed at low, 1=closed at high
        // CE: closed near low (position < 0.35) → option was bearish yesterday
        // PE: closed near low (position < 0.35) → option was bearish yesterday (PE losing = underlying rising)
        // For PE sell: we WANT the PE to be losing value → closed near low is GOOD
        // For CE sell: we WANT the CE to be losing value → closed near low is GOOD
        // Both CE and PE sell benefit from option closing near its prev day low
        breakdown.prevDayOption = closePosition < 0.35;
      }
    }
  } catch {
    // On any unexpected error, return low-confidence result (don't throw)
  }

  // ── Compute final score and grade ─────────────────────────────────────────
  const score =
    (breakdown.superTrend ? 2 : 0) +
    (breakdown.vwap ? 2 : 0) +
    (breakdown.dailyTrend ? 2 : 0) +
    (breakdown.vix ? 1 : 0) +
    (breakdown.prevDayOption ? 1 : 0);

  const grade: ConfidenceGrade =
    score >= 7 ? 'A++' : score >= 5 ? 'A' : score >= 3 ? 'B' : 'C';

  // Show N/BN sub-results for ST, VWAP, Daily using the individually stored values
  const stDetail = `ST(N${breakdown.nSuperTrend ? '✓' : '✗'}/BN${breakdown.bnSuperTrend ? '✓' : '✗'})`;
  const vwapDetail = `VWAP(N${breakdown.nVwap ? '✓' : '✗'}/BN${breakdown.bnVwap ? '✓' : '✗'})`;
  const dailyDetail = `Daily(N${breakdown.nDailyTrend ? '✓' : '✗'}/BN${breakdown.bnDailyTrend ? '✓' : '✗'})`;

  const checks = [
    stDetail,
    vwapDetail,
    dailyDetail,
    `VIX=${breakdown.vix ? '✓' : '✗'}`,
    `PrevDay=${breakdown.prevDayOption ? '✓' : '✗'}`,
  ];

  const reason = `[CONFLUENCE] ${optionType} SELL | score=${score}/8 grade=${grade} | ${checks.join(' ')}`;

  return { score, grade, breakdown, reason };
}

/**
 * Standalone Liquidity Trail Signals scanner.
 *
 * Fetches OHLCV candles directly from Delta Exchange public API,
 * runs the BOSWaves Liquidity Trail strategy, forward-simulates each
 * signal against subsequent candles, and prints a full win-rate report.
 *
 * Usage:
 *   npx ts-node -P tsconfig.json scan-liquidity-trail.ts [symbol] [interval] [fromDate] [toDate]
 *
 * Examples:
 *   npx ts-node -P tsconfig.json scan-liquidity-trail.ts SOLUSD 5m 2026-01-01 2026-03-26
 *   npx ts-node -P tsconfig.json scan-liquidity-trail.ts BTCUSD 15m 2025-10-01 2026-03-26
 *   npx ts-node -P tsconfig.json scan-liquidity-trail.ts ETHUSD 1h 2026-01-01 2026-03-26
 *
 * Supported intervals: 1m | 5m | 15m | 30m | 1h
 *
 * The script does NOT need NestJS or a running server — it calls the
 * Delta Exchange public REST API directly.
 */

import {
  detectLiquidityTrailSignals,
  type LiquidityTrailCandle,
  type LiquidityTrailSignal,
} from './src/kite/strategies/liquidity-trail.strategy';

// ─── Config ──────────────────────────────────────────────────────────────────

const DELTA_API = 'https://api.india.delta.exchange/v2';

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
};

// Pine Script defaults (match exactly)
const STRATEGY_CONFIG = {
  maLen: 28,
  atrLen: 15,
  atrMult: 1.25,
  tp1R: 1.0,
  tp2R: 2.0,
  tp3R: 3.0,
  tp4R: 4.0,
  tp5R: 5.0,
};

// ─── CLI args ─────────────────────────────────────────────────────────────────

const symbol   = process.argv[2] ?? 'SOLUSD';
const interval = process.argv[3] ?? '5m';
const fromArg  = process.argv[4] ?? '2026-01-01';
const toArg    = process.argv[5] ?? new Date().toISOString().slice(0, 10);

if (!INTERVAL_SECONDS[interval]) {
  console.error(`Unknown interval "${interval}". Use: 1m 5m 15m 30m 1h`);
  process.exit(1);
}

// ─── Candle fetcher ──────────────────────────────────────────────────────────

interface RawCandle {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchCandlesPage(
  sym: string,
  res: string,
  startTs: number,
  endTs: number,
): Promise<RawCandle[]> {
  const qs = new URLSearchParams({
    symbol: sym,
    resolution: res,
    start: String(startTs),
    end: String(endTs),
  });
  const url = `${DELTA_API}/history/candles?${qs}`;
  const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  const json: any = await resp.json();
  if (!resp.ok) throw new Error(json?.message ?? `Delta API error ${resp.status}`);

  let raw: any[] = [];
  if (Array.isArray(json?.result?.candles)) raw = json.result.candles;
  else if (Array.isArray(json?.result)) raw = json.result;
  else if (Array.isArray(json)) raw = json;

  return raw
    .map((item): RawCandle => {
      if (Array.isArray(item)) {
        const [t, o, h, l, c, v] = item as number[];
        return { date: new Date(t * 1000), open: +o, high: +h, low: +l, close: +c, volume: +v };
      }
      return {
        date: new Date(((item.time ?? item.t) as number) * 1000),
        open: +item.open,
        high: +item.high,
        low: +item.low,
        close: +item.close,
        volume: +(item.volume ?? 0),
      };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function fetchAllCandles(
  sym: string,
  res: string,
  startTs: number,
  endTs: number,
): Promise<RawCandle[]> {
  const PAGE = 2000;
  const step = INTERVAL_SECONDS[res] * PAGE;
  const all: RawCandle[] = [];
  let from = startTs;

  while (from < endTs) {
    const to = Math.min(from + step, endTs);
    const batch = await fetchCandlesPage(sym, res, from, to);
    all.push(...batch);
    if (batch.length < PAGE) break;
    from = to + 1;
  }

  // De-duplicate by timestamp
  const seen = new Set<number>();
  return all
    .filter((c) => {
      const ts = c.date.getTime();
      if (seen.has(ts)) return false;
      seen.add(ts);
      return true;
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ─── Outcome simulation ───────────────────────────────────────────────────────

type Outcome =
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'TP4_HIT'
  | 'TP5_HIT'
  | 'NEXT_SIGNAL_EXIT'
  | 'FULL_SL'
  | 'OPEN';

interface SignalResult {
  signal: LiquidityTrailSignal;
  outcome: Outcome;
  exitPrice: number | null;
  exitCandleIndex: number | null;
  pnlR: number | null;   // P&L in R units
  pnlPts: number | null; // P&L in price points
}

/**
 * For each signal, scan subsequent candles and determine:
 *   1. FULL_SL     — price hit the stop-loss level.
 *   2. TP1_HIT     — price hit TP1 (1R) before SL.
 *   3. TP2_HIT     — price hit TP2 (2R) before SL (implies TP1 was also hit).
 *   4. TP3_HIT     — price hit TP3 (3R) before SL.
 *   5. NEXT_SIGNAL_EXIT — next opposite-direction signal fires (trail flips again).
 *      Used as a fallback cap: we exit at the CLOSE of that candle.
 *   6. OPEN        — no resolution found (last candles in dataset).
 *
 * Priority: SL/TP conditions are checked candle-by-candle.  On any given candle
 * we check SL first (conservative), then TP1/2/3.  This mirrors the standard
 * assumption that within a single candle the adverse direction is reached first.
 */
function simulateOutcomes(
  candles: RawCandle[],
  signals: LiquidityTrailSignal[],
): SignalResult[] {
  const results: SignalResult[] = [];

  for (let si = 0; si < signals.length; si++) {
    const sig = signals[si];
    const isBuy = sig.signalType === 'BUY';
    const nextSigIdx =
      si + 1 < signals.length ? signals[si + 1].candleIndex : candles.length;

    let outcome: Outcome = 'OPEN';
    let exitPrice: number | null = null;
    let exitCandleIndex: number | null = null;

    for (let j = sig.candleIndex + 1; j < candles.length; j++) {
      const c = candles[j];

      // ── 5. Next opposite-direction signal exit ──────────────────────────────
      // The trail flipped the other way: treat as a momentum exit at close price.
      if (j >= nextSigIdx) {
        outcome = 'NEXT_SIGNAL_EXIT';
        exitPrice = c.close;
        exitCandleIndex = j;
        break;
      }

      if (isBuy) {
        // ── Check SL first (conservative assumption) ──────────────────────────
        if (c.low <= sig.stopLoss) {
          outcome = 'FULL_SL';
          exitPrice = sig.stopLoss;
          exitCandleIndex = j;
          break;
        }
        // ── Check TP5→TP4→TP3→TP2→TP1 (highest first) ────────────────────────
        if (c.high >= sig.target5) {
          outcome = 'TP5_HIT';
          exitPrice = sig.target5;
          exitCandleIndex = j;
          break;
        }
        if (c.high >= sig.target4) {
          outcome = 'TP4_HIT';
          exitPrice = sig.target4;
          exitCandleIndex = j;
          break;
        }
        if (c.high >= sig.target3) {
          outcome = 'TP3_HIT';
          exitPrice = sig.target3;
          exitCandleIndex = j;
          break;
        }
        if (c.high >= sig.target2) {
          outcome = 'TP2_HIT';
          exitPrice = sig.target2;
          exitCandleIndex = j;
          break;
        }
        if (c.high >= sig.target1) {
          outcome = 'TP1_HIT';
          exitPrice = sig.target1;
          exitCandleIndex = j;
          break;
        }
      } else {
        // SELL signal
        if (c.high >= sig.stopLoss) {
          outcome = 'FULL_SL';
          exitPrice = sig.stopLoss;
          exitCandleIndex = j;
          break;
        }
        if (c.low <= sig.target5) {
          outcome = 'TP5_HIT';
          exitPrice = sig.target5;
          exitCandleIndex = j;
          break;
        }
        if (c.low <= sig.target4) {
          outcome = 'TP4_HIT';
          exitPrice = sig.target4;
          exitCandleIndex = j;
          break;
        }
        if (c.low <= sig.target3) {
          outcome = 'TP3_HIT';
          exitPrice = sig.target3;
          exitCandleIndex = j;
          break;
        }
        if (c.low <= sig.target2) {
          outcome = 'TP2_HIT';
          exitPrice = sig.target2;
          exitCandleIndex = j;
          break;
        }
        if (c.low <= sig.target1) {
          outcome = 'TP1_HIT';
          exitPrice = sig.target1;
          exitCandleIndex = j;
          break;
        }
      }
    }

    // ── P&L calculation ───────────────────────────────────────────────────────
    let pnlR: number | null = null;
    let pnlPts: number | null = null;

    if (exitPrice !== null && sig.risk > 0) {
      const dir = isBuy ? 1 : -1;
      pnlPts = +(dir * (exitPrice - sig.entryPrice)).toFixed(8);
      pnlR = +(pnlPts / sig.risk).toFixed(4);
    }

    results.push({ signal: sig, outcome, exitPrice, exitCandleIndex, pnlR, pnlPts });
  }

  return results;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function pad(s: string | number, w: number): string {
  return String(s).padEnd(w);
}
function rpad(s: string | number, w: number): string {
  return String(s).padStart(w);
}
function fmtSign(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(4);
}
function fmtPts(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(4);
}
function fmtDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTs = Math.floor(new Date(fromArg + 'T00:00:00Z').getTime() / 1000);
  const endTs   = Math.floor(new Date(toArg   + 'T23:59:59Z').getTime() / 1000);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Liquidity Trail Signals [BOSWaves]  —  Win Rate Analysis`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Symbol   : ${symbol}`);
  console.log(`  Interval : ${interval}`);
  console.log(`  Range    : ${fromArg}  →  ${toArg}`);
  console.log(`  Config   : EMA(${STRATEGY_CONFIG.maLen})  ATR(${STRATEGY_CONFIG.atrLen})  Mult=${STRATEGY_CONFIG.atrMult}  TP1=${STRATEGY_CONFIG.tp1R}R TP2=${STRATEGY_CONFIG.tp2R}R TP3=${STRATEGY_CONFIG.tp3R}R`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // ── 1. Fetch candles ─────────────────────────────────────────────────────────
  process.stdout.write('Fetching candles ... ');
  const candles = await fetchAllCandles(symbol, interval, startTs, endTs);
  console.log(`${candles.length} candles loaded.\n`);

  if (candles.length < 50) {
    console.error('Not enough candles to run the strategy (need ≥ 50).');
    process.exit(1);
  }

  // ── 2. Run strategy ──────────────────────────────────────────────────────────
  const signals = detectLiquidityTrailSignals(candles as LiquidityTrailCandle[], STRATEGY_CONFIG);

  if (signals.length === 0) {
    console.log('No signals generated for the selected range.');
    return;
  }

  // ── 3. Simulate outcomes ─────────────────────────────────────────────────────
  const results = simulateOutcomes(candles, signals);

  // ── 4. Print signal-by-signal table ──────────────────────────────────────────
  console.log(`── Signal Details ────────────────────────────────────────────────────────────────────`);
  console.log(
    `${'#'.padStart(3)}  ${'Date/Time'.padEnd(16)}  ${'Type'.padEnd(4)}  ${'Entry'.padStart(10)}  ${'SL'.padStart(10)}  ${'TP1'.padStart(10)}  ${'Risk'.padStart(9)}  ${'Outcome'.padEnd(20)}  ${'P&L(R)'.padStart(8)}  ${'P&L(pts)'.padStart(12)}`,
  );
  console.log('─'.repeat(115));

  for (let i = 0; i < results.length; i++) {
    const { signal: s, outcome, pnlR, pnlPts } = results[i];
    const dir = s.signalType === 'BUY' ? '▲ BUY' : '▼ SELL';
    const pnlRStr  = pnlR    != null ? fmtSign(pnlR)   : ' OPEN';
    const pnlPtStr = pnlPts  != null ? fmtPts(pnlPts)  : ' OPEN';

    console.log(
      `${rpad(i + 1, 3)}  ${pad(fmtDate(s.candleDate), 16)}  ${pad(dir, 5)}  ` +
      `${rpad(s.entryPrice.toFixed(4), 10)}  ${rpad(s.stopLoss.toFixed(4), 10)}  ` +
      `${rpad(s.target1.toFixed(4), 10)}  ${rpad(s.risk.toFixed(4), 9)}  ` +
      `${pad(outcome, 20)}  ${rpad(pnlRStr, 8)}  ${rpad(pnlPtStr, 12)}`,
    );
  }

  // ── 5. Summary statistics ────────────────────────────────────────────────────
  const total  = results.length;
  const open   = results.filter((r) => r.outcome === 'OPEN').length;
  const closed = total - open;

  const sl   = results.filter((r) => r.outcome === 'FULL_SL').length;
  const tp1  = results.filter((r) => r.outcome === 'TP1_HIT').length;
  const tp2  = results.filter((r) => r.outcome === 'TP2_HIT').length;
  const tp3  = results.filter((r) => r.outcome === 'TP3_HIT').length;
  const tp4  = results.filter((r) => r.outcome === 'TP4_HIT').length;
  const tp5  = results.filter((r) => r.outcome === 'TP5_HIT').length;
  const nse  = results.filter((r) => r.outcome === 'NEXT_SIGNAL_EXIT').length;

  const wins = tp1 + tp2 + tp3 + tp4 + tp5 + results.filter(
    (r) => r.outcome === 'NEXT_SIGNAL_EXIT' && (r.pnlPts ?? 0) > 0,
  ).length;
  const losses = sl + results.filter(
    (r) => r.outcome === 'NEXT_SIGNAL_EXIT' && (r.pnlPts ?? 0) <= 0,
  ).length;

  const winRate = closed > 0 ? ((wins / closed) * 100).toFixed(1) : '–';

  const closedWithPnl = results.filter((r) => r.pnlR != null);
  const totalPnlR  = closedWithPnl.reduce((s, r) => s + (r.pnlR  ?? 0), 0);
  const totalPnlPt = closedWithPnl.reduce((s, r) => s + (r.pnlPts ?? 0), 0);
  const avgPnlR    = closedWithPnl.length > 0 ? totalPnlR / closedWithPnl.length : 0;

  // Per-direction breakdown
  const buyResults  = results.filter((r) => r.signal.signalType === 'BUY');
  const sellResults = results.filter((r) => r.signal.signalType === 'SELL');
  const calcDirStats = (rs: SignalResult[]) => {
    const c = rs.filter((r) => r.outcome !== 'OPEN');
    const w = c.filter(
      (r) =>
        r.outcome === 'TP1_HIT' ||
        r.outcome === 'TP2_HIT' ||
        r.outcome === 'TP3_HIT' ||
        r.outcome === 'TP4_HIT' ||
        r.outcome === 'TP5_HIT' ||
        (r.outcome === 'NEXT_SIGNAL_EXIT' && (r.pnlPts ?? 0) > 0),
    ).length;
    const wr = c.length > 0 ? ((w / c.length) * 100).toFixed(1) : '–';
    const pnl = rs.filter((r) => r.pnlR != null).reduce((s, r) => s + (r.pnlR ?? 0), 0);
    return { total: rs.length, closed: c.length, wins: w, wr, pnlR: +pnl.toFixed(4) };
  };
  const buyStats  = calcDirStats(buyResults);
  const sellStats = calcDirStats(sellResults);

  console.log('\n' + '━'.repeat(115));
  console.log(`\n  SUMMARY`);
  console.log(`  -------`);
  console.log(`  Total signals   : ${total}   (closed: ${closed}   open: ${open})`);
  console.log(`  FULL_SL         : ${sl}`);
  console.log(`  TP1_HIT         : ${tp1}`);
  console.log(`  TP2_HIT         : ${tp2}`);
  console.log(`  TP3_HIT         : ${tp3}`);
  console.log(`  TP4_HIT         : ${tp4}`);
  console.log(`  TP5_HIT         : ${tp5}`);
  console.log(`  NEXT_SIGNAL_EXIT: ${nse}   (${results.filter((r) => r.outcome === 'NEXT_SIGNAL_EXIT' && (r.pnlPts ?? 0) > 0).length} wins, ${results.filter((r) => r.outcome === 'NEXT_SIGNAL_EXIT' && (r.pnlPts ?? 0) <= 0).length} losses)`);
  console.log(`\n  Win Rate        : ${winRate}%   (wins=${wins}  losses=${losses}  of ${closed} closed)`);
  console.log(`  Total P&L       : ${fmtSign(+totalPnlR.toFixed(4))}R   (${fmtPts(+totalPnlPt.toFixed(4))} pts)`);
  console.log(`  Avg P&L / trade : ${fmtSign(+avgPnlR.toFixed(4))}R`);

  console.log(`\n  ── Direction Breakdown ──────────────────────────────`);
  console.log(`  BUY  signals : ${buyStats.total.toString().padStart(3)}  (closed ${buyStats.closed})  WinRate=${buyStats.wr}%  TotalP&L=${fmtSign(buyStats.pnlR)}R`);
  console.log(`  SELL signals : ${sellStats.total.toString().padStart(3)}  (closed ${sellStats.closed})  WinRate=${sellStats.wr}%  TotalP&L=${fmtSign(sellStats.pnlR)}R`);

  console.log(`\n  ── Outcome by TP Level ──────────────────────────────`);
  if (closed > 0) {
    console.log(`  TP1 hit rate  : ${((tp1 / closed) * 100).toFixed(1)}%   (${tp1}/${closed})`);
    console.log(`  TP2 hit rate  : ${((tp2 / closed) * 100).toFixed(1)}%   (${tp2}/${closed})`);
    console.log(`  TP3 hit rate  : ${((tp3 / closed) * 100).toFixed(1)}%   (${tp3}/${closed})`);
    console.log(`  TP4 hit rate  : ${((tp4 / closed) * 100).toFixed(1)}%   (${tp4}/${closed})`);
    console.log(`  TP5 hit rate  : ${((tp5 / closed) * 100).toFixed(1)}%   (${tp5}/${closed})`);
    console.log(`  SL  hit rate  : ${((sl  / closed) * 100).toFixed(1)}%   (${sl}/${closed})`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

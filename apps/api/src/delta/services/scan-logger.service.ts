import * as fs from 'fs';
import * as path from 'path';

/** Format a Date as IST (Asia/Kolkata, UTC+05:30) for readable log output. */
function toIST(d: Date): string {
  return (
    d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') +
    '+05:30'
  );
}

/**
 * Writes a candle-by-candle scan log to
 *   apps/api/logs/trade-scan-<symbol>-<strategy>-<YYYY-MM-DD>.log
 *
 * Each scanned candle produces one line in the log so you can clearly see:
 *  - every candle's OHLCV + indicator values
 *  - which setup checks ran and why they passed or failed
 *  - which signal (if any) was emitted
 */
export class ScanLogger {
  private readonly filePath: string;
  private readonly fd: number;

  constructor(symbol: string, strategy: string) {
    const dir = path.resolve(
      'D:/Work/My-Work/trading/auto-trade/docs/deltaexchange',
    );
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const date = toIST(now).slice(0, 10); // YYYY-MM-DD in IST
    const name = `trade-scan-${symbol.replace('/', '-')}-${strategy}-${date}.log`;
    this.filePath = path.join(dir, name);

    // Open append so re-runs accumulate in the same daily file
    this.fd = fs.openSync(this.filePath, 'a');
    this.write(
      `\n${'='.repeat(80)}\n` +
        `SCAN START  symbol=${symbol}  strategy=${strategy}  at=${toIST(now)}\n` +
        `${'='.repeat(80)}\n`,
    );
  }

  /** Log a single evaluated candle with its indicator state and signal result. */
  logCandle(entry: {
    idx: number;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    ema20?: number | null;
    ema9?: number | null;
    ema21?: number | null;
    rsi?: number | null;
    atr?: number | null;
    htfBias?: string | null;
    checks?: Record<string, string>; // e.g. { trendPullback: 'SKIP – prev.low too far', ... }
    signal?: string | null; // 'BUY – <reason>' | 'SELL – <reason>' | null
  }): void {
    const c = entry;
    const price = `O=${c.open} H=${c.high} L=${c.low} C=${c.close}${c.volume != null ? ` V=${c.volume}` : ''}`;

    const indicators: string[] = [];
    if (c.ema9 != null) indicators.push(`EMA9=${c.ema9.toFixed(4)}`);
    if (c.ema21 != null) indicators.push(`EMA21=${c.ema21.toFixed(4)}`);
    if (c.ema20 != null) indicators.push(`EMA20=${c.ema20.toFixed(4)}`);
    if (c.rsi != null) indicators.push(`RSI=${c.rsi.toFixed(2)}`);
    if (c.atr != null) indicators.push(`ATR=${c.atr.toFixed(6)}`);
    if (c.htfBias) indicators.push(`HTF=${c.htfBias}`);

    const header = `[${c.idx.toString().padStart(4, '0')}] ${c.time}  ${price}  ${indicators.join('  ')}`;

    const lines: string[] = [header];

    if (c.checks) {
      for (const [name, result] of Object.entries(c.checks)) {
        lines.push(`        ${name.padEnd(20)} ${result}`);
      }
    }

    if (c.signal) {
      lines.push(`        >>> SIGNAL: ${c.signal}`);
    }

    this.write(lines.join('\n') + '\n');
  }

  /** Write summary totals at end of scan. */
  logSummary(totalCandles: number, totalSignals: number): void {
    this.write(
      `\n--- SCAN END  totalCandles=${totalCandles}  signals=${totalSignals}  at=${toIST(new Date())} ---\n`,
    );
  }

  /**
   * Append trade simulation P&L summary to the log file after simulation
   * completes (called after close(), uses appendFileSync).
   */
  logPnlSummary(
    results: Array<{
      outcome: string;
      pnlPoints: number | null;
      setupType: string;
    }>,
  ): void {
    if (results.length === 0) return;

    const outcomeGroups = new Map<string, number>();
    const setupGroups = new Map<string, { wins: number; losses: number; open: number; pnl: number }>();
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let open = 0;

    for (const r of results) {
      const o = r.outcome ?? 'OPEN';
      outcomeGroups.set(o, (outcomeGroups.get(o) ?? 0) + 1);

      const isWin = r.pnlPoints != null && r.pnlPoints > 0;
      const isLoss = r.pnlPoints != null && r.pnlPoints < 0;
      if (isWin) wins++;
      else if (isLoss) losses++;
      else open++;
      if (r.pnlPoints != null) totalPnl += r.pnlPoints;

      const sg = setupGroups.get(r.setupType) ?? { wins: 0, losses: 0, open: 0, pnl: 0 };
      if (isWin) sg.wins++;
      else if (isLoss) sg.losses++;
      else sg.open++;
      if (r.pnlPoints != null) sg.pnl += r.pnlPoints;
      setupGroups.set(r.setupType, sg);
    }

    const n = results.length;
    const winRate = ((wins / n) * 100).toFixed(1);
    const avgPnl = (totalPnl / n).toFixed(4);

    const lines: string[] = [
      '',
      '═'.repeat(80),
      'SIMULATION P&L SUMMARY',
      '═'.repeat(80),
      `Trades: ${n}  Wins: ${wins}  Losses: ${losses}  Open: ${open}`,
      `WinRate: ${winRate}%  TotalPnL: ${totalPnl.toFixed(4)} pts  AvgPnL: ${avgPnl} pts`,
      '',
      'Outcome Breakdown:',
    ];
    for (const [outcome, count] of [...outcomeGroups.entries()].sort()) {
      lines.push(`  ${outcome.padEnd(32)} ${count}`);
    }
    lines.push('');
    lines.push('By Setup Type:');
    for (const [setup, sg] of [...setupGroups.entries()].sort()) {
      const total = sg.wins + sg.losses + sg.open;
      const wr = total > 0 ? ((sg.wins / total) * 100).toFixed(1) : '0.0';
      lines.push(`  ${setup.padEnd(20)}  W:${sg.wins} L:${sg.losses} O:${sg.open}  WR:${wr}%  PnL:${sg.pnl.toFixed(4)}`);
    }
    lines.push('═'.repeat(80));
    lines.push('');

    this.write(lines.join('\n'));
  }

  /** Write raw text directly to the log file (used by ANALYZE_DATA strategy). */
  writeRaw(text: string): void {
    this.write(text);
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }

  get logFilePath(): string {
    return this.filePath;
  }

  private write(text: string): void {
    fs.writeSync(this.fd, text);
  }
}

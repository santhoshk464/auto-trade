import * as fs from 'fs';
import * as path from 'path';

/**
 * Returns a timestamp string for the current second.
 * Called fresh on every diagLog invocation so that each simulation run
 * (which completes within a second) writes to its own file, even when
 * the server process is long-running and modules are cached.
 *
 * Format: YYYY-MM-DD_HH-MM-SS  (filesystem-safe, chronologically sortable)
 * Example: 2026-03-22_14-55-09
 */
/** Target date (YYYY-MM-DD) set by the strategy before logging begins. */
let _targetDate = '';

/**
 * Call this at the start of each strategy run with the date of the candles
 * being analysed.  The date is embedded in the log filename so that
 * historical back-test runs produce files named after the target date
 * rather than today.
 */
export function setDiagTargetDate(date: string): void {
  _targetDate = date;
}

function currentRunTimestamp(): string {
  const d = new Date();
  const date = _targetDate || d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5).replace(/:/g, '-'); // 14-55
  return `${date}_${time}`;
}

/** Absolute path to the docs/logs directory. */
const LOGS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'logs',
);

/**
 * Appends a single JSON log line to a timestamped file in docs/logs/.
 *
 * @param logName  Base name for the log file (e.g. "ema-rejection-diag").
 *                 The final filename will be `<logName>-<RUN_TIMESTAMP>.log`.
 * @param tag      Log tag string (e.g. "[EMA-REJ-SIGNAL]").
 * @param data     Arbitrary object — serialised as JSON on one line.
 */
export function diagLog(logName: string, tag: string, data: object): void {
  const logFile = path.join(
    LOGS_DIR,
    `${logName}-${currentRunTimestamp()}.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore — never crash the caller over a missing log */
  }
}

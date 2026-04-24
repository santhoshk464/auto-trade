import * as fs from 'fs';
import * as path from 'path';

/** Target date (YYYY-MM-DD) used in log filenames — set by strategy runs. */
let _targetDate = '';

export function setDiagTargetDate(date: string): void {
  _targetDate = date;
}

export function diagLog(version: string, tag: string, data: object): void {
  const dateStr = _targetDate || new Date().toISOString().slice(0, 10);
  const logFile = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'logs',
    `${version}-strategy-diag-${dateStr}.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore */
  }
}

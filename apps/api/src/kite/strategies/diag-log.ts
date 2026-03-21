import * as fs from 'fs';
import * as path from 'path';

export function diagLog(version: string, tag: string, data: object): void {
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
    `${version}-strategy-diag-${new Date().toISOString().slice(0, 10)}.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * Standalone PATTERN_SIGNAL scan — runs findTradeSignals without HTTP/auth.
 * Usage:  npx ts-node -P tsconfig.json scan-pattern-signal.ts [fromDate] [toDate]
 * Example: npx ts-node -P tsconfig.json scan-pattern-signal.ts 2026-01-01 2026-03-25
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { DeltaService } from './src/delta/services/delta.service';

async function main() {
  const from = process.argv[2] || '2026-01-01';
  const to   = process.argv[3] || '2026-03-25';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const svc = app.get(DeltaService);

  console.log(`\n📡 Running PATTERN_SIGNAL scan  SOLUSD  ${from} → ${to}\n`);

  const signals = await svc.findTradeSignals(
    'SOLUSD', '5m', from, to, 'PATTERN_SIGNAL',
  );

  await app.close();

  if (!signals.length) {
    console.log('No signals found.');
    return;
  }

  // ── EmaBreakout detail ───────────────────────────────────────────────────────
  const breakouts = signals.filter(s => s.setupType === 'EmaBreakoutLong' || s.setupType === 'EmaBreakoutShort');
  if (breakouts.length) {
    console.log('── EmaBreakout Signals ─────────────────────────────────────────');
    for (const s of breakouts) {
      const dir = s.type === 'BUY' ? '▲ LONG' : '▼ SHORT';
      const pnl = s.pnlPoints != null ? `${s.pnlPoints >= 0 ? '+' : ''}${s.pnlPoints.toFixed(2)}pts` : 'OPEN';
      console.log(`  ${dir.padEnd(8)} ${s.time}  entry=${s.price}  SL=${s.stopLoss}  outcome=${(s.outcome ?? 'OPEN').padEnd(20)}  ${pnl}`);
    }
  }

  // ── Summary by setup type ───────────────────────────────────────────────────
  const bySetup: Record<string, { total: number; wins: number; losses: number; be: number; open: number; pnl: number }> = {};
  for (const s of signals) {
    const st = s.setupType || 'Unknown';
    if (!bySetup[st]) bySetup[st] = { total: 0, wins: 0, losses: 0, be: 0, open: 0, pnl: 0 };
    const r = bySetup[st];
    r.total++;
    r.pnl += s.pnlPoints ?? 0;
    if (s.outcome === 'FULL_SL') r.losses++;
    else if (s.outcome === 'OPEN') r.open++;
    else if (s.outcome === 'BE' || s.outcome === 'PARTIAL_BE') r.be++;
    else r.wins++;  // RUNNER_EXIT_*, MAX_TARGET_HIT
  }

  const totPnl = signals.reduce((acc, x) => acc + (x.pnlPoints ?? 0), 0);

  console.log(`\nTotal signals: ${signals.length}`);
  console.log('── Setup Breakdown ─────────────────────────────────────────────');
  for (const [st, r] of Object.entries(bySetup).sort((a, b) => b[1].total - a[1].total)) {
    const closed = r.total - r.open;
    const wr = closed > 0 ? ((r.wins / closed) * 100).toFixed(0) : '–';
    console.log(`  ${st.padEnd(22)}  total=${String(r.total).padStart(3)}  W=${r.wins}  L=${r.losses}  BE=${r.be}  open=${r.open}  winRate=${wr}%  pnl=${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}pts`);
  }
  console.log(`\n  TOTAL PnL: ${totPnl >= 0 ? '+' : ''}${totPnl.toFixed(2)} pts`);
}

main().catch((e) => { console.error(e); process.exit(1); });


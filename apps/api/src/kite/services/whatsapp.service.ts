import { Injectable, Logger } from '@nestjs/common';
import Twilio from 'twilio';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly client: ReturnType<typeof Twilio> | null = null;
  private readonly from: string;
  private readonly to: string;
  private readonly enabled: boolean;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.from = process.env.TWILIO_WHATSAPP_FROM ?? '';
    this.to = process.env.TWILIO_WHATSAPP_TO ?? '';

    if (accountSid && authToken && this.from && this.to) {
      this.client = Twilio(accountSid, authToken);
      this.enabled = true;
      this.logger.log('✅ WhatsApp notifications enabled via Twilio');
    } else {
      this.enabled = false;
      this.logger.warn(
        '⚠️  WhatsApp notifications disabled — TWILIO_* env vars not set',
      );
    }
  }

  // Parse score value from reason string like "[DHR] ... | score=10 @ ₹85.50"
  private parseScore(reason: string): number | null {
    const match = reason.match(/score=(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  private scoreToGrade(score: number): string {
    if (score >= 10) return 'A+';
    if (score >= 6) return 'A';
    if (score >= 3) return 'B';
    return 'C';
  }

  async sendSignalAlert(params: {
    optionSymbol: string;
    entry: number;
    stopLoss: number;
    target: number;
    reason: string;
    strategy: string;
    time: string;
    optionType: string;
    qty?: number;
    lotSize?: number;
    score?: number;
    direction?: string;
  }): Promise<void> {
    if (!this.enabled || !this.client) return;

    const {
      optionSymbol,
      entry,
      stopLoss,
      target,
      reason,
      strategy,
      time,
      optionType,
      qty,
      lotSize,
    } = params;
    const slPoints = Math.abs(stopLoss - entry).toFixed(1);
    const targetPoints = Math.abs(target - entry).toFixed(1);
    const emoji = optionType === 'PE' ? '🔴' : '🟢';
    const direction = params.direction ?? 'SELL';

    // Use explicit score if provided, otherwise parse from reason string
    const score = params.score ?? this.parseScore(reason);
    const grade = score !== null ? this.scoreToGrade(score) : null;
    const effectiveLotSize = lotSize || 75;
    const lots = qty ? Math.floor(qty / effectiveLotSize) : null;

    // Strip " | score=X @ ₹Y" suffix from reason before displaying
    const displayReason = reason
      .replace(/\s*\|\s*score=\d+\s*@\s*₹[\d.]+/, '')
      .trim();

    const scoreLine =
      score !== null ? `⭐ Score: ${score}/10 (Grade ${grade})` : '';
    const qtyLine =
      qty && lots !== null
        ? `📦 Qty: ${qty} (${lots} lot${lots !== 1 ? 's' : ''})`
        : '';

    const extraLines = [scoreLine, qtyLine].filter(Boolean).join('\n');

    const body =
      `🚨 *SIGNAL ALERT — ${strategy}*\n\n` +
      `${emoji} Symbol: *${optionSymbol}*\n` +
      `📊 Action: *${direction} ${optionType}*\n` +
      `📍 Entry: ₹${entry.toFixed(2)}\n` +
      `🛑 SL: ₹${stopLoss.toFixed(2)} (${slPoints} pts)\n` +
      `🎯 Target: ₹${target.toFixed(2)} (${targetPoints} pts)\n` +
      `📋 Reason: ${displayReason}\n` +
      `🕐 Time: ${time}` +
      (extraLines ? `\n${extraLines}` : '');

    await this.send(body);
  }

  async sendTradeClosedAlert(params: {
    optionSymbol: string;
    status: 'TARGET_HIT' | 'T1_HIT' | 'SL_HIT' | 'BE_HIT';
    exitPrice: number;
    entryPrice: number;
    pnl: number | null;
    qty: number;
    strategy: string;
    /** Trade direction — BUY (long option) or SELL (short option). */
    direction?: 'BUY' | 'SELL';
  }): Promise<void> {
    if (!this.enabled || !this.client) return;

    const {
      optionSymbol,
      status,
      exitPrice,
      entryPrice,
      pnl,
      qty,
      strategy,
      direction,
    } = params;
    const isT1 = status === 'T1_HIT';
    const isTarget = status === 'TARGET_HIT';
    const isBE = status === 'BE_HIT';
    const isSL = status === 'SL_HIT';

    // Direction emoji: 🟢 BUY (long), 🔴 SELL (short)
    const dirEmoji =
      direction === 'BUY' ? '🟢' : direction === 'SELL' ? '🔴' : '';
    const dirLabel = direction ? ` (${direction})` : '';

    const header = isT1
      ? `✅ *1:1 TARGET HIT!* ${dirEmoji}`
      : isTarget
        ? `🎯 *TARGET HIT!* ${dirEmoji}`
        : isBE
          ? `⚖️ *BREAKEVEN HIT!* ${dirEmoji}`
          : `🛑 *STOP LOSS HIT!* ${dirEmoji}`;
    const pnlText =
      pnl !== null ? `${pnl >= 0 ? '✅' : '❌'} P&L: ₹${pnl.toFixed(2)}` : '';

    // For SELL trades the SL exit is above entry — add a note so it's not confusing.
    const slNote =
      isSL && direction === 'SELL' && exitPrice > entryPrice
        ? `💡 Short trade: price rose to SL → closed at loss\n`
        : '';

    const body =
      `${header}\n\n` +
      `📌 Symbol: *${optionSymbol}*${dirLabel}\n` +
      `📍 Entry: ₹${entryPrice.toFixed(2)}\n` +
      `🏁 Exit: ₹${exitPrice.toFixed(2)}\n` +
      `📦 Qty: ${qty}\n` +
      (pnlText ? `${pnlText}\n` : '') +
      slNote +
      `📊 Strategy: ${strategy}`;

    await this.send(body);
  }

  async send1to1Alert(params: {
    optionSymbol: string;
    entryPrice: number;
    targetPrice: number;
    strategy: string;
  }): Promise<void> {
    if (!this.enabled || !this.client) return;

    const { optionSymbol, entryPrice, targetPrice, strategy } = params;
    const profit = Math.abs(entryPrice - targetPrice).toFixed(1);

    const body =
      `✅ *1:1 LEVEL REACHED!*\n\n` +
      `📌 Symbol: *${optionSymbol}*\n` +
      `📍 Entry: ₹${entryPrice.toFixed(2)}\n` +
      `🎯 1:1 Level: ₹${targetPrice.toFixed(2)} (+${profit} pts)\n` +
      `💡 Consider trailing SL to entry (breakeven)\n` +
      `📊 Strategy: ${strategy}`;

    await this.send(body);
  }

  /**
   * LTP-based signal-level notification (WebSocket).
   * Sent when LTP crosses the 1:1, Target, or SL level derived from a saved signal.
   * Distinct from sendTradeClosedAlert() which fires on actual order fills.
   */
  async sendSignalLevelAlert(params: {
    optionSymbol: string;
    level: 'ONE_TO_ONE' | 'TARGET' | 'STOP_LOSS';
    ltp: number;
    entryPrice: number;
    strategy: string;
    direction: 'SELL' | 'BUY';
    qty?: number;
    oneToOneLevel?: number;
  }): Promise<void> {
    if (!this.enabled || !this.client) return;

    const {
      optionSymbol,
      level,
      ltp,
      entryPrice,
      strategy,
      direction,
      qty,
      oneToOneLevel,
    } = params;
    const pnlPts = direction === 'SELL' ? entryPrice - ltp : ltp - entryPrice;
    const pnlPtsStr = `${pnlPts >= 0 ? '+' : ''}${pnlPts.toFixed(1)} pts`;
    const pnlRupees =
      qty != null && qty > 0 ? (pnlPts * qty).toFixed(2) : null;
    const pnlEmoji = pnlPts >= 0 ? '✅' : '❌';

    const headers: Record<string, string> = {
      ONE_TO_ONE: `✅ *1:1 LEVEL REACHED!*`,
      TARGET: `🎯 *TARGET HIT!* 🟢`,
      STOP_LOSS: `🛑 *STOP LOSS HIT!* 🔴`,
    };

    let body =
      `${headers[level]}\n\n` +
      `📌 Symbol: *${optionSymbol}* (${direction})\n` +
      `📍 Entry: ₹${entryPrice.toFixed(2)}\n`;

    if (level === 'ONE_TO_ONE' && oneToOneLevel != null) {
      body +=
        `🎯 1:1 Level: ₹${oneToOneLevel.toFixed(2)} (+${Math.abs(pnlPts).toFixed(1)} pts)\n` +
        `💡 Consider trailing SL to entry (breakeven)\n`;
    } else {
      body += `🏁 Exit: ₹${ltp.toFixed(2)}\n`;
      if (qty != null && qty > 0) {
        body += `📦 Qty: ${qty}\n`;
      }
      body += `${pnlEmoji} P&L: ${pnlRupees != null ? `₹${pnlRupees}` : pnlPtsStr}\n`;
    }

    body += `📊 Strategy: ${strategy}`;

    await this.send(body);
  }

  /**
   * AI Advisor update — sent every 1 min and 5 min while a trade is active.
   */
  async sendAdvisorUpdate(params: {
    interval: '1-MIN' | '5-MIN';
    trade: {
      optionSymbol: string;
      direction: 'SELL' | 'BUY';
      strategy: string;
      entryPrice: number;
      slPrice: number;
      targetPrice: number;
    };
    verdict: {
      action: 'HOLD' | 'CAUTION' | 'EXIT_WARNING';
      confidence: number;
      reasons: string[];
      oiTrend: string;
      oiVelocitySpike: boolean;
      orderBookFlipped: boolean;
      absorptionDetected: boolean;
      pcr: number | null;
      pcrTrend: string;
      latestOI: number;
      latestLTP: number;
    };
  }): Promise<void> {
    if (!this.enabled || !this.client) return;

    const { interval, trade, verdict } = params;
    const { action, confidence, reasons, pcr, pcrTrend, latestOI, latestLTP } =
      verdict;

    const actionEmoji =
      action === 'HOLD' ? '✅' : action === 'CAUTION' ? '⚠️' : '🚨';
    const dirEmoji = trade.direction === 'SELL' ? '🔴' : '🟢';
    const istTime = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
    const pnlPts =
      trade.direction === 'SELL'
        ? trade.entryPrice - latestLTP
        : latestLTP - trade.entryPrice;
    const pnlStr = `${pnlPts >= 0 ? '+' : ''}${pnlPts.toFixed(1)} pts`;
    const pcrStr = pcr !== null ? `${pcr.toFixed(2)} (${pcrTrend})` : 'N/A';
    const reasonLines = reasons.map((r) => `  • ${r}`).join('\n');
    const flags = [
      verdict.oiVelocitySpike ? '⚡ OI Velocity Spike' : null,
      verdict.orderBookFlipped ? '📗 Order Book Flipped' : null,
      verdict.absorptionDetected ? '🧲 Absorption Detected' : null,
    ]
      .filter(Boolean)
      .join(' | ');

    const body =
      `${actionEmoji} *[${interval} ADVISOR] ${trade.optionSymbol}* ${dirEmoji}\n` +
      `🕐 ${istTime} | Strategy: ${trade.strategy}\n\n` +
      `📈 LTP: ₹${latestLTP.toFixed(2)} | P&L: ${pnlStr}\n` +
      `📊 OI: ${latestOI.toLocaleString()} | PCR: ${pcrStr}\n` +
      (flags ? `🔔 ${flags}\n` : '') +
      `\n📋 *Analysis:*\n${reasonLines}\n\n` +
      `${actionEmoji} *Verdict: ${action}* (confidence: ${confidence}%)\n` +
      `📍 Entry: ₹${trade.entryPrice.toFixed(2)} | SL: ₹${trade.slPrice.toFixed(2)} | Target: ₹${trade.targetPrice.toFixed(2)}`;

    await this.send(body);
  }

  private async send(body: string): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      const message = await this.client.messages.create({
        from: this.from,
        to: this.to,
        body,
      });
      this.logger.log(`📲 WhatsApp sent: ${message.sid}`);
    } catch (err: any) {
      const code = err.code ?? err.status ?? 'unknown';
      // Twilio sandbox expiry: code 63016 (not opted in) or 63018 (blocked).
      // Also match on message text for cases where code is missing.
      const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
      const isSandboxExpired =
        err.code === 63016 ||
        err.code === 63018 ||
        msg.includes('not opted in') ||
        msg.includes('sandbox') ||
        msg.includes('not joined') ||
        msg.includes('blocked');

      this.logger.error(
        `❌ WhatsApp send failed [code=${code}]: ${err.message}`,
      );

      if (isSandboxExpired) {
        this.logger.error(
          '⚠️  Twilio sandbox session likely expired — recipient must re-join by sending "join <sandbox-code>" to +14155238886 on WhatsApp',
        );
      }
    }
  }
}

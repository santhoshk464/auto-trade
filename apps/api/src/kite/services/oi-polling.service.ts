import { Injectable, Logger } from '@nestjs/common';
import { KiteConnect } from 'kiteconnect';
import { PrismaService } from '../../prisma/prisma.service';

export interface OISnapshotData {
  symbol: string;
  strike: number;
  expiryDate: string;
  ceOI: number;
  peOI: number;
  pcr: number;
  ceLTP: number;
  peLTP: number;
  timestamp: Date;
}

/** Active strike being polled — registered when a trade/signal is active */
interface PolledStrike {
  brokerId: string;
  symbol: string;
  strike: number;
  expiryDate: string;
  ceTradingsymbol: string;
  peTradingsymbol: string;
}

@Injectable()
export class OiPollingService {
  private readonly logger = new Logger(OiPollingService.name);

  // symbol_strike_expiry → polled strike config
  private readonly polledStrikes = new Map<string, PolledStrike>();

  // symbol_strike_expiry → latest OI snapshot (in-memory cache)
  private readonly latestSnapshots = new Map<string, OISnapshotData>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a strike to be polled every 5 minutes.
   * Called when a live trade or active signal is being watched.
   */
  registerStrike(params: {
    brokerId: string;
    symbol: string;
    strike: number;
    expiryDate: string;
    ceTradingsymbol: string;
    peTradingsymbol: string;
  }): void {
    const key = this.strikeKey(params.symbol, params.strike, params.expiryDate);
    if (!this.polledStrikes.has(key)) {
      this.polledStrikes.set(key, params);
      this.logger.log(
        `📊 OI polling registered: ${params.symbol} ${params.strike} (${params.expiryDate})`,
      );
    }
  }

  unregisterStrike(symbol: string, strike: number, expiryDate: string): void {
    const key = this.strikeKey(symbol, strike, expiryDate);
    this.polledStrikes.delete(key);
    this.logger.log(`📊 OI polling stopped: ${symbol} ${strike}`);
  }

  /** Get the latest in-memory OI snapshot for a strike (instant, no DB call) */
  getLatestSnapshot(
    symbol: string,
    strike: number,
    expiryDate: string,
  ): OISnapshotData | undefined {
    return this.latestSnapshots.get(this.strikeKey(symbol, strike, expiryDate));
  }

  /**
   * Poll all registered strikes via Kite Quote API.
   * Called by AdvisorSchedulerService every 5 minutes during market hours.
   */
  async pollAll(): Promise<void> {
    if (this.polledStrikes.size === 0) return;

    const now = new Date();
    const tradeDate = now.toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });

    for (const [key, strike] of this.polledStrikes) {
      try {
        await this.pollStrike(strike, tradeDate, now);
      } catch (err: any) {
        this.logger.warn(`OI poll failed for ${key}: ${err.message}`);
      }
    }
  }

  /** Get today's OI snapshot history for a strike from DB */
  async getTodaySnapshots(
    symbol: string,
    strike: number,
    expiryDate: string,
  ): Promise<OISnapshotData[]> {
    const tradeDate = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const rows = await this.prisma.oiSnapshot.findMany({
      where: { symbol, strike, expiryDate, tradeDate },
      orderBy: { timestamp: 'asc' },
    });
    return rows.map((r) => ({
      symbol: r.symbol,
      strike: r.strike,
      expiryDate: r.expiryDate,
      ceOI: r.ceOI,
      peOI: r.peOI,
      pcr: r.pcr,
      ceLTP: r.ceLTP,
      peLTP: r.peLTP,
      timestamp: r.timestamp,
    }));
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async pollStrike(
    config: PolledStrike,
    tradeDate: string,
    now: Date,
  ): Promise<void> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: config.brokerId },
    });
    if (!broker?.accessToken || !broker?.apiKey) return;

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    const ceKey = `NFO:${config.ceTradingsymbol}`;
    const peKey = `NFO:${config.peTradingsymbol}`;

    const quotes = await kc.getQuote([ceKey, peKey]);

    const ceQuote = quotes[ceKey];
    const peQuote = quotes[peKey];
    if (!ceQuote || !peQuote) return;

    const ceOI = ceQuote.oi ?? 0;
    const peOI = peQuote.oi ?? 0;
    const pcr = ceOI > 0 ? peOI / ceOI : 0;
    const ceLTP = ceQuote.last_price ?? 0;
    const peLTP = peQuote.last_price ?? 0;

    const snap: OISnapshotData = {
      symbol: config.symbol,
      strike: config.strike,
      expiryDate: config.expiryDate,
      ceOI,
      peOI,
      pcr,
      ceLTP,
      peLTP,
      timestamp: now,
    };

    // Update in-memory cache
    const key = this.strikeKey(config.symbol, config.strike, config.expiryDate);
    this.latestSnapshots.set(key, snap);

    // Persist to DB
    await this.prisma.oiSnapshot.create({
      data: { ...snap, tradeDate },
    });

    this.logger.log(
      `📊 OI polled: ${config.symbol} ${config.strike} | CE OI: ${ceOI.toLocaleString()} | PE OI: ${peOI.toLocaleString()} | PCR: ${pcr.toFixed(2)}`,
    );
  }

  private strikeKey(
    symbol: string,
    strike: number,
    expiryDate: string,
  ): string {
    return `${symbol}_${strike}_${expiryDate}`;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { KiteConnect } from 'kiteconnect';
import { PrismaService } from '../../prisma/prisma.service';
import { PaperTradingService } from '../../paper-trading/services/paper-trading.service';
import { SignalsService } from './signals.service';
import { IndicatorsService } from './indicators.service';
import {
  parseTimeToMinutes,
  parseSignalTimeToDate,
} from '../helpers/kite.helpers';
import { detectDayHighRejectionOnly } from '../strategies/day-high-rejection.strategy';
import { detectDayLowBreakOnly } from '../strategies/day-low-break.strategy';
import {
  detectDaySellSignals,
  type DaySellSignal,
} from '../strategies/day-selling-v1.strategy';
import { detectDaySellSignalsV2 } from '../strategies/day-selling-v2.strategy';
import { detectDaySellSignalsCombined } from '../strategies/day-selling-combined.strategy';
import { detectDaySellSignalsV3 } from '../strategies/day-selling-v3.strategy';
import { detectDaySellSignalsV4 } from '../strategies/day-selling-v4.strategy';
import { detectDaySellSignalsV2Enhanced } from '../strategies/day-selling-v2-enhanced.strategy';
import { executeTrendNiftyStrategy } from '../strategies/trend-nifty.strategy';

type KiteInstrument = {
  instrument_token: number;
  exchange_token: number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string; // YYYY-MM-DD or empty
  strike: number;
  tick_size: number;
  lot_size: number;
  instrument_type: string; // CE, PE, FUT, EQ
  segment: string; // NFO, NSE, BSE, etc.
  exchange: string; // NSE, BSE, NFO, etc.
};

@Injectable()
export class KiteService {
  private readonly logger = new Logger(KiteService.name);
  private instrumentsCache: KiteInstrument[] = [];
  private cacheExpiry = 0;

  constructor(
    private prisma: PrismaService,
    private paperTradingService: PaperTradingService,
    private signalsService: SignalsService,
    private indicators: IndicatorsService,
  ) {}

  /**
   * Fetch Kite instruments CSV and parse into objects.
   * Cached for 24 hours.
   */
  async getInstruments(): Promise<KiteInstrument[]> {
    const now = Date.now();
    if (this.instrumentsCache.length > 0 && now < this.cacheExpiry) {
      return this.instrumentsCache;
    }

    try {
      const url = 'https://api.kite.trade/instruments';
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch instruments: ${res.statusText}`);
      }

      const text = await res.text();
      const lines = text.trim().split('\n');
      if (lines.length === 0) {
        throw new Error('Empty instruments CSV');
      }

      const header = lines[0].split(',');
      const instruments: KiteInstrument[] = [];

      for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length < header.length) continue;

        instruments.push({
          instrument_token: parseInt(row[0] || '0', 10),
          exchange_token: parseInt(row[1] || '0', 10),
          tradingsymbol: row[2] || '',
          name: row[3] || '',
          last_price: parseFloat(row[4] || '0'),
          expiry: row[5] || '',
          strike: parseFloat(row[6] || '0'),
          tick_size: parseFloat(row[7] || '0'),
          lot_size: parseInt(row[8] || '0', 10),
          instrument_type: row[9] || '',
          segment: row[10] || '',
          exchange: row[11] || '',
        });
      }

      this.instrumentsCache = instruments;
      this.cacheExpiry = now + 24 * 60 * 60 * 1000; // 24 hours
      this.logger.log(
        `Loaded ${instruments.length} instruments from Kite (cached for 24h)`,
      );

      return instruments;
    } catch (err: any) {
      this.logger.error('Failed to fetch Kite instruments', err.stack);
      // Return stale cache if available
      if (this.instrumentsCache.length > 0) {
        this.logger.warn('Using stale instruments cache');
        return this.instrumentsCache;
      }
      throw err;
    }
  }

  /**
   * Get expiry dates for a given symbol (e.g., NIFTY, BANKNIFTY) in Options or Futures segment.
   */
  async getExpiryDates(
    exchange: string,
    symbol: string,
    segment?: string,
  ): Promise<{ expiries: string[] }> {
    const instruments = await this.getInstruments();

    const expiries = new Set<string>();

    // Map to derivatives exchange: NSE -> NFO, BSE -> BFO
    const targetExchange =
      exchange === 'NSE' ? 'NFO' : exchange === 'BSE' ? 'BFO' : exchange;

    this.logger.debug(
      `Looking for expiries: exchange=${exchange}, symbol=${symbol}, segment=${segment}, targetExchange=${targetExchange}`,
    );

    // Debug: Find any instrument that contains the symbol
    const sample = instruments.find((i) => i.tradingsymbol.includes(symbol));
    if (sample) {
      this.logger.debug(
        `Sample instrument: ${JSON.stringify({
          tradingsymbol: sample.tradingsymbol,
          segment: sample.segment,
          exchange: sample.exchange,
          instrument_type: sample.instrument_type,
          expiry: sample.expiry,
        })}`,
      );
    }

    let matchCount = 0;
    for (const inst of instruments) {
      // Match segment: NFO-OPT for options, NFO-FUT for futures, or just segment starts with targetExchange
      const segmentMatch =
        inst.segment === targetExchange ||
        inst.segment === `${targetExchange}-OPT` ||
        inst.segment === `${targetExchange}-FUT` ||
        inst.segment.startsWith(targetExchange);

      // For Options: CE or PE, For Futures: FUT
      const instrumentTypeMatch =
        segment === 'Futures'
          ? inst.instrument_type === 'FUT'
          : inst.instrument_type === 'CE' || inst.instrument_type === 'PE';

      if (
        segmentMatch &&
        inst.tradingsymbol.startsWith(symbol) &&
        inst.expiry &&
        instrumentTypeMatch
      ) {
        // Convert expiry to YYYY-MM-DD string format
        let expiryStr = inst.expiry;
        if (typeof expiryStr === 'object' && expiryStr !== null) {
          expiryStr = (expiryStr as any).toISOString().split('T')[0];
        }
        expiries.add(expiryStr);
        matchCount++;
      }
    }

    this.logger.debug(
      `Found ${matchCount} matching instruments, ${expiries.size} unique expiries`,
    );

    const sorted = Array.from(expiries).sort();
    return { expiries: sorted };
  }

  /**
   * Get available (non-expired) expiry dates for backtesting.
   * Only returns expiries that are currently active in Kite's instruments list.
   */
  async getAvailableExpiries(symbol: string): Promise<{ expiries: string[] }> {
    const instruments = await this.getInstruments();
    const exchange = symbol === 'SENSEX' ? 'BFO' : 'NFO';
    const expiries = new Set<string>();

    this.logger.log(
      `Getting available expiries for ${symbol} from ${exchange} exchange`,
    );

    for (const inst of instruments) {
      // Strip quotes from name field (e.g., "NIFTY" -> NIFTY)
      let instName = inst.name;
      if (instName && instName.startsWith('"') && instName.endsWith('"')) {
        instName = instName.slice(1, -1);
      }

      if (
        instName === symbol &&
        inst.exchange === exchange &&
        (inst.instrument_type === 'CE' || inst.instrument_type === 'PE') &&
        inst.expiry
      ) {
        let expiryStr = inst.expiry;
        if (typeof expiryStr === 'object' && expiryStr !== null) {
          expiryStr = (expiryStr as any).toISOString().split('T')[0];
        }
        expiries.add(expiryStr);
      }
    }

    const sorted = Array.from(expiries).sort();
    this.logger.log(`Found ${sorted.length} available expiries for ${symbol}`);
    return { expiries: sorted };
  }

  /**
   * Get available strike prices for a symbol + expiry.
   */
  async getStrikes(
    exchange: string,
    symbol: string,
    expiry: string,
  ): Promise<{ strikes: number[] }> {
    const instruments = await this.getInstruments();

    const strikes = new Set<number>();

    // Map to derivatives exchange: NSE -> NFO, BSE -> BFO
    const targetExchange =
      exchange === 'NSE' ? 'NFO' : exchange === 'BSE' ? 'BFO' : exchange;

    this.logger.debug(
      `Looking for strikes: exchange=${exchange}, symbol=${symbol}, expiry=${expiry}, targetExchange=${targetExchange}`,
    );

    let matchCount = 0;
    for (const inst of instruments) {
      // Match segment: NFO-OPT/BFO-OPT for options, NFO-FUT/BFO-FUT for futures
      const segmentMatch =
        inst.segment === targetExchange ||
        inst.segment === `${targetExchange}-OPT` ||
        inst.segment === `${targetExchange}-FUT` ||
        inst.segment.startsWith(targetExchange);

      // Exact symbol match to avoid NIFTY matching NIFTY50, BANKNIFTY, etc.
      const symbolMatch =
        inst.tradingsymbol === symbol ||
        inst.tradingsymbol.startsWith(symbol) ||
        inst.name.replace(/"/g, '') === symbol;

      if (
        segmentMatch &&
        symbolMatch &&
        inst.expiry === expiry &&
        (inst.instrument_type === 'CE' || inst.instrument_type === 'PE')
      ) {
        strikes.add(inst.strike);
        matchCount++;
      }
    }

    this.logger.debug(
      `Found ${matchCount} matching instruments, ${strikes.size} unique strikes for ${symbol}`,
    );

    const sorted = Array.from(strikes).sort((a, b) => a - b);
    return { strikes: sorted };
  }

  /**
   * Get lot size for a symbol + expiry + strike (for options) or just symbol + expiry (for futures).
   */
  async getLotSize(
    exchange: string,
    symbol: string,
    segment?: string,
    expiry?: string,
    strike?: number,
  ): Promise<{ lotSize: number }> {
    const instruments = await this.getInstruments();

    // Map to derivatives exchange: NSE -> NFO, BSE -> BFO
    const targetExchange =
      exchange === 'NSE' ? 'NFO' : exchange === 'BSE' ? 'BFO' : exchange;

    // For futures, find the FUT instrument
    // For options, find any CE or PE (lot size is same for all options of a symbol)
    for (const inst of instruments) {
      // Match tradingsymbol starts with symbol (not name)
      if (!inst.tradingsymbol.startsWith(symbol)) continue;

      // Match segment
      const segmentMatch =
        inst.segment === targetExchange ||
        inst.segment === `${targetExchange}-OPT` ||
        inst.segment === `${targetExchange}-FUT` ||
        inst.segment.startsWith(targetExchange);

      if (!segmentMatch) continue;

      // Match instrument type based on segment
      let instrumentTypeMatch = false;
      if (segment === 'Futures') {
        instrumentTypeMatch = inst.instrument_type === 'FUT';
      } else if (segment === 'Options') {
        instrumentTypeMatch =
          inst.instrument_type === 'CE' || inst.instrument_type === 'PE';
      } else {
        // If segment not specified, match any derivative type
        instrumentTypeMatch =
          inst.instrument_type === 'FUT' ||
          inst.instrument_type === 'CE' ||
          inst.instrument_type === 'PE';
      }

      if (!instrumentTypeMatch) continue;

      // Match expiry if provided
      if (expiry && inst.expiry !== expiry) continue;

      // For options, we don't care about strike for lot size (it's same for all strikes)
      // Just return the first match
      return { lotSize: inst.lot_size };
    }

    // Default lot size if not found
    return { lotSize: 1 };
  }

  /**
   * Get LTP (last traded price) and other quote info for a specific instrument.
   * For now, returns instrument data from CSV (not live quote).
   * TODO: integrate Kite quote API using broker access token.
   */
  async getQuote(
    brokerId: string,
    exchange: string,
    tradingsymbol: string,
  ): Promise<{
    tradingsymbol: string;
    last_price: number;
    instrument_token: number;
  } | null> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    // For now, return instrument CSV data (not live quote)
    const instruments = await this.getInstruments();
    const inst = instruments.find(
      (i) => i.exchange === exchange && i.tradingsymbol === tradingsymbol,
    );

    if (!inst) return null;

    return {
      tradingsymbol: inst.tradingsymbol,
      last_price: inst.last_price,
      instrument_token: inst.instrument_token,
    };

    // TODO: call Kite quote API with broker.accessToken
    // const url = `https://api.kite.trade/quote?i=${exchange}:${tradingsymbol}`;
    // const res = await fetch(url, { headers: { Authorization: `token ${broker.apiKey}:${broker.accessToken}` } });
    // ...
  }

  /**
   * Get multiple quotes at once (batch).
   */
  async getQuotes(
    brokerId: string,
    instruments: Array<{ exchange: string; tradingsymbol: string }>,
  ): Promise<
    Array<{
      tradingsymbol: string;
      last_price: number;
      instrument_token: number;
    }>
  > {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    const allInstruments = await this.getInstruments();

    // Build array of exchange:tradingsymbol keys for Kite API
    const kiteKeys: string[] = [];
    const instrumentMap = new Map<string, any>();

    for (const req of instruments) {
      const inst = allInstruments.find(
        (i) =>
          i.exchange === req.exchange && i.tradingsymbol === req.tradingsymbol,
      );
      if (inst) {
        const kiteKey = `${req.exchange}:${req.tradingsymbol}`;
        kiteKeys.push(kiteKey);
        instrumentMap.set(kiteKey, inst);
      }
    }

    if (kiteKeys.length === 0) {
      return [];
    }

    // Fetch real-time quotes from Kite API
    try {
      const quotes = await kc.getQuote(kiteKeys);

      const results: Array<{
        tradingsymbol: string;
        last_price: number;
        instrument_token: number;
      }> = [];

      for (const [key, inst] of instrumentMap.entries()) {
        const quote = quotes[key];
        if (quote && quote.last_price) {
          results.push({
            tradingsymbol: inst.tradingsymbol,
            last_price: quote.last_price,
            instrument_token: inst.instrument_token,
          });
        }
      }

      return results;
    } catch (error) {
      this.logger.error(`Failed to fetch quotes from Kite: ${error.message}`);
      throw new Error('Failed to fetch real-time quotes');
    }
  }

  /**
   * Get quotes by instrument tokens (more efficient for paper trading).
   * Accepts array of instrument tokens and returns LTP for each.
   */
  async getQuotesByTokens(
    brokerId: string,
    instrumentTokens: number[],
  ): Promise<
    Array<{
      instrument_token: number;
      last_price: number;
      tradingsymbol: string;
      exchange: string;
    }>
  > {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    const allInstruments = await this.getInstruments();

    // Build array of exchange:tradingsymbol keys for Kite API
    // (Kite API requires exchange:tradingsymbol format, not just tokens)
    const kiteKeys: string[] = [];
    const tokenToKeyMap = new Map<number, string>();
    const tokenToInstMap = new Map<number, any>();

    for (const token of instrumentTokens) {
      const inst = allInstruments.find((i) => i.instrument_token === token);
      if (inst) {
        const kiteKey = `${inst.exchange}:${inst.tradingsymbol}`;
        kiteKeys.push(kiteKey);
        tokenToKeyMap.set(token, kiteKey);
        tokenToInstMap.set(token, inst);
      }
    }

    if (kiteKeys.length === 0) {
      return [];
    }

    // Fetch real-time quotes from Kite API
    try {
      const quotes = await kc.getQuote(kiteKeys);

      const results: Array<{
        instrument_token: number;
        last_price: number;
        tradingsymbol: string;
        exchange: string;
      }> = [];

      for (const token of instrumentTokens) {
        const kiteKey = tokenToKeyMap.get(token);
        const inst = tokenToInstMap.get(token);

        if (kiteKey && inst) {
          const quote = quotes[kiteKey];
          if (quote && quote.last_price) {
            results.push({
              instrument_token: token,
              last_price: quote.last_price,
              tradingsymbol: inst.tradingsymbol,
              exchange: inst.exchange,
            });
          }
        }
      }

      return results;
    } catch (error) {
      this.logger.error(
        `Failed to fetch quotes by tokens from Kite: ${error.message}`,
      );
      throw new Error('Failed to fetch real-time quotes by tokens');
    }
  }

  /**
   * Get quotes for options (CE/PE) and underlying based on symbol, expiry, strikes.
   * Uses KiteConnect getOHLC API to fetch real-time prices.
   */
  async getOptionQuotes(
    brokerId: string,
    symbol: string,
    exchange: string,
    expiry: string,
    callStrike: number,
    putStrike: number,
  ): Promise<
    Array<{
      type: 'CE' | 'PE' | 'UNDERLYING';
      tradingsymbol: string;
      last_price: number;
      instrument_token: number;
    }>
  > {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    const allInstruments = await this.getInstruments();
    const tradingsymbols: string[] = [];
    const instrumentMap: Map<
      string,
      { type: 'CE' | 'PE' | 'UNDERLYING'; instrument_token: number }
    > = new Map();

    // Map to derivatives exchange
    const derivExchange =
      exchange === 'NSE' ? 'NFO' : exchange === 'BSE' ? 'BFO' : exchange;

    // Find CE option
    const ceInst = allInstruments.find(
      (i) =>
        i.segment.startsWith(derivExchange) &&
        i.tradingsymbol.startsWith(symbol) &&
        i.expiry === expiry &&
        i.strike === callStrike &&
        i.instrument_type === 'CE',
    );
    if (ceInst) {
      const key = `${derivExchange}:${ceInst.tradingsymbol}`;
      tradingsymbols.push(key);
      instrumentMap.set(key, {
        type: 'CE',
        instrument_token: ceInst.instrument_token,
      });
    }

    // Find PE option
    const peInst = allInstruments.find(
      (i) =>
        i.segment.startsWith(derivExchange) &&
        i.tradingsymbol.startsWith(symbol) &&
        i.expiry === expiry &&
        i.strike === putStrike &&
        i.instrument_type === 'PE',
    );
    if (peInst) {
      const key = `${derivExchange}:${peInst.tradingsymbol}`;
      tradingsymbols.push(key);
      instrumentMap.set(key, {
        type: 'PE',
        instrument_token: peInst.instrument_token,
      });
    }

    // Find underlying (index or equity)
    // For indices like NIFTY, BANKNIFTY, look for exact tradingsymbol match in NSE-indices
    // For stocks, look for exact tradingsymbol match in NSE
    let underlyingInst = allInstruments.find(
      (i) =>
        (i.segment === 'INDICES' || i.exchange === 'NSE') &&
        i.tradingsymbol === symbol,
    );

    // If not found with exact match, try name matching for indices
    if (!underlyingInst) {
      if (symbol === 'NIFTY') {
        // Match NIFTY 50 specifically (not BANK NIFTY)
        underlyingInst = allInstruments.find(
          (i) => i.segment === 'INDICES' && i.name.includes('NIFTY 50'),
        );
      } else if (symbol === 'BANKNIFTY') {
        // Match NIFTY BANK specifically
        underlyingInst = allInstruments.find(
          (i) => i.segment === 'INDICES' && i.name.includes('NIFTY BANK'),
        );
      } else if (symbol === 'FINNIFTY') {
        // Match NIFTY FINANCIAL SERVICES
        underlyingInst = allInstruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            (i.name.includes('NIFTY FIN') || i.name.includes('FINANCIAL')),
        );
      } else if (symbol === 'MIDCPNIFTY') {
        // Match NIFTY MIDCAP SELECT
        underlyingInst = allInstruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            (i.name.includes('MIDCAP SELECT') || i.name.includes('NIFTY MID')),
        );
      } else if (symbol === 'SENSEX') {
        // Match SENSEX
        underlyingInst = allInstruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            (i.tradingsymbol === 'SENSEX' || i.name.includes('SENSEX')),
        );
      }
    }

    if (underlyingInst) {
      const key = `${underlyingInst.exchange}:${underlyingInst.tradingsymbol}`;
      tradingsymbols.push(key);
      instrumentMap.set(key, {
        type: 'UNDERLYING',
        instrument_token: underlyingInst.instrument_token,
      });
    }

    if (tradingsymbols.length === 0) {
      return [];
    }

    // Fetch real-time OHLC data from Kite API
    try {
      const ohlcData = await kc.getOHLC(tradingsymbols);

      const results: Array<{
        type: 'CE' | 'PE' | 'UNDERLYING';
        tradingsymbol: string;
        last_price: number;
        instrument_token: number;
      }> = [];

      for (const key of tradingsymbols) {
        const ohlc = ohlcData[key];
        const info = instrumentMap.get(key);
        if (ohlc && info) {
          // Extract tradingsymbol from "EXCHANGE:SYMBOL" format
          const tradingsymbol = key.split(':')[1];
          results.push({
            type: info.type,
            tradingsymbol,
            last_price: ohlc.last_price || 0,
            instrument_token: info.instrument_token,
          });
        }
      }

      return results;
    } catch (err) {
      throw new Error('Failed to fetch real-time prices from Kite API');
    }
  }

  /**
   * Get WebSocket credentials (API key and access token) for establishing WebSocket connection.
   */
  async getWebSocketCredentials(
    brokerId: string,
  ): Promise<{ apiKey: string | null; accessToken: string | null }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken || !broker.apiKey) {
      return { apiKey: null, accessToken: null };
    }

    return {
      apiKey: broker.apiKey,
      accessToken: broker.accessToken,
    };
  }

  async getOptionsAnalysis(input: {
    brokerId: string;
    exchange: string;
    symbol: string;
    expiry: string;
    strategy?: 'OPEN_HIGH' | 'OPEN_LOW';
    date?: string;
  }): Promise<{
    underlying: {
      tradingsymbol: string;
      name: string;
      exchange: string;
      last_price: number;
      change: number;
      changePercent: number;
      asOn: string | null;
      instrument_token: number;
      ohlc: { open: number; high: number; low: number; close: number } | null;
    } | null;
    rows: Array<{
      strike: number;
      call: {
        tradingsymbol: string;
        last_price: number;
        instrument_token: number;
        ohlc: { open: number; high: number; low: number; close: number } | null;
      } | null;
      put: {
        tradingsymbol: string;
        last_price: number;
        instrument_token: number;
        ohlc: { open: number; high: number; low: number; close: number } | null;
      } | null;
    }>;
  }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: input.brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    const allInstruments = await this.getInstruments();
    const derivExchange =
      input.exchange === 'NSE'
        ? 'NFO'
        : input.exchange === 'BSE'
          ? 'BFO'
          : input.exchange;

    const approxEqual = (a: number, b: number) => Math.abs(a - b) < 0.0001;

    // Resolve underlying instrument
    let underlyingInst = allInstruments.find(
      (i) =>
        (i.segment === 'INDICES' || i.exchange === 'NSE') &&
        i.tradingsymbol === input.symbol,
    );

    if (!underlyingInst) {
      if (input.symbol === 'NIFTY') {
        underlyingInst = allInstruments.find(
          (i) => i.segment === 'INDICES' && i.name.includes('NIFTY 50'),
        );
      } else if (input.symbol === 'BANKNIFTY') {
        underlyingInst = allInstruments.find(
          (i) => i.segment === 'INDICES' && i.name.includes('NIFTY BANK'),
        );
      } else if (input.symbol === 'FINNIFTY') {
        underlyingInst = allInstruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            (i.tradingsymbol === 'FINNIFTY' ||
              i.name.includes('NIFTY FIN') ||
              i.name.includes('FINANCIAL')),
        );
      } else if (input.symbol === 'MIDCPNIFTY') {
        underlyingInst = allInstruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            (i.tradingsymbol === 'MIDCPNIFTY' ||
              i.name.includes('MIDCAP SELECT') ||
              i.name.includes('NIFTY MID')),
        );
      } else if (input.symbol === 'SENSEX') {
        underlyingInst = allInstruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            (i.tradingsymbol === 'SENSEX' || i.name.includes('SENSEX')),
        );
      }
    }

    if (!underlyingInst) {
      return { underlying: null, rows: [] };
    }

    const underlyingKey = `${underlyingInst.exchange}:${underlyingInst.tradingsymbol}`;

    // Fetch underlying OHLC first to choose strikes around ATM
    const underlyingOHLCMap = await kc.getOHLC([underlyingKey]);
    const underlyingOHLC = (underlyingOHLCMap as any)?.[underlyingKey];

    const underlyingLast = Number(underlyingOHLC?.last_price || 0);
    const underlyingClose = Number(underlyingOHLC?.ohlc?.close || 0);
    const underlyingChange = underlyingLast - underlyingClose;
    const underlyingChangePercent = underlyingClose
      ? (underlyingChange / underlyingClose) * 100
      : 0;
    const underlyingAsOn = underlyingOHLC?.last_trade_time
      ? new Date(underlyingOHLC.last_trade_time).toISOString()
      : null;

    // Collect strikes for the expiry
    const strikeSet = new Set<number>();
    for (const inst of allInstruments) {
      if (!inst.segment.startsWith(derivExchange)) continue;
      if (!inst.tradingsymbol.startsWith(input.symbol)) continue;
      if (inst.expiry !== input.expiry) continue;
      if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE')
        continue;
      if (!Number.isFinite(inst.strike) || inst.strike <= 0) continue;
      strikeSet.add(inst.strike);
    }

    const allStrikes = Array.from(strikeSet).sort((a, b) => a - b);
    if (allStrikes.length === 0) {
      return {
        underlying: {
          tradingsymbol: underlyingInst.tradingsymbol,
          name: underlyingInst.name,
          exchange: underlyingInst.exchange,
          last_price: underlyingLast,
          change: underlyingChange,
          changePercent: underlyingChangePercent,
          asOn: underlyingAsOn,
          instrument_token: underlyingInst.instrument_token,
          ohlc: underlyingOHLC?.ohlc
            ? {
                open: Number(underlyingOHLC.ohlc.open || 0),
                high: Number(underlyingOHLC.ohlc.high || 0),
                low: Number(underlyingOHLC.ohlc.low || 0),
                close: Number(underlyingOHLC.ohlc.close || 0),
              }
            : null,
        },
        rows: [],
      };
    }

    // Choose 19 strikes around nearest-to-underlying
    const target =
      underlyingLast || allStrikes[Math.floor(allStrikes.length / 2)];
    let nearestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < allStrikes.length; i++) {
      const d = Math.abs(allStrikes[i] - target);
      if (d < bestDist) {
        bestDist = d;
        nearestIdx = i;
      }
    }

    const windowSize = 19;
    const half = Math.floor(windowSize / 2);
    let start = Math.max(0, nearestIdx - half);
    let end = Math.min(allStrikes.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    const strikes = allStrikes.slice(start, end);

    const keys: string[] = [underlyingKey];
    const ceByStrike = new Map<number, KiteInstrument>();
    const peByStrike = new Map<number, KiteInstrument>();

    for (const s of strikes) {
      const ce = allInstruments.find(
        (i) =>
          i.segment.startsWith(derivExchange) &&
          i.tradingsymbol.startsWith(input.symbol) &&
          i.expiry === input.expiry &&
          i.strike === s &&
          i.instrument_type === 'CE',
      );
      const pe = allInstruments.find(
        (i) =>
          i.segment.startsWith(derivExchange) &&
          i.tradingsymbol.startsWith(input.symbol) &&
          i.expiry === input.expiry &&
          i.strike === s &&
          i.instrument_type === 'PE',
      );

      if (ce) {
        ceByStrike.set(s, ce);
        keys.push(`${derivExchange}:${ce.tradingsymbol}`);
      }
      if (pe) {
        peByStrike.set(s, pe);
        keys.push(`${derivExchange}:${pe.tradingsymbol}`);
      }
    }

    const ohlcMap = await kc.getOHLC(keys);
    const getOHLC = (key: string) => (ohlcMap as any)?.[key];

    const underlyingOhlc = getOHLC(underlyingKey);
    const underlyingOhlcObj = underlyingOhlc?.ohlc
      ? {
          open: Number(underlyingOhlc.ohlc.open || 0),
          high: Number(underlyingOhlc.ohlc.high || 0),
          low: Number(underlyingOhlc.ohlc.low || 0),
          close: Number(underlyingOhlc.ohlc.close || 0),
        }
      : null;

    const rows = strikes.map((s) => {
      const ce = ceByStrike.get(s);
      const pe = peByStrike.get(s);

      const ceKey = ce ? `${derivExchange}:${ce.tradingsymbol}` : null;
      const peKey = pe ? `${derivExchange}:${pe.tradingsymbol}` : null;

      const ceO = ceKey ? getOHLC(ceKey) : null;
      const peO = peKey ? getOHLC(peKey) : null;

      const normalize = (o: any) =>
        o?.ohlc
          ? {
              open: Number(o.ohlc.open || 0),
              high: Number(o.ohlc.high || 0),
              low: Number(o.ohlc.low || 0),
              close: Number(o.ohlc.close || 0),
            }
          : null;

      const ceOhlc = normalize(ceO);
      const peOhlc = normalize(peO);

      // Touch strategy (used by UI badges)
      const strategy = input.strategy || 'OPEN_HIGH';
      if (ceOhlc) {
        const hit =
          strategy === 'OPEN_HIGH'
            ? approxEqual(ceOhlc.open, ceOhlc.high)
            : approxEqual(ceOhlc.open, ceOhlc.low);
        void hit;
      }

      return {
        strike: s,
        call: ce
          ? {
              tradingsymbol: ce.tradingsymbol,
              last_price: Number(ceO?.last_price || 0),
              instrument_token: ce.instrument_token,
              ohlc: ceOhlc,
            }
          : null,
        put: pe
          ? {
              tradingsymbol: pe.tradingsymbol,
              last_price: Number(peO?.last_price || 0),
              instrument_token: pe.instrument_token,
              ohlc: peOhlc,
            }
          : null,
      };
    });

    return {
      underlying: {
        tradingsymbol: underlyingInst.tradingsymbol,
        name: underlyingInst.name,
        exchange: underlyingInst.exchange,
        last_price: Number(underlyingOhlc?.last_price || 0),
        change:
          Number(underlyingOhlc?.last_price || 0) -
          Number(underlyingOhlc?.ohlc?.close || 0),
        changePercent: Number(underlyingOhlc?.ohlc?.close)
          ? ((Number(underlyingOhlc?.last_price || 0) -
              Number(underlyingOhlc?.ohlc?.close || 0)) /
              Number(underlyingOhlc?.ohlc?.close || 0)) *
            100
          : 0,
        asOn: underlyingOhlc?.last_trade_time
          ? new Date(underlyingOhlc.last_trade_time).toISOString()
          : null,
        instrument_token: underlyingInst.instrument_token,
        ohlc: underlyingOhlcObj,
      },
      rows,
    };
  }

  async getPositions(brokerId: string): Promise<{ net: any[]; day: any[] }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const positions = await kc.getPositions();
      return {
        net: positions.net || [],
        day: positions.day || [],
      };
    } catch (err: any) {
      this.logger.error('Failed to fetch positions', err);
      throw new Error('Failed to fetch positions from broker');
    }
  }

  async getOrders(brokerId: string): Promise<{ orders: any[] }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const orders = await kc.getOrders();
      return { orders: orders || [] };
    } catch (err: any) {
      this.logger.error('Failed to fetch orders', err);
      throw new Error('Failed to fetch orders from broker');
    }
  }

  async getTrades(brokerId: string): Promise<{ trades: any[] }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const trades = await kc.getTrades();
      return { trades: trades || [] };
    } catch (err: any) {
      this.logger.error('Failed to fetch trades', err);
      throw new Error('Failed to fetch trades from broker');
    }
  }

  async getHoldings(brokerId: string): Promise<{ holdings: any[] }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const holdings = await kc.getHoldings();
      return { holdings: holdings || [] };
    } catch (err: any) {
      this.logger.error('Failed to fetch holdings', err);
      throw new Error('Failed to fetch holdings from broker');
    }
  }

  async getMargins(
    brokerId: string,
  ): Promise<{ equity: any | null; commodity: any | null }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const margins = await kc.getMargins();
      return {
        equity: (margins as any)?.equity || null,
        commodity: (margins as any)?.commodity || null,
      };
    } catch (err: any) {
      this.logger.error('Failed to fetch margins', err);
      throw new Error('Failed to fetch margins from broker');
    }
  }

  async placeOrder(params: {
    brokerId: string;
    tradingsymbol: string;
    exchange: string;
    transactionType: 'BUY' | 'SELL';
    quantity: number;
    product: string;
    orderType: string;
    price?: number;
    triggerPrice?: number;
  }): Promise<{ orderId: string }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: params.brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const orderParams: any = {
        tradingsymbol: params.tradingsymbol,
        exchange: params.exchange,
        transaction_type: params.transactionType,
        quantity: params.quantity,
        product: params.product,
        order_type: params.orderType,
      };

      if (params.price) {
        orderParams.price = params.price;
      }
      if (params.triggerPrice) {
        orderParams.trigger_price = params.triggerPrice;
      }

      // Try regular order first
      try {
        const result = await kc.placeOrder('regular', orderParams);
        return { orderId: result.order_id };
      } catch (orderErr: any) {
        // If order fails due to freeze quantity, retry with iceberg
        if (
          orderErr?.error_type === 'InputException' &&
          orderErr?.data?.hints?.includes('auto_slice')
        ) {
          this.logger.log(
            'Order exceeds freeze quantity, retrying with iceberg...',
          );
          // Use iceberg variety for automatic order slicing
          const icebergResult = await kc.placeOrder('iceberg', orderParams);
          return { orderId: icebergResult.order_id };
        }
        // Re-throw other errors
        throw orderErr;
      }
    } catch (err: any) {
      this.logger.error('Failed to place order', err);
      throw new Error(err?.message || 'Failed to place order');
    }
  }

  async cancelOrder(params: {
    brokerId: string;
    orderId: string;
    variety?: string;
  }): Promise<{ orderId: string }> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: params.brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const variety = (params.variety || 'regular') as
        | 'regular'
        | 'amo'
        | 'co'
        | 'iceberg'
        | 'bo'
        | 'auction';
      const result = await kc.cancelOrder(variety, params.orderId);
      return { orderId: result.order_id };
    } catch (err: any) {
      this.logger.error(`Failed to cancel order ${params.orderId}`, err);
      throw new Error(err?.message || 'Failed to cancel order');
    }
  }

  async getOrderHistory(params: {
    brokerId: string;
    orderId: string;
  }): Promise<any[]> {
    const broker = await this.prisma.broker.findUnique({
      where: { id: params.brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not connected or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    try {
      const history = await kc.getOrderHistory(params.orderId);
      return history || [];
    } catch (err: any) {
      this.logger.error(
        `Failed to fetch order history for ${params.orderId}`,
        err,
      );
      throw new Error(err?.message || 'Failed to fetch order history');
    }
  }

}

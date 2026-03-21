import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { KiteConnect } from 'kiteconnect';
import { PrismaService } from '../../prisma/prisma.service';
import { PaperTradingService } from '../../paper-trading/services/paper-trading.service';
import { SignalsService } from './signals.service';
import { IndicatorsService } from './indicators.service';
import {
  parseTimeToMinutes,
  parseSignalTimeToDate,
} from '../helpers/kite.helpers';

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

function diagLog(version: string, tag: string, data: object): void {
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
    `${version}-strategy-diag.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore */
  }
}

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

  /**
   * Shared DAY_SELLING signal detection engine.
   * Scans `candles` for bearish rejection signals and returns every detected signal.
   * Trade management (one-at-a-time, daily loss limits, SuperTrend filter) is left
   * to the caller so there is a single canonical detection code path.
   */

  /**
   * Normalizes an instrument name from the DB into the symbol key used in
   * TradingSettings.  Index instruments are stored with names like 'NIFTY 50'
   * or 'NIFTY BANK' while TradingSettings records use 'NIFTY' / 'BANKNIFTY'.
   */
  private normalizeSettingsSymbol(name: string): string {
    const MAP: Record<string, string> = {
      'NIFTY 50': 'NIFTY',
      'NIFTY BANK': 'BANKNIFTY',
      'NIFTY MIDCAP SELECT': 'MIDCPNIFTY',
    };
    return MAP[name] ?? name;
  }

  private detectDaySellSignals(params: {
    candles: any[];
    emaValues: (number | null)[];
    rsiValues: (number | null)[];
    swingHighs: Array<{ price: number; index: number }>;
    yesterdayHigh: number;
    prevDayLow?: number;
    prevDayClose?: number;
    marginPoints: number;
    minSellRsi?: number;
    maxSellRiskPts?: number;
    realtimeMode?: boolean;
    instrumentName?: string;
    superTrendData?: Array<{ superTrend: number; trend: 'up' | 'down' } | null>;
  }): Array<{
    candleIndex: number;
    actualCandleIndex: number;
    candleTime: string;
    candleDate: Date;
    unixTimestamp: number;
    reason: string;
    entryPrice: number;
    stopLoss: number;
    risk: number;
    candleRSI: number | null;
    isDayHighZoneRejection: boolean;
    nearDayHighZone: boolean;
    isNearDailyHigh: boolean;
  }> {
    const {
      candles,
      emaValues,
      rsiValues,
      swingHighs,
      yesterdayHigh,
      prevDayLow = 0,
      prevDayClose = 0,
      marginPoints,
      minSellRsi = 45,
      maxSellRiskPts = 25,
      realtimeMode = false,
      instrumentName = '',
      superTrendData,
    } = params;

    const results: ReturnType<typeof this.detectDaySellSignals> = [];

    // ── Diagnostic file logger ────────────────────────────────────────────
    // --- Day-high zone state ---
    let rollingHigh = 0;
    let confirmedResZone = 0;
    let confirmedResZoneIndex = -1;
    let pulledBackFromResZone = false;
    let dayHighZoneTestCount = 0;

    // In realtimeMode only scan the last 2 candles, but we still need zone state
    // from all earlier candles — process them first in a pre-pass.
    const scanStartIndex = realtimeMode ? Math.max(1, candles.length - 2) : 1;

    const updateZone = (c: any, idx: number) => {
      const h = c.high;
      const l = c.low;
      const body = Math.abs(c.close - c.open);
      const wick = h - Math.max(c.open, c.close);
      const range = h - l;
      if (h > rollingHigh) {
        rollingHigh = h;
        const wr = range > 0 ? wick / range : 0;
        const br = range > 0 ? body / range : 0;
        if (
          br < 0.1 ||
          (wr > 0.35 && wick > body * 1.5) ||
          (c.close < c.open && body > range * 0.35)
        ) {
          confirmedResZone = h;
          confirmedResZoneIndex = idx;
          pulledBackFromResZone = false;
          dayHighZoneTestCount = 0;
        }
      }
      if (
        confirmedResZone > 0 &&
        !pulledBackFromResZone &&
        l < confirmedResZone - marginPoints * 2
      ) {
        pulledBackFromResZone = true;
      }
      if (
        pulledBackFromResZone &&
        confirmedResZone > 0 &&
        Math.abs(h - confirmedResZone) <= marginPoints * 1.5
      ) {
        dayHighZoneTestCount++;
      }
    };

    // First candle of the day (9:15 candle) — used for 1st-candle-low-break and retest patterns
    const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
    const firstCandleHigh = candles.length > 0 ? candles[0].high : 0;
    // Previous day pullback guard: if prev day’s low is within
    // marginPoints×2 of today’s first candle low they form the same
    // confluence support zone — don’t fire until the LOWER level is broken.
    // const firstCandleLowBreakLevel =
    //   prevDayLow > 0 &&
    //   firstCandleLow > 0 &&
    //   Math.abs(firstCandleLow - prevDayLow) <= marginPoints * 2
    //     ? Math.min(firstCandleLow, prevDayLow) - 1
    //     : firstCandleLow;
    const firstCandleLowBreakLevel = firstCandleLow;
    let firstCandleLowBreakFired = false;
    if (firstCandleLow > 0 && realtimeMode) {
      for (let pi = 1; pi < candles.length - 1; pi++) {
        if (candles[pi]?.close < firstCandleLowBreakLevel) {
          firstCandleLowBreakFired = true;
          break;
        }
      }
    }

    for (let pi = 0; pi < scanStartIndex; pi++) updateZone(candles[pi], pi);

    for (let i = scanStartIndex; i < candles.length; i++) {
      const candle = candles[i];
      const candleEMA = emaValues[i];

      const candleHigh = candle.high;
      const candleLow = candle.low;
      const candleOpen = candle.open;
      const candleClose = candle.close;
      const candleBody = Math.abs(candleClose - candleOpen);
      const upperWick = candleHigh - Math.max(candleOpen, candleClose);
      const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
      const totalRange = candleHigh - candleLow;
      const isRedCandle = candleClose < candleOpen;
      const isGreenCandle = candleClose > candleOpen;

      // Update zone BEFORE time filter so state is always current
      updateZone(candle, i);

      // Time — needed for break check and other patterns
      const candleDate =
        candle.date instanceof Date ? candle.date : new Date(candle.date);
      const mins = candleDate.getHours() * 60 + candleDate.getMinutes();

      // ── Day 1st Candle Low Break ───────────────────────────────────────────
      // Price breaks below the opening 9:15 candle low with a valid breakdown candle.
      // Condition 1: Valid breakdown candle (one of):
      //   a) Large bearish body  — body > 40% of range
      //   b) Bearish engulfing   — current red candle engulfs prior green candle
      //   c) Strong close near candle low — close in bottom 20% of range
      // Condition 2: No nearby support below entry (would block reaching T1):
      //   a) 20 EMA not within 1R below entry
      //   b) Previous Day Low not within 1R below entry
      //   c) No intraday swing low (prior candle lows) within 1R below entry
      if (
        i > 0 &&
        !firstCandleLowBreakFired &&
        firstCandleLow > 0 &&
        isRedCandle &&
        candleClose < firstCandleLowBreakLevel
      ) {
        // ── Condition 1: Valid breakdown candle ──
        const brkPrev1 = i >= 1 ? candles[i - 1] : null;
        const brkLargeBearishBody = candleBody > totalRange * 0.4;
        const brkBearishEngulfing =
          !!brkPrev1 &&
          brkPrev1.close > brkPrev1.open && // prev candle was green
          candleOpen >= brkPrev1.close && // opened at or above prev close
          candleClose < brkPrev1.open; // closed below prev open
        const brkStrongCloseNearLow =
          totalRange > 0 && (candleClose - candleLow) / totalRange < 0.2; // close in bottom 20%

        const brkValidCandle =
          brkLargeBearishBody || brkBearishEngulfing || brkStrongCloseNearLow;
        if (!brkValidCandle) {
          // Weak candle pattern — do NOT set the flag. Let the next candle retry.
          // (e.g. 9:40 is a wide-range 5-min candle with no strong body; 9:45 may be cleaner)
          diagLog('v1', '[V1-FCL-SKIP]', {
            instrument: instrumentName,
            candleTime: candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            }),
            reason: 'weak-pattern',
            candleClose,
            candleHigh,
            firstCandleLow,
            brkLargeBearishBody,
            brkBearishEngulfing,
            brkStrongCloseNearLow,
          });
          continue;
        }

        // EMA must be above the candle — if EMA is below close, it's acting as
        // dynamic support beneath the price. Selling into support is invalid.
        if (candleEMA != null && candleEMA < candleClose) {
          // EMA is below close (support present) — consume flag so we don't retry
          firstCandleLowBreakFired = true;
          diagLog('v1', '[V1-FCL-SKIP]', {
            instrument: instrumentName,
            candleTime: candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            }),
            reason: 'ema-below-close',
            candleClose,
            candleEMA,
          });
          continue;
        }

        // Valid pattern + EMA clear — lock the flag now
        firstCandleLowBreakFired = true;

        // SL: structural level (the broken first candle low is now resistance).
        // Using the structural level (not candleHigh) keeps risk tight and consistent
        // across all candle intervals (1min, 3min, 5min).
        const breakSL = firstCandleLow + 2;
        const breakRisk = breakSL - candleClose;

        // Allow up to 2× the normal risk cap for structural breakdown signals.
        // 5-min candles naturally have wider range than 1-min; the structural SL
        // (first candle low) is valid regardless of candle interval.
        if (breakRisk > 0 && breakRisk <= maxSellRiskPts * 2) {
          // ── Condition 2: No nearby support within 1R below entry ──
          // 2a) 20 EMA support (already guaranteed to be at/above close by check above)
          const brkEMASupport =
            candleEMA != null &&
            candleEMA < candleClose &&
            candleClose - candleEMA < breakRisk;

          // 2b) Previous Day Low support
          const brkPrevDayLowSupport =
            prevDayLow > 0 &&
            prevDayLow < candleClose &&
            candleClose - prevDayLow < breakRisk;

          // 2c) Intraday swing low support — scan prior candles for lows that are
          //     below entry but within 1R (price likely to stall there before T1)
          let brkIntradaySupport = false;
          for (let k = 1; k < i; k++) {
            const kLow = candles[k].low;
            if (kLow < candleClose && candleClose - kLow < breakRisk) {
              brkIntradaySupport = true;
              break;
            }
          }

          const brkHasNearbySupportBelow =
            brkEMASupport || brkPrevDayLowSupport || brkIntradaySupport;

          if (!brkHasNearbySupportBelow) {
            const brkPattern = brkBearishEngulfing
              ? 'Bearish Engulfing'
              : brkStrongCloseNearLow
                ? 'Strong Close Near Low'
                : 'Large Bearish Body';
            const breakRSI = rsiValues[i];
            const breakUnixTs = Math.floor(candleDate.getTime() / 1000) + 19800;
            const breakTime = candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            results.push({
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: breakTime,
              candleDate,
              unixTimestamp: breakUnixTs,
              reason: `Day 1st Candle Low Break (${brkPattern})`,
              entryPrice: candleClose,
              stopLoss: breakSL,
              risk: breakRisk,
              candleRSI: breakRSI,
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh: false,
            });
          } else {
            diagLog('v1', '[V1-FCL-SKIP]', {
              instrument: instrumentName,
              candleTime: candleDate.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              }),
              reason: 'nearby-support',
              candleClose,
              breakRisk,
              brkPrevDayLowSupport,
              brkIntradaySupport,
            });
          }
        } else if (breakRisk > 0) {
          diagLog('v1', '[V1-FCL-SKIP]', {
            instrument: instrumentName,
            candleTime: candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            }),
            reason: 'risk-too-wide',
            breakRisk,
            maxAllowed: maxSellRiskPts * 2,
            candleClose,
            firstCandleLow,
          });
        }
        continue; // candle fully handled — skip remaining pattern checks
      }
      if (!candleEMA || mins < 9 * 60 + 30 || mins > 14 * 60 + 30) continue;

      // Day-high zone proximity (computed before EMA filter so it can bypass it)
      const nearDayHighZone =
        pulledBackFromResZone &&
        confirmedResZone > 0 &&
        i > confirmedResZoneIndex + 1 &&
        Math.abs(candleHigh - confirmedResZone) <= marginPoints * 1.5;

      // EMA trend filter — bypass for day-high zone candles
      const priceAboveEMA = candleClose > candleEMA;
      const gapFromEMA = Math.abs(candleClose - candleEMA);
      const highTouchesEMA =
        Math.abs(candleHigh - candleEMA) <= marginPoints * 1.5;
      if (
        priceAboveEMA &&
        !highTouchesEMA &&
        gapFromEMA < marginPoints * 1.5 &&
        !nearDayHighZone
      )
        continue;

      // Uptrend guard: scan every candle from session start to now.
      // If ≥60% of candles closed above the 20 EMA, the EMA is acting as
      // support (price has been staying above or briefly dipping and recovering).
      // Selling into such a market is low-probability — skip.
      // No hardcoded lookback: uses actual price-vs-EMA relationship all session.
      {
        let aboveEMA = 0;
        let counted = 0;
        for (let k = 0; k <= i; k++) {
          const ema = emaValues[k];
          if (ema == null) continue;
          counted++;
          if (candles[k].close > ema) aboveEMA++;
        }
        // Exception: Day-High Zone Rejection is valid even in an uptrend —
        // price reaching the session high and getting rejected there is bearish
        // regardless of the overall EMA trend direction.
        if (counted >= 3 && aboveEMA / counted > 0.6 && !nearDayHighZone) {
          continue;
        }
      }

      // Resistance level proximity
      const nearEMA = Math.abs(candleHigh - candleEMA) <= marginPoints;
      const nearYesterdayHigh =
        yesterdayHigh > 0 &&
        Math.abs(candleHigh - yesterdayHigh) <= marginPoints;
      const nearPrevDayClose =
        prevDayClose > 0 && Math.abs(candleHigh - prevDayClose) <= marginPoints;
      const nearFirstCandleHigh =
        firstCandleHigh > 0 &&
        i > 3 &&
        Math.abs(candleHigh - firstCandleHigh) <= marginPoints;
      let nearSwingHigh = false;
      for (const swing of swingHighs) {
        if (
          swing.index < i - 3 &&
          Math.abs(candleHigh - swing.price) <= marginPoints
        ) {
          nearSwingHigh = true;
          break;
        }
      }
      if (
        !nearEMA &&
        !nearYesterdayHigh &&
        !nearPrevDayClose &&
        !nearFirstCandleHigh &&
        !nearSwingHigh &&
        !nearDayHighZone
      )
        continue;

      // EMA touch rejection: high reached EMA zone AND candle closed below EMA AND below its open.
      // isRedCandle (close < open) is required — a green candle touching EMA but closing green
      // shows buyers stepping in, not a rejection. Computed before candle-type gate so it can bypass it.
      const emaTouchRejection =
        nearEMA &&
        isRedCandle &&
        candleHigh >= candleEMA - marginPoints * 0.5 &&
        candleClose < candleEMA;

      // Candle type check
      const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;
      const nextCandle = i + 1 < candles.length ? candles[i + 1] : null;
      const nextIsRed = nextCandle ? nextCandle.close < nextCandle.open : false;
      const isGreenShootingStar =
        isGreenCandle &&
        nearEMA &&
        upperWick > candleBody * 2 &&
        upperWick > totalRange * 0.5 &&
        nextIsRed;
      if (
        !isRedCandle &&
        !(isDoji && nextIsRed) &&
        !isGreenShootingStar &&
        !nearDayHighZone &&
        !emaTouchRejection
      )
        continue;

      // Actual entry candle (DOJI / GreenSS → use next red candle)
      const useNextAsEntry =
        (isDoji || isGreenShootingStar) && nextIsRed && nextCandle;
      const actualEntry = useNextAsEntry ? nextCandle! : candle;
      const actualCandleIndex = useNextAsEntry ? i + 1 : i;
      const actualHigh = actualEntry.high;
      const actualClose = actualEntry.close;
      const actualOpen = actualEntry.open;
      const actualBody = Math.abs(actualClose - actualOpen);
      const actualUpperWick = actualHigh - Math.max(actualOpen, actualClose);
      const actualLowerWick =
        Math.min(actualOpen, actualClose) - actualEntry.low;
      const actualRange = actualHigh - actualEntry.low;
      const actualIsRed = actualClose < actualOpen;
      const actualIsGreen = actualClose > actualOpen;
      const actualDate =
        actualEntry.date instanceof Date
          ? actualEntry.date
          : new Date(actualEntry.date);
      const unixTimestamp = Math.floor(actualDate.getTime() / 1000) + 19800;

      // Context candles
      const prev1 = i >= 1 ? candles[i - 1] : null;
      const prev2 = i >= 2 ? candles[i - 2] : null;
      const prev3 = i >= 3 ? candles[i - 3] : null;

      // Resistance level (for pattern context)
      let resistanceTests = 0;
      const resistanceLevel = nearYesterdayHigh
        ? yesterdayHigh
        : nearSwingHigh
          ? swingHighs.find(
              (s) => Math.abs(candleHigh - s.price) <= marginPoints,
            )?.price
          : candleEMA;
      if (resistanceLevel) {
        [prev3, prev2, prev1, candle].forEach((c) => {
          if (c && Math.abs(c.high - resistanceLevel) <= marginPoints * 1.5)
            resistanceTests++;
        });
      }

      // --- Pattern detection ---
      const weakCloseAtResistance =
        (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
        candleHigh >= (resistanceLevel || candleEMA) * 0.99 &&
        candleClose < candleHigh * 0.995 &&
        (isGreenCandle ? candleClose < candleOpen + candleBody * 0.5 : true) &&
        resistanceTests >= 2;

      const earlyRejection =
        (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
        upperWick > candleBody * 1.2 &&
        upperWick > totalRange * 0.4 &&
        candleClose < candleHigh * 0.99 &&
        // If EMA is the resistance, high must actually reach within half-margin of EMA
        // (prevents firing when price is still far below a declining EMA)
        (!nearEMA || candleHigh >= candleEMA - marginPoints * 0.5);

      let momentumSlowing = false;
      if (prev2 && prev1) {
        const b2 = Math.abs(prev2.close - prev2.open);
        const b1 = Math.abs(prev1.close - prev1.open);
        momentumSlowing =
          isRedCandle && candleBody < b1 && b1 < b2 && resistanceTests >= 2;
      }

      const isShootingStar =
        upperWick > candleBody * 2 &&
        lowerWick < candleBody * 0.5 &&
        upperWick > totalRange * 0.6;

      const isBearishEngulfing =
        !!prev1 &&
        prev1.close > prev1.open &&
        candleOpen > prev1.close &&
        candleClose < prev1.open &&
        isRedCandle;

      const hasStrongRejection =
        isRedCandle &&
        upperWick > candleBody * 2 &&
        upperWick > totalRange * 0.5 &&
        candleClose < candleOpen * 0.98;

      // EMA support check: look back at the last 10 candles. For each candle
      // that touched the EMA (low or close within marginPoints), if the *next*
      // candle was green (bounced), EMA behaved as support there.
      // If ≥2 such bounces exist, EMA is clearly acting as support for this
      // session → a current EMA touch should NOT generate a sell signal.
      let emaActsAsSupport = false;
      if (emaTouchRejection) {
        let emaBounceCount = 0;
        const emaSupportLookback = Math.min(10, i - 1);
        for (let k = Math.max(0, i - emaSupportLookback); k < i; k++) {
          const kc = candles[k];
          const ke = emaValues[k];
          if (ke == null) continue;
          const touchedEMA =
            Math.abs(kc.low - ke) <= marginPoints ||
            Math.abs(kc.close - ke) <= marginPoints;
          if (touchedEMA) {
            const nextKC = k + 1 < candles.length ? candles[k + 1] : null;
            // Bounce = next candle was green (buyers stepped in at EMA)
            if (nextKC && nextKC.close > nextKC.open) {
              emaBounceCount++;
            }
          }
        }
        if (emaBounceCount >= 2) emaActsAsSupport = true;
      }

      // 20 EMA Rejection — bearish structure validation (all three must pass):
      //
      // Check 1: Price already below EMA.
      //   At least 3 of the last 6 candles closed below the EMA before this retrace.
      //   Ensures we are selling a known downtrend pull-back, not a first dip.
      let emaBearishBelowCount = 0;
      const emaBearLookback = Math.min(6, i);
      for (let k = i - emaBearLookback; k < i; k++) {
        const kEMA = emaValues[k];
        if (kEMA != null && candles[k].close < kEMA) emaBearishBelowCount++;
      }
      const emaBearishStructure = emaBearishBelowCount >= 3;

      // Check 2: First-cross-below filter.
      //   If the 2 candles immediately before this one BOTH closed above the EMA,
      //   the current touch is a first break downward (price was up, then dropped).
      //   This could be a temporary retracement before price moves up again → skip.
      //   Only fire after price has been below the EMA, retraced back, and is now
      //   getting rejected for a second (confirmed) time.
      const emaRecentAboveCount = [i - 1, i - 2].reduce((cnt, k) => {
        if (k < 0) return cnt;
        const kEMA = emaValues[k];
        return kEMA != null && candles[k].close > kEMA ? cnt + 1 : cnt;
      }, 0);
      const emaIsFirstCrossBelow = emaRecentAboveCount >= 2;

      // Check 3: Lower highs forming (confirms a downtrending/weakening retrace).
      //   At least one of the two consecutive prior-candle high pairs is declining.
      //   Uses candles i−3 → i−2 → i−1 to exclude the current retrace candle itself.
      const emaLowerHighsForming =
        i >= 3 &&
        (candles[i - 1].high < candles[i - 2].high ||
          candles[i - 2].high < candles[i - 3].high);

      // Already computed above as emaTouchRejection — referenced here for signal reason.
      // Suppressed when:
      //   • EMA is acting as support (confirmed by multiple recent bounces), OR
      //   • bearish structure hasn't been established yet (price not previously below EMA), OR
      //   • this looks like a first cross (not a confirmed re-test rejection), OR
      //   • higher highs suggest the retrace is in a strong environment.
      const bearishOpenAtEMA =
        emaTouchRejection &&
        !emaActsAsSupport &&
        emaBearishStructure &&
        !emaIsFirstCrossBelow &&
        emaLowerHighsForming;

      // Day-high zone rejection
      const emaForDHR = emaValues[i];
      // Pick the actual resistance level being tested so the EMA-distance rule
      // works correctly for prevDayHigh and prevDayClose zones, not just session high.
      const dhrResistanceLevel = nearDayHighZone
        ? confirmedResZone
        : nearYesterdayHigh
          ? yesterdayHigh
          : prevDayClose;
      const emaFarBelowZone =
        emaForDHR != null && dhrResistanceLevel - emaForDHR > marginPoints * 2;
      const rsiForDHR = rsiValues[i];
      const rsiNotOversold = rsiForDHR == null || rsiForDHR > 35;
      // Rejection candle types for Day High Zone Rejection:
      // - Long upper wick (long upper wick = price tried to push higher but got rejected)
      // - Bearish engulfing (strong reversal signal at resistance)
      // - Strong bearish close (large red body)
      const dhrLongUpperWick =
        upperWick > candleBody * 1.2 || upperWick > totalRange * 0.4;
      const dhrBearishEngulfing =
        !!prev1 &&
        prev1.close > prev1.open &&
        candleOpen >= prev1.close &&
        candleClose < prev1.open &&
        isRedCandle;
      const dhrStrongBearishClose =
        isRedCandle && candleBody > totalRange * 0.5;
      const dhrRejectionCandle =
        dhrLongUpperWick ||
        dhrBearishEngulfing ||
        dhrStrongBearishClose ||
        isDoji;

      // Resistance zones for Day High Rejection: session high zone, prev day high, prev day close
      const nearAnyDayHighResistance =
        nearDayHighZone || nearYesterdayHigh || nearPrevDayClose;

      // EMA position relative to entry (close) for DHR:
      // - EMA above entry → EMA is overhead resistance alongside the zone → valid DHR context
      // - EMA far below entry (>= marginPoints) → clear room for price to fall to targets → valid
      // - EMA slightly below entry (< marginPoints) → EMA acts as dynamic support right in the
      //   path of the trade; the underlying is likely in an uptrend (PE in falling-Nifty = rising)
      //   so the 20 EMA is a rising support floor — no room to fall after entry → block
      const emaNotSupportAtEntry =
        emaForDHR == null ||
        emaForDHR >= candleClose || // EMA at/above entry = overhead resistance = OK
        candleClose - emaForDHR >= marginPoints; // EMA far enough below = room = OK

      // ── New engine helpers ─────────────────────────────────────────────────
      // P2b: EMA Fake Break Rejection — bull trap: high pierces EMA but close fails below
      const emaFakeBreakAbove =
        candleEMA != null &&
        candleHigh > (candleEMA as number) &&
        candleClose < (candleEMA as number);
      const emaFakeBreakRejection =
        nearEMA &&
        emaFakeBreakAbove &&
        !emaActsAsSupport &&
        emaBearishStructure &&
        (isRedCandle || upperWick > candleBody);

      // P3: Broken First Candle Low Retest Rejection
      const firstCandleLowBrokenEarlier =
        firstCandleLow > 0 &&
        i > 1 &&
        candles.slice(1, i).some((c: any) => c.close < firstCandleLow);
      const nearBrokenFirstCandleLow =
        firstCandleLow > 0 &&
        Math.abs(candleHigh - firstCandleLow) <= marginPoints;
      const failedRetestOfFirstCandleLow =
        firstCandleLow > 0 &&
        candleHigh >= firstCandleLow - marginPoints * 0.5 &&
        candleClose < firstCandleLow;
      const brokenFirstCandleLowRetest =
        firstCandleLowBrokenEarlier &&
        nearBrokenFirstCandleLow &&
        failedRetestOfFirstCandleLow &&
        isRedCandle &&
        (upperWick > candleBody * 1.2 || candleBody > totalRange * 0.4);

      // P4: Lower High Breakdown
      const lowerHighsForming =
        i >= 3 &&
        candles[i - 1].high < candles[i - 2].high &&
        candles[i - 2].high < candles[i - 3].high;
      const lowerHighBreakdown =
        lowerHighsForming &&
        isRedCandle &&
        nearEMA &&
        emaBearishStructure &&
        candleEMA != null &&
        candleClose < (candleEMA as number);

      // ── Shared rejection pattern label (used by P1 zone branches) ─────────
      const rejPatternLabel =
        dhrBearishEngulfing || isBearishEngulfing
          ? 'Bearish Engulfing'
          : isShootingStar
            ? 'Shooting Star'
            : hasStrongRejection || dhrStrongBearishClose
              ? 'Strong Bearish'
              : dhrLongUpperWick || earlyRejection
                ? 'Long Upper Wick'
                : weakCloseAtResistance
                  ? 'Weak Close'
                  : momentumSlowing
                    ? 'Momentum Slowing'
                    : isDoji
                      ? 'Doji'
                      : 'Rejection';

      // Any valid P1 rejection candle pattern
      const anyP1RejectionCandle =
        dhrRejectionCandle ||
        weakCloseAtResistance ||
        earlyRejection ||
        isShootingStar ||
        isBearishEngulfing ||
        hasStrongRejection ||
        momentumSlowing;

      // ══════════════════════════════════════════════════════════════════════
      // Signal engine evaluation (first valid pattern wins — if/else-if)
      // ══════════════════════════════════════════════════════════════════════
      let isDayHighZoneRejection = false;
      let signalReason = '';
      let useRetestSL = false; // use structural SL for broken-support retest

      // ── PRIORITY 1: Key Resistance Rejection Family ───────────────────────
      if (
        nearDayHighZone &&
        (isRedCandle || isDoji || isGreenShootingStar) &&
        anyP1RejectionCandle &&
        emaFarBelowZone &&
        emaNotSupportAtEntry &&
        rsiNotOversold
      ) {
        signalReason = `Day High Rejection (${rejPatternLabel})`;
        isDayHighZoneRejection = true;
      } else if (
        nearYesterdayHigh &&
        (isRedCandle || isDoji || isGreenShootingStar) &&
        anyP1RejectionCandle &&
        emaFarBelowZone &&
        emaNotSupportAtEntry &&
        rsiNotOversold
      ) {
        signalReason = `Yesterday High Rejection (${rejPatternLabel})`;
        isDayHighZoneRejection = true;
      } else if (
        nearPrevDayClose &&
        (isRedCandle || isDoji || isGreenShootingStar) &&
        anyP1RejectionCandle &&
        emaFarBelowZone &&
        emaNotSupportAtEntry &&
        rsiNotOversold
      ) {
        signalReason = `Prev Day Close Rejection (${rejPatternLabel})`;
        isDayHighZoneRejection = true;
      } else if (nearFirstCandleHigh && anyP1RejectionCandle) {
        signalReason = `Opening Range Rejection (${rejPatternLabel})`;
      } else if (nearSwingHigh && anyP1RejectionCandle) {
        signalReason = `Swing High Rejection (${rejPatternLabel})`;
      }
      // ── PRIORITY 2: EMA Rejection Family ──────────────────────────────────
      else if (bearishOpenAtEMA) {
        signalReason = 'EMA Rejection';
      } else if (emaFakeBreakRejection) {
        signalReason = 'EMA Fake Break Rejection';
      }
      // ── PRIORITY 3: Broken Support Retest Family ───────────────────────────
      else if (brokenFirstCandleLowRetest) {
        signalReason = 'Broken First Candle Low Retest Rejection';
        useRetestSL = true;
      }
      // ── PRIORITY 4: Lower High Breakdown ──────────────────────────────────
      else if (lowerHighBreakdown) {
        signalReason = 'Lower High Breakdown';
      }
      // ── Fallback: general EMA-proximity resistance patterns ───────────────
      else if (weakCloseAtResistance && resistanceTests >= 2)
        signalReason = `Weak Close @ Resistance (${resistanceTests} tests)`;
      else if (earlyRejection) signalReason = 'Early Rejection @ Resistance';
      else if (momentumSlowing) signalReason = 'Momentum Slowing @ Resistance';
      else if (isShootingStar) signalReason = 'Shooting Star @ Resistance';
      else if (isBearishEngulfing)
        signalReason = 'Bearish Engulfing @ Resistance';
      else if (hasStrongRejection)
        signalReason = 'Strong Rejection @ Resistance';

      if (!signalReason) {
        diagLog('v1', '[V1-SKIP]', {
          instrument: instrumentName,
          candleTime: candleDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }),
          candleClose,
          candleEMA,
          nearDayHighZone,
          nearYesterdayHigh,
          nearPrevDayClose,
          nearFirstCandleHigh,
          nearSwingHigh,
          nearEMA,
          anyP1RejectionCandle,
          bearishOpenAtEMA,
          emaFakeBreakRejection,
          brokenFirstCandleLowRetest,
          lowerHighBreakdown,
          dhrRejectionCandle,
          emaFarBelowZone,
          emaNotSupportAtEntry,
          rsiNotOversold,
        });
        continue;
      }

      // First-candle-high gate (no chasing unless RSI > 60 or it's a clean EMA touch rejection)
      const candleRSI = rsiValues[i];
      if (
        actualClose > candles[0].high &&
        !(candleRSI != null && candleRSI > 60) &&
        !emaTouchRejection
      )
        continue;

      // RSI quality gate for non-DHR SELL signals:
      // Require RSI >= minSellRsi (default 45) — the CE must still be at a
      // neutral/elevated level. A low RSI means the option has already sold
      // off heavily; selling into further weakness has elevated whipsaw risk.
      // DHR is exempt: it has its own RSI > 35 not-oversold gate.
      // bearishOpenAtEMA (emaTouchRejection) is also exempt — price explicitly
      // touching the 20 EMA and getting rejected is the cleanest structural sell
      // signal; RSI being low after a morning sell-off does NOT invalidate it.
      if (
        !isDayHighZoneRejection &&
        !bearishOpenAtEMA &&
        candleRSI != null &&
        candleRSI < minSellRsi
      )
        continue;

      // Swing-high-aware SL:
      // 1. Look back up to 10 candles for a session swing high that is:
      //    - above the entry (actualClose)
      //    - below entry + 30 (within the fixed-fallback range)
      //    - at least 8 pts above entry (avoids hair-trigger SL from tiny wicks)
      // 2. If found, SL = swingHigh + 2 (structurally meaningful)
      // 3. Otherwise fall back to fixed entry + 30 (consistent with Signal UI)
      // Target is always 2× risk for 1:2 RRR.
      const MIN_RISK_PTS = 8;
      const FALLBACK_SL_PTS = 30;
      const SL_LOOKBACK = 10;

      const candidateSwings = swingHighs.filter(
        (s) =>
          s.index < actualCandleIndex &&
          s.index >= actualCandleIndex - SL_LOOKBACK &&
          s.price > actualClose &&
          s.price < actualClose + FALLBACK_SL_PTS &&
          s.price + 2 - actualClose >= MIN_RISK_PTS,
      );

      let stopLoss: number;
      let risk: number;

      if (useRetestSL) {
        // Broken support retest: SL above the retested structural level
        stopLoss = Math.max(candleHigh, firstCandleLow) + 2;
        risk = stopLoss - actualClose;
      } else if (candidateSwings.length > 0) {
        // Most recent qualifying swing high
        const nearestSwing = candidateSwings.reduce((a, b) =>
          a.index > b.index ? a : b,
        );
        stopLoss = nearestSwing.price + 2;
        risk = stopLoss - actualClose;
      } else {
        // Fallback: fixed 30 pt SL
        stopLoss = actualClose + FALLBACK_SL_PTS;
        risk = FALLBACK_SL_PTS;
      }
      // Non-DHR patterns: cap at maxSellRiskPts (default 25) — wide SLs in a
      // choppy market lead to oversized losses on whipsaws.
      // DHR keeps its own fixed 40 pt ceiling (structural zone may be distant).
      if (risk > (isDayHighZoneRejection ? 40 : maxSellRiskPts)) continue;

      // SuperTrend trend context filter:
      // trend='up'  → ST line below price = market is in an UPTREND.
      //               SELL signals are counter-trend and low probability UNLESS price
      //               is at a strong structural reversal:
      //                 • dayHighZoneRejection: key day-high resistance (valid even in uptrend)
      //                 • bearishOpenAtEMA: price just explicitly rejected from EMA (EMA = resistance)
      //               Everything else (momentumSlowing, earlyRejection, shootingStar, etc.)
      //               in a bullish-ST context is a bounce off support, not a reversal — skip.
      // trend='down' → ST line above price = market is in a DOWNTREND → SELL is with-trend → allow.
      // Generic: works for any instrument (index, stock, option underlying).
      if (superTrendData) {
        const st = superTrendData[i];
        if (
          st &&
          st.trend === 'up' &&
          !isDayHighZoneRejection &&
          !bearishOpenAtEMA
        )
          continue;
      }

      // EMA support floor: if EMA is below entry and closer than 1× risk,
      // price will likely stall at the EMA before reaching T1 — no 1:1 chance.
      // Applies to ALL patterns including Day-High Zone Rejection:
      // a day-high rejection is only worth taking if there is at least 1R of
      // room between entry and the EMA (i.e. price can retrace to EMA and we
      // still hit T1). The one exception is bearishOpenAtEMA where entry IS
      // the EMA — no floor check needed there.
      if (!bearishOpenAtEMA) {
        if (
          candleEMA != null &&
          candleEMA < actualClose &&
          actualClose - candleEMA < risk
        )
          continue;
      }

      const candleTime = candleDate.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      results.push({
        candleIndex: i,
        actualCandleIndex,
        candleTime,
        candleDate,
        unixTimestamp,
        reason: signalReason,
        entryPrice: actualClose,
        stopLoss,
        risk,
        candleRSI,
        isDayHighZoneRejection,
        nearDayHighZone,
        isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
      });
    }

    return results;
  }

  /**
   * DAY_SELLING_V2 signal detection engine.
   * Three independent setups:
   *   1. Day High Zone Rejection — resistance zone + 20 EMA distance rule
   *   2. Day First Candle Low Break — breakdown below opening candle low
   *   3. 20 EMA Rejection — retrace-to-EMA in confirmed downtrend
   * Completely independent from detectDaySellSignals (V1). Do NOT modify V1.
   */
  private detectDaySellSignalsV2(params: {
    candles: any[];
    emaValues: (number | null)[];
    rsiValues: (number | null)[];
    swingHighs: Array<{ price: number; index: number }>;
    yesterdayHigh: number;
    prevDayLow?: number;
    prevDayClose?: number;
    marginPoints: number;
    maxSellRiskPts?: number;
    realtimeMode?: boolean;
    instrumentName?: string;
    superTrendData?: Array<{ superTrend: number; trend: 'up' | 'down' } | null>;
  }): Array<{
    candleIndex: number;
    actualCandleIndex: number;
    candleTime: string;
    candleDate: Date;
    unixTimestamp: number;
    reason: string;
    entryPrice: number;
    stopLoss: number;
    risk: number;
    candleRSI: number | null;
    isDayHighZoneRejection: boolean;
    nearDayHighZone: boolean;
    isNearDailyHigh: boolean;
  }> {
    const {
      candles,
      emaValues,
      rsiValues,
      swingHighs,
      yesterdayHigh,
      prevDayLow = 0,
      prevDayClose = 0,
      marginPoints,
      maxSellRiskPts = 30,
      realtimeMode = false,
      superTrendData,
    } = params;

    const results: ReturnType<typeof this.detectDaySellSignalsV2> = [];

    diagLog('v2', '[V2-CALL]', {
      instrument: params.instrumentName ?? '',
      candleCount: candles.length,
      realtimeMode,
      yesterdayHigh,
    });

    const scanStartIndex = realtimeMode ? Math.max(3, candles.length - 2) : 3;

    // ── Rolling session high tracker ──────────────────────────────────────
    let rollingHigh = 0;
    let intradayDayHigh = 0; // simply the highest high seen so far

    // ── First candle (9:15) data ──────────────────────────────────────────
    const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
    const firstCandleHigh = candles.length > 0 ? candles[0].high : 0;

    // Confluence guard: if prevDayLow is within marginPoints×2 of first candle low,
    // treat the lower of the two as the real breakdown level.
    const firstCandleLowBreakLevel =
      prevDayLow > 0 &&
      firstCandleLow > 0 &&
      Math.abs(firstCandleLow - prevDayLow) <= marginPoints * 2
        ? Math.min(firstCandleLow, prevDayLow) - 1
        : firstCandleLow;

    let firstCandleLowBreakFired = false;
    for (let pi = 1; pi < scanStartIndex; pi++) {
      if (candles[pi]?.close < firstCandleLowBreakLevel) {
        firstCandleLowBreakFired = true;
        break;
      }
    }

    // Pre-scan: update rollingHigh before the signal window
    for (let pi = 0; pi < scanStartIndex; pi++) {
      if (candles[pi].high > rollingHigh) rollingHigh = candles[pi].high;
    }

    for (let i = scanStartIndex; i < candles.length; i++) {
      const candle = candles[i];
      const candleEMA = emaValues[i];

      // Update rolling session high
      if (candle.high > rollingHigh) rollingHigh = candle.high;
      intradayDayHigh = rollingHigh;

      if (!candleEMA) continue;

      const candleHigh = candle.high;
      const candleLow = candle.low;
      const candleOpen = candle.open;
      const candleClose = candle.close;
      const candleBody = Math.abs(candleClose - candleOpen);
      const upperWick = candleHigh - Math.max(candleOpen, candleClose);
      const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
      const totalRange = candleHigh - candleLow;
      const isRedCandle = candleClose < candleOpen;
      const isGreenCandle = candleClose > candleOpen;

      const candleDate =
        candle.date instanceof Date ? candle.date : new Date(candle.date);
      const hrs = candleDate.getHours();
      const mins = candleDate.getMinutes();
      const minsOfDay = hrs * 60 + mins;
      // Trading window: 9:30 AM – 2:30 PM IST
      if (minsOfDay < 9 * 60 + 30 || minsOfDay > 14 * 60 + 30) continue;

      // ── Per-candle diagnostic (scan-only) ─────────────────────────────────
      diagLog('v2', '[V2-CANDLE]', {
        instrument: params.instrumentName ?? '',
        candleTime: candleDate.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }),
        candleClose,
        candleEMA,
        intradayDayHigh,
        firstCandleLowBreakFired,
        nearFCLow:
          candleClose < firstCandleLowBreakLevel && !firstCandleLowBreakFired,
        isRedCandle,
        candleBody: +candleBody.toFixed(2),
        upperWick: +upperWick.toFixed(2),
        totalRange: +totalRange.toFixed(2),
      });

      const prev1 = i >= 1 ? candles[i - 1] : null;
      const prev2 = i >= 2 ? candles[i - 2] : null;
      const prev3 = i >= 3 ? candles[i - 3] : null;
      const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;
      const nextCandle = i + 1 < candles.length ? candles[i + 1] : null;
      const nextIsRed = nextCandle ? nextCandle.close < nextCandle.open : false;

      // ══════════════════════════════════════════════════════════════════════
      // SETUP 2: Day First Candle Low Break
      // Breakdown below 9:15 candle low with valid bearish candle +
      // no nearby support within 1R of entry.
      // ══════════════════════════════════════════════════════════════════════
      if (
        !firstCandleLowBreakFired &&
        firstCandleLow > 0 &&
        isRedCandle &&
        candleClose < firstCandleLowBreakLevel
      ) {
        // Condition 1: Valid breakdown candle
        const brkLargeBearishBody = candleBody > totalRange * 0.4;
        const brkBearishEngulfing =
          !!prev1 &&
          prev1.close > prev1.open &&
          candleOpen >= prev1.close &&
          candleClose < prev1.open;
        const brkStrongCloseNearLow =
          totalRange > 0 && (candleClose - candleLow) / totalRange < 0.2;
        const brkValidCandle =
          brkLargeBearishBody || brkBearishEngulfing || brkStrongCloseNearLow;

        // EMA must be above the candle — if EMA is below close, it's acting as
        // dynamic support beneath the price. Selling into support is invalid.
        if (!brkValidCandle) {
          // Weak candle — don't set flag, let the next candle retry
          continue;
        }
        if (candleEMA != null && candleEMA < candleClose) {
          // EMA below close (support) — consume flag, no retry
          firstCandleLowBreakFired = true;
          continue;
        }

        // Valid pattern + EMA clear — lock the flag now
        firstCandleLowBreakFired = true;

        // SL: structural level — the broken first candle low is now resistance.
        // Using the structural level (not candleHigh) keeps risk tight and consistent
        // across all candle intervals (1min, 3min, 5min).
        const breakSL = firstCandleLow + 2;
        const breakRisk = breakSL - candleClose;

        // Allow up to 2× normal risk cap — structural SL is valid across all intervals
        if (breakRisk > 0 && breakRisk <= maxSellRiskPts * 2) {
          // Condition 2: No nearby support within 1R below entry
          const brkEMASupport =
            candleEMA != null &&
            candleEMA < candleClose &&
            candleClose - candleEMA < breakRisk;
          const brkPrevDayLowSupport =
            prevDayLow > 0 &&
            prevDayLow < candleClose &&
            candleClose - prevDayLow < breakRisk;
          let brkIntradaySupport = false;
          for (let k = 1; k < i; k++) {
            if (
              candles[k].low < candleClose &&
              candleClose - candles[k].low < breakRisk
            ) {
              brkIntradaySupport = true;
              break;
            }
          }

          if (!brkEMASupport && !brkPrevDayLowSupport && !brkIntradaySupport) {
            const brkPattern = brkBearishEngulfing
              ? 'Bearish Engulfing'
              : brkStrongCloseNearLow
                ? 'Strong Close Near Low'
                : 'Large Bearish Body';
            const breakUnixTs = Math.floor(candleDate.getTime() / 1000) + 19800;
            const breakTime = candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            results.push({
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: breakTime,
              candleDate,
              unixTimestamp: breakUnixTs,
              reason: `V2: 1st Candle Low Break (${brkPattern})`,
              entryPrice: candleClose,
              stopLoss: breakSL,
              risk: breakRisk,
              candleRSI: rsiValues[i],
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh: false,
            });
          }
        }
        continue;
      }

      // ══════════════════════════════════════════════════════════════════════
      // SETUP 1: Day High Zone Rejection
      // Price reaches resistance (session high, prev day high, prev day close,
      // or first candle high zone) and shows a rejection candle.
      // 20 EMA distance rule: entry − EMA ≥ risk (ensures room to target).
      // ══════════════════════════════════════════════════════════════════════

      // Resistance zones
      const nearIntradayHigh =
        intradayDayHigh > 0 &&
        Math.abs(candleHigh - intradayDayHigh) <= marginPoints * 1.5;
      const nearPrevDayHigh =
        yesterdayHigh > 0 &&
        Math.abs(candleHigh - yesterdayHigh) <= marginPoints;
      const nearPrevDayClose =
        prevDayClose > 0 && Math.abs(candleHigh - prevDayClose) <= marginPoints;
      const nearFirstCandleHigh =
        firstCandleHigh > 0 &&
        i > 3 &&
        Math.abs(candleHigh - firstCandleHigh) <= marginPoints;

      const nearAnyResistance =
        nearIntradayHigh ||
        nearPrevDayHigh ||
        nearPrevDayClose ||
        nearFirstCandleHigh;

      // Rejection candle types
      const dhrUpperWick =
        upperWick > candleBody * 1.2 || upperWick > totalRange * 0.4;
      const dhrBearishEngulfing =
        !!prev1 &&
        prev1.close > prev1.open &&
        candleOpen >= prev1.close &&
        candleClose < prev1.open &&
        isRedCandle;
      const dhrStrongBearishClose =
        isRedCandle && candleBody > totalRange * 0.5;
      const dhrRejectionCandle =
        dhrUpperWick || dhrBearishEngulfing || dhrStrongBearishClose || isDoji;

      if (nearAnyResistance && (isRedCandle || isDoji) && dhrRejectionCandle) {
        // SL = candle high + 2
        const dhrSL = candleHigh + 2;
        const dhrRisk = dhrSL - candleClose;

        if (dhrRisk > 0 && dhrRisk <= maxSellRiskPts) {
          // 20 EMA distance rule: entry − EMA ≥ risk
          const emaDistance = candleEMA != null ? candleClose - candleEMA : 0;
          const emaRuleOk = candleEMA != null && emaDistance >= dhrRisk;

          if (emaRuleOk) {
            const dhrZone = nearIntradayHigh
              ? `intraday high ${intradayDayHigh.toFixed(0)}`
              : nearPrevDayHigh
                ? `prev day high ${yesterdayHigh.toFixed(0)}`
                : nearPrevDayClose
                  ? `prev day close ${prevDayClose.toFixed(0)}`
                  : `1st candle high ${firstCandleHigh.toFixed(0)}`;
            const dhrPattern = dhrBearishEngulfing
              ? 'Bearish Engulfing'
              : dhrStrongBearishClose
                ? 'Strong Bearish Close'
                : dhrUpperWick
                  ? 'Long Upper Wick'
                  : 'Doji';
            const dhrUnixTs = Math.floor(candleDate.getTime() / 1000) + 19800;
            const dhrTime = candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            results.push({
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: dhrTime,
              candleDate,
              unixTimestamp: dhrUnixTs,
              reason: `V2: Day High Rejection (${dhrPattern} @ ${dhrZone})`,
              entryPrice: candleClose,
              stopLoss: dhrSL,
              risk: dhrRisk,
              candleRSI: rsiValues[i],
              isDayHighZoneRejection: true,
              nearDayHighZone: nearIntradayHigh,
              isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
            });
            continue; // DHR handled — skip EMA rejection check
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // SETUP 3: 20 EMA Rejection
      // Price is already below EMA (bearish structure), retraces up, touches
      // EMA, and a rejection candle closes back below EMA.
      // Filters: EMA sloping down, not a first-time cross, price not mostly
      // above EMA recently.
      // ══════════════════════════════════════════════════════════════════════
      const nearEMA = Math.abs(candleHigh - candleEMA) <= marginPoints;
      const emaTouchRejection =
        nearEMA &&
        isRedCandle &&
        candleHigh >= candleEMA - marginPoints * 0.5 &&
        candleClose < candleEMA;

      if (emaTouchRejection) {
        // Check 1: bearish structure — most of last 6 candles below EMA
        let belowCount = 0;
        const lookback = Math.min(6, i);
        for (let k = i - lookback; k < i; k++) {
          const ke = emaValues[k];
          if (ke != null && candles[k].close < ke) belowCount++;
        }
        const emaBearishStructure = belowCount >= 3;

        // Check 2: not a first cross — block only when price firmly above (≥4/6 above)
        let aboveCount = 0;
        for (let k = i - lookback; k < i; k++) {
          const ke = emaValues[k];
          if (ke != null && candles[k].close > ke) aboveCount++;
        }
        const emaNotFirmlyAbove = aboveCount < 4;

        // Check 3: EMA sloping down
        const emaSlopingDown =
          i >= 3 &&
          emaValues[i] != null &&
          emaValues[i - 3] != null &&
          (emaValues[i] as number) < (emaValues[i - 3] as number);

        // Check 4: EMA not acting as support (no ≥2 bounces in last 10)
        let emaBounces = 0;
        const supportLookback = Math.min(10, i - 1);
        for (let k = Math.max(0, i - supportLookback); k < i; k++) {
          const ke = emaValues[k];
          if (ke == null) continue;
          const touched =
            Math.abs(candles[k].low - ke) <= marginPoints ||
            Math.abs(candles[k].close - ke) <= marginPoints;
          if (touched) {
            const nk = k + 1 < candles.length ? candles[k + 1] : null;
            if (nk && nk.close > nk.open) emaBounces++;
          }
        }
        const emaNotSupport = emaBounces < 2;

        if (
          emaBearishStructure &&
          emaNotFirmlyAbove &&
          emaSlopingDown &&
          emaNotSupport
        ) {
          const emaSL = candleHigh + 2;
          const emaRisk = emaSL - candleClose;

          if (emaRisk > 0 && emaRisk <= maxSellRiskPts) {
            const emaUnixTs = Math.floor(candleDate.getTime() / 1000) + 19800;
            const emaTime = candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            // Identify rejection pattern
            const emaPattern =
              !!prev1 &&
              prev1.close > prev1.open &&
              candleOpen >= prev1.close &&
              candleClose < prev1.open
                ? 'Bearish Engulfing'
                : upperWick > candleBody * 2 && upperWick > totalRange * 0.5
                  ? 'Shooting Star'
                  : upperWick > candleBody * 1.2
                    ? 'Upper Wick'
                    : 'Strong Bearish';
            results.push({
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: emaTime,
              candleDate,
              unixTimestamp: emaUnixTs,
              reason: `V2: 20 EMA Rejection (${emaPattern})`,
              entryPrice: candleClose,
              stopLoss: emaSL,
              risk: emaRisk,
              candleRSI: rsiValues[i],
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * DAY_SELLING_V1V2 — Combined fallback engine.
   * Runs V1 first on every candle. If V1 produces no signal for that candle,
   * V2 is tried as a fallback. Both engines receive IDENTICAL data (same candles,
   * same EMA/RSI arrays, same prev-day levels). A candle can only produce one
   * signal (V1 takes priority).
   */
  private detectDaySellSignalsCombined(
    params: Parameters<typeof this.detectDaySellSignals>[0],
  ): ReturnType<typeof this.detectDaySellSignals> {
    // Run both engines on ALL candles with the same data
    const v1Signals = this.detectDaySellSignals(params);
    const v2Signals = this.detectDaySellSignalsV2(params);

    // Build a set of candle indices already claimed by V1
    const v1Indices = new Set(v1Signals.map((s) => s.actualCandleIndex));

    // Keep V2 signals only for candles where V1 was silent
    const v2Fallback = v2Signals.filter(
      (s) => !v1Indices.has(s.actualCandleIndex),
    );

    // Merge and sort by candle index so signals are in time order
    const combined = [...v1Signals, ...v2Fallback];
    combined.sort((a, b) => a.actualCandleIndex - b.actualCandleIndex);
    return combined;
  }

  /**
   * DAY_SELLING_V3 — 4-Engine sell signal detection.
   * Implements the full strategy from docs/new-strategy.md (V3).
   * Engines: First Candle Breakdown | Resistance Rejection | EMA Rejection | Lower High Breakdown
   * Completely independent from V1 and V2. Do NOT modify V1 or V2.
   */
  private detectDaySellSignalsV3(params: {
    candles: any[];
    emaValues: (number | null)[];
    rsiValues: (number | null)[];
    swingHighs: Array<{ price: number; index: number }>;
    yesterdayHigh: number;
    prevDayLow?: number;
    prevDayClose?: number;
    marginPoints: number;
    maxSellRiskPts?: number;
    realtimeMode?: boolean;
    instrumentName?: string;
    superTrendData?: Array<{ superTrend: number; trend: 'up' | 'down' } | null>;
  }): Array<{
    candleIndex: number;
    actualCandleIndex: number;
    candleTime: string;
    candleDate: Date;
    unixTimestamp: number;
    reason: string;
    entryPrice: number;
    stopLoss: number;
    risk: number;
    candleRSI: number | null;
    isDayHighZoneRejection: boolean;
    nearDayHighZone: boolean;
    isNearDailyHigh: boolean;
  }> {
    const {
      candles,
      emaValues,
      rsiValues,
      swingHighs,
      yesterdayHigh,
      prevDayLow = 0,
      prevDayClose = 0,
      marginPoints,
      maxSellRiskPts = 35,
      realtimeMode = false,
      superTrendData,
    } = params;

    const results: ReturnType<typeof this.detectDaySellSignalsV3> = [];
    const scanStartIndex = realtimeMode ? Math.max(3, candles.length - 2) : 3;

    const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
    const firstCandleHigh = candles.length > 0 ? candles[0].high : 0;

    let rollingHigh = 0;
    for (let pi = 0; pi < scanStartIndex; pi++) {
      if (candles[pi].high > rollingHigh) rollingHigh = candles[pi].high;
    }

    // Allow up to 3 first-candle breakdown attempts
    let firstCandleLowBreakCount = 0;
    const maxBreakdownAttempts = 3;

    // Signal cooldown and zone memory
    let lastSignalIndex = -999;
    let lastSignalPrice = 0;

    // ── Fixed zone margin (static, instrument-agnostic) ───────────────────
    const zoneMargin = marginPoints;

    // ── Session-level zone usage memory (one clean rejection per zone) ────
    const usedZones = {
      intradayHigh: false,
      prevDayHigh: false,
      prevDayClose: false,
      firstCandleHigh: false,
    };
    const usedSwingHighLevels = new Set<number>();

    // ── Helper: has a swing high been broken (close decisively above it) ──
    const isSwingBroken = (
      sh: { price: number; index: number },
      upToIndex: number,
    ): boolean => {
      const breakBuffer = zoneMargin * 0.5;
      for (let k = sh.index + 1; k < upToIndex; k++) {
        if (candles[k].close > sh.price + breakBuffer) return true;
      }
      return false;
    };

    // ── Helper: is a swing high still relevant (recent, valid pivot) ──────
    const isSwingRelevant = (
      sh: { price: number; index: number },
      currentIndex: number,
    ): boolean => {
      const maxBarsAge = 40;
      if (currentIndex - sh.index > maxBarsAge) return false;
      const leftOk = sh.index >= 1 && candles[sh.index - 1].high < sh.price;
      const rightOk =
        sh.index + 1 < currentIndex && candles[sh.index + 1].high < sh.price;
      return leftOk && rightOk;
    };

    // ── Helper: find nearest valid unbroken swing high within zone ────────
    const findMatchedSwingHigh = (
      candleHighValue: number,
      currentIndex: number,
    ): { price: number; index: number } | null => {
      const minBarsAfterSwing = 3;
      const swingZoneMargin = zoneMargin * 0.75;
      const candidates = swingHighs
        .filter((sh) => sh.index < currentIndex - minBarsAfterSwing)
        .filter((sh) => isSwingRelevant(sh, currentIndex))
        .filter((sh) => Math.abs(candleHighValue - sh.price) <= swingZoneMargin)
        .filter((sh) => !isSwingBroken(sh, currentIndex));
      if (candidates.length === 0) return null;
      // Prefer more recent pivot; break ties by higher price
      candidates.sort((a, b) =>
        b.index !== a.index ? b.index - a.index : b.price - a.price,
      );
      return candidates[0];
    };

    for (let i = scanStartIndex; i < candles.length; i++) {
      const candle = candles[i];
      const candleEMA = emaValues[i];
      if (!candleEMA) continue;

      // Use previous rolling high so a new-high candle is not treated as DHR
      const prevRollingHigh = rollingHigh;
      const intradayDayHigh = prevRollingHigh;

      const candleHigh = candle.high;
      const candleLow = candle.low;
      const candleOpen = candle.open;
      const candleClose = candle.close;
      const candleBody = Math.abs(candleClose - candleOpen);
      const upperWick = candleHigh - Math.max(candleOpen, candleClose);
      const totalRange = candleHigh - candleLow;
      const isRedCandle = candleClose < candleOpen;
      const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;

      const candleDate =
        candle.date instanceof Date ? candle.date : new Date(candle.date);
      const hrs = candleDate.getHours();
      const mins = candleDate.getMinutes();
      const minsOfDay = hrs * 60 + mins;
      // Trade window: 9:25 AM – 2:45 PM IST
      if (minsOfDay < 9 * 60 + 25 || minsOfDay > 14 * 60 + 45) continue;

      const prev1 = i >= 1 ? candles[i - 1] : null;
      const prev2 = i >= 2 ? candles[i - 2] : null;
      const candleRSI = rsiValues[i];

      // ── Signal cooldown: block new signal for 5 candles ──────────────────
      if (i - lastSignalIndex < 5) continue;

      // ── Zone memory: block repeated signals at same price zone ────────────
      if (
        lastSignalPrice > 0 &&
        Math.abs(candleHigh - lastSignalPrice) <= zoneMargin
      )
        continue;

      // ── Uptrend filter ────────────────────────────────────────────────────
      // If >60% of last 20 candles are above EMA → uptrend → only resistance/EMA rejection
      const lookback20 = Math.min(20, i);
      let aboveEMACount = 0;
      for (let k = i - lookback20; k < i; k++) {
        const ke = emaValues[k];
        if (ke != null && candles[k].close > ke) aboveEMACount++;
      }
      const isUptrend = lookback20 > 0 && aboveEMACount / lookback20 > 0.6;

      // ── SuperTrend filter ─────────────────────────────────────────────────
      const stEntry = superTrendData ? superTrendData[i] : null;
      const isSuperTrendUp = stEntry ? stEntry.trend === 'up' : false;

      // ── Strong trend filter ───────────────────────────────────────────────
      const strongTrend =
        i >= 6 &&
        emaValues[i] != null &&
        emaValues[i - 3] != null &&
        emaValues[i - 6] != null &&
        (emaValues[i] as number) > (emaValues[i - 3] as number) &&
        (emaValues[i - 3] as number) > (emaValues[i - 6] as number);

      if (strongTrend && candleClose > candleEMA) continue;

      // ── Resistance zones ──────────────────────────────────────────────────
      const nearIntradayHigh =
        intradayDayHigh > 0 &&
        Math.abs(candleHigh - intradayDayHigh) <= zoneMargin;
      const nearPrevDayHigh =
        yesterdayHigh > 0 && Math.abs(candleHigh - yesterdayHigh) <= zoneMargin;
      const nearPrevDayClose =
        prevDayClose > 0 && Math.abs(candleHigh - prevDayClose) <= zoneMargin;
      const nearFirstCandleHigh =
        firstCandleHigh > 0 &&
        i > 3 &&
        Math.abs(candleHigh - firstCandleHigh) <= zoneMargin;
      const matchedSwingHigh = findMatchedSwingHigh(candleHigh, i);
      const nearSwingHigh = !!matchedSwingHigh;
      const nearAnyResistance =
        nearIntradayHigh ||
        nearPrevDayHigh ||
        nearPrevDayClose ||
        nearFirstCandleHigh ||
        nearSwingHigh;

      // Helpers
      const makeTs = () => Math.floor(candleDate.getTime() / 1000) + 19800;
      const makeTime = () =>
        candleDate.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });

      // ── Strong bull run filter ─────────────────────────────────────────
      const strongBullRun =
        i >= 4 &&
        candles[i - 1].close > candles[i - 1].open &&
        candles[i - 2].close > candles[i - 2].open &&
        candles[i - 3].close > candles[i - 3].open &&
        candles[i - 1].high > candles[i - 2].high &&
        candles[i - 2].high > candles[i - 3].high;

      if (strongBullRun && candleClose > candleEMA) continue;

      // ── Market regime classifier ──────────────────────────────────────────
      const emaDown =
        i >= 3 &&
        emaValues[i] != null &&
        emaValues[i - 1] != null &&
        emaValues[i - 2] != null &&
        emaValues[i - 3] != null &&
        emaValues[i]! < emaValues[i - 1]! &&
        emaValues[i - 1]! <= emaValues[i - 2]! &&
        emaValues[i - 2]! <= emaValues[i - 3]!;

      const emaUp =
        i >= 3 &&
        emaValues[i] != null &&
        emaValues[i - 1] != null &&
        emaValues[i - 2] != null &&
        emaValues[i - 3] != null &&
        emaValues[i]! > emaValues[i - 1]! &&
        emaValues[i - 1]! >= emaValues[i - 2]! &&
        emaValues[i - 2]! >= emaValues[i - 3]!;

      const lbRegime = Math.min(12, i);
      let aboveCount = 0;
      let belowCountRegime = 0;
      for (let k = i - lbRegime; k < i; k++) {
        const ke = emaValues[k];
        if (ke != null) {
          if (candles[k].close > ke) aboveCount++;
          if (candles[k].close < ke) belowCountRegime++;
        }
      }
      const priceMostlyAboveEMA = lbRegime > 0 && aboveCount / lbRegime >= 0.6;
      const priceMostlyBelowEMA =
        lbRegime > 0 && belowCountRegime / lbRegime >= 0.6;
      const bullishRegime = emaUp && priceMostlyAboveEMA;
      const bearishRegime = emaDown && priceMostlyBelowEMA;

      // ── Regime diagnostics ──────────────────────────────────────────
      diagLog('v3', '[V3-REGIME-DIAG]', {
        instrument: params.instrumentName ?? 'unknown',
        candleTime: makeTime(),
        candleClose,
        candleEMA,
        emaNow: emaValues[i],
        emaPrev1: emaValues[i - 1],
        emaPrev2: emaValues[i - 2],
        emaPrev3: emaValues[i - 3],
        emaUp,
        emaDown,
        priceMostlyAboveEMA,
        priceMostlyBelowEMA,
        bullishRegime,
        bearishRegime,
        isUptrend,
        strongTrend,
        strongBullRun,
      });

      let bestSignal: (typeof results)[0] | null = null;
      let signalZoneRef = candleHigh; // zone reference for duplicate suppression

      // ── Shared bearish rejection confirmation (reused by all P1 zone branches) ──
      const rejUpperWick =
        upperWick > candleBody * 1.5 || upperWick > totalRange * 0.4;
      const rejBearishEngulf =
        !!prev1 &&
        prev1.close > prev1.open &&
        candleOpen >= prev1.close &&
        candleClose < prev1.open &&
        isRedCandle;
      const rejShootingStar =
        upperWick > totalRange * 0.5 &&
        upperWick > candleBody * 2 &&
        candleLow > candleOpen - totalRange * 0.1;
      const rejStrongBearish = isRedCandle && candleBody > totalRange * 0.5;
      const candleRejection =
        rejUpperWick ||
        rejBearishEngulf ||
        rejShootingStar ||
        rejStrongBearish ||
        isDoji;
      const lowerHighForming = !!prev1 && !!prev2 && prev1.high < prev2.high;
      const weakCloseFromHigh =
        totalRange > 0 && (candleHigh - candleClose) / totalRange >= 0.4;
      const noRecentBullRun = !(
        i >= 3 &&
        candles[i - 1].close > candles[i - 1].open &&
        candles[i - 2].close > candles[i - 2].open &&
        candles[i - 3].close > candles[i - 3].open
      );
      const inBullishContext = isUptrend || bullishRegime;
      const dhrBearishContext = bearishRegime || (emaDown && lowerHighForming);
      const candlePattern = rejBearishEngulf
        ? 'Bearish Engulfing'
        : rejShootingStar
          ? 'Shooting Star'
          : rejUpperWick
            ? 'Long Upper Wick'
            : rejStrongBearish
              ? 'Strong Bearish'
              : 'Doji';

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 1a: Intraday High Rejection
      // Requires: strict proximity + weak close + no bullish context + bearish regime
      // ════════════════════════════════════════════════════════════════════
      if (
        !bestSignal &&
        nearIntradayHigh &&
        !usedZones.intradayHigh &&
        candleRejection &&
        weakCloseFromHigh &&
        !inBullishContext &&
        dhrBearishContext
      ) {
        const sl = candleHigh + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          let score = 4;
          if (nearPrevDayHigh) score += 1; // confluence with prev day high
          if (lowerHighForming) score += 2;
          if (candleRSI != null && candleRSI > 50) score += 1;
          if (score >= 4) {
            signalZoneRef = intradayDayHigh;
            bestSignal = {
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: makeTime(),
              candleDate,
              unixTimestamp: makeTs(),
              reason: `V3: Day High Rejection (${candlePattern} @ intraday high ${intradayDayHigh.toFixed(0)})`,
              entryPrice: candleClose,
              stopLoss: sl,
              risk,
              candleRSI,
              isDayHighZoneRejection: true,
              nearDayHighZone: true,
              isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
            };
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 1b: Prev Day High Rejection
      // ════════════════════════════════════════════════════════════════════
      if (
        !bestSignal &&
        nearPrevDayHigh &&
        !usedZones.prevDayHigh &&
        candleRejection &&
        weakCloseFromHigh &&
        !inBullishContext &&
        dhrBearishContext
      ) {
        const sl = candleHigh + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          let score = 4;
          if (lowerHighForming) score += 2;
          if (candleRSI != null && candleRSI > 50) score += 1;
          if (score >= 4) {
            signalZoneRef = yesterdayHigh;
            bestSignal = {
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: makeTime(),
              candleDate,
              unixTimestamp: makeTs(),
              reason: `V3: Prev Day High Rejection (${candlePattern} @ prev day high ${yesterdayHigh.toFixed(0)})`,
              entryPrice: candleClose,
              stopLoss: sl,
              risk,
              candleRSI,
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
            };
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 1c: Prev Day Close Rejection
      // Requires bearish structure (regime/emaDown/lowerHigh) + not bullish context
      // ════════════════════════════════════════════════════════════════════
      if (
        !bestSignal &&
        nearPrevDayClose &&
        !usedZones.prevDayClose &&
        candleRejection &&
        !inBullishContext
      ) {
        const pdcBearishContext = bearishRegime || emaDown || lowerHighForming;
        if (pdcBearishContext) {
          const sl = candleHigh + 2;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            let score = 2;
            if (lowerHighForming) score += 2;
            if (candleRSI != null && candleRSI > 50) score += 1;
            if (rejUpperWick || rejBearishEngulf) score += 1;
            if (weakCloseFromHigh) score += 1;
            if (score >= 4) {
              signalZoneRef = prevDayClose;
              bestSignal = {
                candleIndex: i,
                actualCandleIndex: i,
                candleTime: makeTime(),
                candleDate,
                unixTimestamp: makeTs(),
                reason: `V3: Prev Day Close Rejection (${candlePattern} @ prev day close ${prevDayClose.toFixed(0)})`,
                entryPrice: candleClose,
                stopLoss: sl,
                risk,
                candleRSI,
                isDayHighZoneRejection: false,
                nearDayHighZone: false,
                isNearDailyHigh:
                  Math.abs(rollingHigh - candleHigh) <= zoneMargin,
              };
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 1d: First Candle High Rejection
      // ════════════════════════════════════════════════════════════════════
      if (
        !bestSignal &&
        nearFirstCandleHigh &&
        !usedZones.firstCandleHigh &&
        candleRejection &&
        !inBullishContext
      ) {
        const fchBearishContext = bearishRegime || emaDown || lowerHighForming;
        if (fchBearishContext) {
          const sl = candleHigh + 2;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            let score = 2;
            if (lowerHighForming) score += 2;
            if (candleRSI != null && candleRSI > 50) score += 1;
            if (rejUpperWick || rejBearishEngulf) score += 1;
            if (weakCloseFromHigh) score += 1;
            if (score >= 4) {
              signalZoneRef = firstCandleHigh;
              bestSignal = {
                candleIndex: i,
                actualCandleIndex: i,
                candleTime: makeTime(),
                candleDate,
                unixTimestamp: makeTs(),
                reason: `V3: Opening Range Rejection (${candlePattern} @ 1st candle high ${firstCandleHigh.toFixed(0)})`,
                entryPrice: candleClose,
                stopLoss: sl,
                risk,
                candleRSI,
                isDayHighZoneRejection: false,
                nearDayHighZone: false,
                isNearDailyHigh:
                  Math.abs(rollingHigh - candleHigh) <= zoneMargin,
              };
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 1e: Swing High Rejection
      // Requires strong bearish context (same standard as intraday high)
      // ════════════════════════════════════════════════════════════════════
      if (
        !bestSignal &&
        nearSwingHigh &&
        matchedSwingHigh != null &&
        !usedSwingHighLevels.has(matchedSwingHigh.price) &&
        candleRejection &&
        !inBullishContext &&
        dhrBearishContext
      ) {
        const sl = candleHigh + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          let score = 2;
          if (lowerHighForming) score += 2;
          if (candleRSI != null && candleRSI > 50) score += 1;
          if (rejUpperWick || rejBearishEngulf) score += 1;
          if (weakCloseFromHigh) score += 1;
          if (score >= 4) {
            signalZoneRef = matchedSwingHigh.price;
            bestSignal = {
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: makeTime(),
              candleDate,
              unixTimestamp: makeTs(),
              reason: `V3: Swing High Rejection (${candlePattern} @ swing high ${matchedSwingHigh.price.toFixed(0)})`,
              entryPrice: candleClose,
              stopLoss: sl,
              risk,
              candleRSI,
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
            };
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 2: EMA Rejection (allowed even in uptrend / ST up)
      // ════════════════════════════════════════════════════════════════════
      if (!bestSignal) {
        const nearEMA = Math.abs(candleHigh - candleEMA) <= zoneMargin;
        const emaTouchRejection =
          nearEMA &&
          isRedCandle &&
          candleHigh >= candleEMA - zoneMargin * 0.5 &&
          candleClose < candleEMA;

        if (emaTouchRejection && (candleRSI == null || candleRSI >= 40)) {
          const lb6 = Math.min(6, i);
          let belowCount = 0;
          for (let k = i - lb6; k < i; k++) {
            const ke = emaValues[k];
            if (ke != null && candles[k].close < ke) belowCount++;
          }
          const emaSlopingDown =
            i >= 3 &&
            emaValues[i] != null &&
            emaValues[i - 3] != null &&
            (emaValues[i] as number) < (emaValues[i - 3] as number);

          let emaBounces = 0;
          const lbSupp = Math.min(10, i - 1);
          for (let k = Math.max(0, i - lbSupp); k < i; k++) {
            const ke = emaValues[k];
            if (ke == null) continue;
            if (
              Math.abs(candles[k].low - ke) <= zoneMargin ||
              Math.abs(candles[k].close - ke) <= zoneMargin
            ) {
              const nk = k + 1 < candles.length ? candles[k + 1] : null;
              if (nk && nk.close > nk.open) emaBounces++;
            }
          }

          const bodyOk = candleBody >= totalRange * 0.3;

          // ── V3 EMA Rejection Diagnostics ─────────────────────────────
          if (nearEMA) {
            const score =
              1 +
              (lowerHighForming ? 2 : 0) +
              (candleRSI != null && candleRSI > 50 ? 1 : 0) +
              (nearAnyResistance ? 2 : 0);
            diagLog('v3', '[V3-EMA-DIAG]', {
              instrument: params.instrumentName ?? 'unknown',
              candleTime: makeTime(),
              candleHigh,
              candleClose,
              candleEMA,
              nearEMA,
              isRedCandle,
              closeBelowEMA: candleClose < candleEMA,
              candleRSI,
              candleBody: +candleBody.toFixed(2),
              totalRange: +totalRange.toFixed(2),
              bodyOk,
              lowerHighForming,
              noRecentBullRun,
              belowCount,
              emaSlopingDown,
              emaBounces,
              isUptrend,
              nearAnyResistance,
              score,
              passed:
                bodyOk &&
                lowerHighForming &&
                noRecentBullRun &&
                (bearishRegime || emaSlopingDown) &&
                belowCount >= 2 &&
                emaBounces < 2 &&
                score >= 3,
              failReasons: [
                !bodyOk && 'bodyOk=false',
                !lowerHighForming && 'lowerHighForming=false',
                !noRecentBullRun && 'noRecentBullRun=false',
                !(bearishRegime || emaSlopingDown) &&
                  'bearishRegime=false AND !emaSlopingDown',
                belowCount < 2 && `belowCount=${belowCount}<2`,
                emaBounces >= 2 && `emaBounces=${emaBounces}>=2`,
                score < 3 && `score=${score}<3`,
              ].filter(Boolean),
            });
          }
          // ─────────────────────────────────────────────────────────────

          if (
            !bullishRegime &&
            (bearishRegime || emaSlopingDown) &&
            candleBody >= totalRange * 0.3 &&
            lowerHighForming &&
            noRecentBullRun &&
            belowCount >= 2 &&
            emaBounces < 2
          ) {
            const sl = candleHigh + 2;
            const risk = sl - candleClose;
            if (risk > 0 && risk <= maxSellRiskPts) {
              let score = 0;
              score += 1; // EMA rejection
              if (lowerHighForming) score += 2; // lower high structure
              if (candleRSI != null && candleRSI > 50) score += 1;
              if (nearAnyResistance) score += 2; // resistance confluence
              if (score >= 3) {
                const pattern =
                  !!prev1 &&
                  prev1.close > prev1.open &&
                  candleOpen >= prev1.close &&
                  candleClose < prev1.open
                    ? 'Bearish Engulfing'
                    : upperWick > candleBody * 2 && upperWick > totalRange * 0.5
                      ? 'Shooting Star'
                      : upperWick > candleBody * 1.2
                        ? 'Upper Wick'
                        : 'Strong Bearish';
                signalZoneRef = candleEMA;
                bestSignal = {
                  candleIndex: i,
                  actualCandleIndex: i,
                  candleTime: makeTime(),
                  candleDate,
                  unixTimestamp: makeTs(),
                  reason: `V3: EMA Rejection (${pattern})`,
                  entryPrice: candleClose,
                  stopLoss: sl,
                  risk,
                  candleRSI,
                  isDayHighZoneRejection: false,
                  nearDayHighZone: false,
                  isNearDailyHigh:
                    Math.abs(rollingHigh - candleHigh) <= zoneMargin,
                };
              }
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 2b: EMA Fake Break Rejection
      // Candle pushes above EMA intrabar but closes back below → bull trap.
      // Quality standard matches P2 EMA Rejection — not a loose fallback.
      // ════════════════════════════════════════════════════════════════════
      if (!bestSignal) {
        const fakeBreakAboveEMA =
          candleHigh > candleEMA && candleClose < candleEMA;

        if (fakeBreakAboveEMA) {
          // Compute belowCount for context
          const lb6fb = Math.min(6, i);
          let belowCountFb = 0;
          for (let k = i - lb6fb; k < i; k++) {
            const ke = emaValues[k];
            if (ke != null && candles[k].close < ke) belowCountFb++;
          }

          // Use 3-period EMA slope — same standard as P2 EMA Rejection
          const emaSlopingDownFb =
            i >= 3 &&
            emaValues[i] != null &&
            emaValues[i - 3] != null &&
            (emaValues[i] as number) < (emaValues[i - 3] as number);

          // Rejection confirmation: meaningful upper wick above EMA
          const wickAboveEMA = candleHigh - candleEMA;
          const rejectionWick =
            wickAboveEMA > 0 &&
            (upperWick > candleBody * 1.2 || upperWick > totalRange * 0.35);

          // EMA bounce count — prevent signals when EMA has been acting as support
          let emaBouncesFb = 0;
          const lbSuppFb = Math.min(10, i - 1);
          for (let k = Math.max(0, i - lbSuppFb); k < i; k++) {
            const ke = emaValues[k];
            if (ke == null) continue;
            if (
              Math.abs(candles[k].low - ke) <= zoneMargin ||
              Math.abs(candles[k].close - ke) <= zoneMargin
            ) {
              const nk = k + 1 < candles.length ? candles[k + 1] : null;
              if (nk && nk.close > nk.open) emaBouncesFb++;
            }
          }

          if (
            !bullishRegime &&
            (bearishRegime || emaSlopingDownFb) &&
            rejectionWick &&
            lowerHighForming &&
            noRecentBullRun &&
            belowCountFb >= 2 &&
            emaBouncesFb < 2 &&
            (candleRSI == null || candleRSI >= 35)
          ) {
            const sl = candleHigh + 2;
            const risk = sl - candleClose;
            if (risk > 0 && risk <= maxSellRiskPts) {
              let score = 0;
              score += 2; // fake break above EMA = strong signal
              if (emaSlopingDownFb) score += 1; // EMA slope bearish
              if (belowCountFb >= 3) score += 1; // price predominantly below EMA
              if (candleRSI != null && candleRSI > 50) score += 1; // RSI overbought
              if (nearAnyResistance) score += 1; // near resistance
              if (lowerHighForming) score += 1; // lower high structure
              if (score >= 3) {
                const pattern = isRedCandle
                  ? !!prev1 &&
                    prev1.close > prev1.open &&
                    candleOpen >= prev1.close &&
                    candleClose < prev1.open
                    ? 'Bearish Engulfing'
                    : 'Bearish Fake Break'
                  : 'Bullish Fake Break (Green)';
                signalZoneRef = candleEMA;
                bestSignal = {
                  candleIndex: i,
                  actualCandleIndex: i,
                  candleTime: makeTime(),
                  candleDate,
                  unixTimestamp: makeTs(),
                  reason: `V3: EMA Fake Break Rejection (${pattern})`,
                  entryPrice: candleClose,
                  stopLoss: sl,
                  risk,
                  candleRSI,
                  isDayHighZoneRejection: false,
                  nearDayHighZone: false,
                  isNearDailyHigh:
                    Math.abs(rollingHigh - candleHigh) <= zoneMargin,
                };
              }
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 4: Broken First Candle Low Retest Rejection
      // Bucket A — rejection/retest engine: runs BEFORE the early-skip block
      // so it is evaluated even on uptrend/SuperTrend days.
      // ════════════════════════════════════════════════════════════════════
      if (!bestSignal && firstCandleLow > 0) {
        const firstCandleLowBrokenEarlier =
          i > 1 && candles.slice(1, i).some((c) => c.close < firstCandleLow);

        const nearBrokenFirstCandleLow =
          Math.abs(candleHigh - firstCandleLow) <= zoneMargin;

        const failedRetestOfFirstCandleLow =
          candleHigh >= firstCandleLow - zoneMargin * 0.5 &&
          candleClose < firstCandleLow;

        const retestRejection =
          isRedCandle &&
          (upperWick > candleBody * 1.2 || candleBody > totalRange * 0.4);

        const lowerHighFormingP4 =
          !!prev1 && !!prev2 && prev1.high < prev2.high;

        const bearishRetestContext =
          bearishRegime || emaDown || lowerHighFormingP4;

        if (
          firstCandleLowBrokenEarlier &&
          nearBrokenFirstCandleLow &&
          failedRetestOfFirstCandleLow &&
          retestRejection &&
          bearishRetestContext
        ) {
          const sl = Math.max(candleHigh, firstCandleLow) + 2;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            signalZoneRef = firstCandleLow;
            bestSignal = {
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: makeTime(),
              candleDate,
              unixTimestamp: makeTs(),
              reason: `V3: Broken First Candle Low Retest Rejection`,
              entryPrice: candleClose,
              stopLoss: sl,
              risk,
              candleRSI,
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
            };
          }
        }
      }

      // ── Early-skip block ─────────────────────────────────────────────────
      // Bucket A engines (P1, P2, P2b, P4) have already run above.
      // Bucket B continuation engines (P3, P5) are skipped in uptrend/ST-up.
      if (isUptrend || isSuperTrendUp) {
        if (bestSignal) results.push(bestSignal);
        continue;
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 3: Lower High Breakdown
      // Bucket B — continuation engine: only runs when not in uptrend/ST-up
      // ════════════════════════════════════════════════════════════════════
      if (!bestSignal && !!prev1 && !!prev2) {
        const lowerHighPattern =
          candle.high < prev1.high && prev1.high < prev2.high;
        const rejectEMA =
          Math.abs(candle.high - candleEMA) <= zoneMargin * 1.5 &&
          candleClose < candleEMA;

        if (
          !bullishRegime &&
          bearishRegime &&
          lowerHighPattern &&
          isRedCandle &&
          rejectEMA &&
          (candleRSI == null || candleRSI >= 40)
        ) {
          const pullbackHigh = Math.max(prev1.high, candle.high);
          const sl = pullbackHigh + 2;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            let score = 0;
            score += 2; // lower high structure
            score += 1; // EMA rejection
            if (candleRSI != null && candleRSI > 50) score += 1;
            if (nearAnyResistance) score += 2;
            if (score >= 3) {
              signalZoneRef = pullbackHigh;
              bestSignal = {
                candleIndex: i,
                actualCandleIndex: i,
                candleTime: makeTime(),
                candleDate,
                unixTimestamp: makeTs(),
                reason: `V3: Lower High Breakdown`,
                entryPrice: candleClose,
                stopLoss: sl,
                risk,
                candleRSI,
                isDayHighZoneRejection: false,
                nearDayHighZone: false,
                isNearDailyHigh:
                  Math.abs(rollingHigh - candleHigh) <= zoneMargin,
              };
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 5: First Candle Breakdown (up to 3 attempts)
      // ════════════════════════════════════════════════════════════════════
      if (
        !bestSignal &&
        firstCandleLow > 0 &&
        firstCandleLowBreakCount < maxBreakdownAttempts &&
        isRedCandle &&
        candleClose < firstCandleLow
      ) {
        firstCandleLowBreakCount++;

        const brkLargeBearishBody = candleBody > totalRange * 0.4;
        const brkBearishEngulf =
          !!prev1 &&
          prev1.close > prev1.open &&
          candleOpen >= prev1.close &&
          candleClose < prev1.open;
        const brkStrongCloseNearLow =
          totalRange > 0 && (candleClose - candleLow) / totalRange < 0.2;
        const brkValidCandle =
          brkLargeBearishBody || brkBearishEngulf || brkStrongCloseNearLow;

        if (
          brkValidCandle &&
          (candleEMA == null || candleEMA >= candleClose) &&
          (candleRSI == null || candleRSI >= 40)
        ) {
          const sl = Math.max(candleHigh, firstCandleLow) + 2;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            // Support protection: no support within 1R below entry
            const emaSupport =
              candleEMA != null &&
              candleEMA < candleClose &&
              candleClose - candleEMA < risk;
            const prevDayLowSupport =
              prevDayLow > 0 &&
              prevDayLow < candleClose &&
              candleClose - prevDayLow < risk;
            let intradaySupport = false;
            for (let k = 1; k < i; k++) {
              if (
                candles[k].low < candleClose &&
                candleClose - candles[k].low < risk
              ) {
                intradaySupport = true;
                break;
              }
            }

            if (!emaSupport && !prevDayLowSupport && !intradaySupport) {
              let score = 0;
              if (nearAnyResistance) score += 2;
              if (candleRSI != null && candleRSI > 50) score += 1;
              if (brkBearishEngulf) score += 2;
              else if (brkLargeBearishBody) score += 1;
              if (score >= 3) {
                const brkPattern = brkBearishEngulf
                  ? 'Bearish Engulfing'
                  : brkStrongCloseNearLow
                    ? 'Strong Close Near Low'
                    : 'Large Bearish Body';
                bestSignal = {
                  candleIndex: i,
                  actualCandleIndex: i,
                  candleTime: makeTime(),
                  candleDate,
                  unixTimestamp: makeTs(),
                  reason: `V3: 1st Candle Low Break (${brkPattern}, attempt ${firstCandleLowBreakCount})`,
                  entryPrice: candleClose,
                  stopLoss: sl,
                  risk,
                  candleRSI,
                  isDayHighZoneRejection: false,
                  nearDayHighZone: false,
                  isNearDailyHigh: false,
                };
              }
            }
          }
        }
      }

      if (bestSignal) {
        results.push(bestSignal);
        lastSignalIndex = i;
        lastSignalPrice = signalZoneRef;
        // Mark the triggering zone as used for this session
        if (nearIntradayHigh) usedZones.intradayHigh = true;
        if (nearPrevDayHigh) usedZones.prevDayHigh = true;
        if (nearPrevDayClose) usedZones.prevDayClose = true;
        if (nearFirstCandleHigh) usedZones.firstCandleHigh = true;
        if (nearSwingHigh && matchedSwingHigh) {
          usedSwingHighLevels.add(matchedSwingHigh.price);
        }
      }

      // Update rolling high AFTER signal evaluation so a new-high candle
      // is only available as DHR reference from the NEXT iteration.
      if (candle.high > rollingHigh) rollingHigh = candle.high;
    }

    return results;
  }

  /**
   * DAY_SELLING_V4 — 6-scenario sell signal detection on option candle data.
   *
   * Works purely on the option chart (CE or PE premium), no NIFTY-spot required.
   * Activates only when the instrument opens BELOW the 20 EMA.
   *
   * Scenarios:
   *  1. FIRST_CANDLE_PULLBACK_SELL       — super-bearish FC + pullback rejection at FC top
   *  2. FIRST_CANDLE_RETRACEMENT_SELL    — large FC + 50 % / 61.8 % retracement sell
   *  3. FIRST_CANDLE_LOW_BREAK_SELL      — FC-low breakdown (false-breakdown-aware)
   *  4. EMA_REJECTION_SELL               — 20 EMA acting as resistance; pullback rejection
   *  5. EMA_FAKE_BREAK_SELL              — failed breakout above 20 EMA / VWAP
   *  6. FIRST_HOUR_HIGH_REJECTION_SELL   — sideways fallback: first 1-hr high rejection
   */
  private detectDaySellSignalsV4(params: {
    candles: any[];
    ema8Values: (number | null)[];
    ema20Values: (number | null)[];
    vwapValues: number[];
    superTrendData: Array<{ superTrend: number; trend: 'up' | 'down' } | null>;
    marginPoints: number;
    maxSellRiskPts?: number;
    realtimeMode?: boolean;
    instrumentName?: string;
  }): Array<{
    candleIndex: number;
    actualCandleIndex: number;
    candleTime: string;
    candleDate: Date;
    unixTimestamp: number;
    reason: string;
    entryPrice: number;
    stopLoss: number;
    risk: number;
    candleRSI: number | null;
    isDayHighZoneRejection: boolean;
    nearDayHighZone: boolean;
    isNearDailyHigh: boolean;
  }> {
    const {
      candles,
      ema8Values,
      ema20Values,
      vwapValues,
      marginPoints,
      maxSellRiskPts = 40,
      realtimeMode = false,
    } = params;

    const results: ReturnType<typeof this.detectDaySellSignalsV4> = [];
    if (candles.length < 3) return results;

    // ── Adaptive config ──────────────────────────────────────────────────────
    const cfg = {
      candleBodyRatio: 0.55, // body / range >= this → "strong bearish"
      superBearishBodyRatio: 0.6, // first candle body / range threshold
      superBearishTailRatio: 0.15, // close within 15 % of range from candle low
      largeFirstCandleATRMultiplier: 1.4,
      retracements: [0.5, 0.618],
      retracementTol: 0.08, // ± 8 % of first-candle range
      ema20TolPct: 0.006, // 0.6 % of price (EMA proximity)
      sidewaysEmaGapPct: 0.004, // < 0.4 % gap between 8 & 20 EMA
      sidewaysLookback: 8,
      sidewaysCrossings: 2, // EMA cross-count threshold
      dupSuppressZonePct: 0.015, // suppress within 1.5 % of prior signal price
      firstHourCandles: 12, // 12 × 5 min = 1 hr
    };

    // ── ATR: average true range over first N candles ─────────────────────────
    const atrCandles = candles.slice(0, Math.min(10, candles.length));
    const atr =
      atrCandles.reduce((s, c) => s + (c.high - c.low), 0) / atrCandles.length;
    const zoneMargin = marginPoints;

    // ── First candle ─────────────────────────────────────────────────────────
    const firstCandle = candles[0];
    const fcRange = firstCandle.high - firstCandle.low;
    const fcBody = Math.abs(firstCandle.close - firstCandle.open);
    const fcBearish = firstCandle.close < firstCandle.open;
    const avgRange = Math.max(atr, fcRange * 0.5);

    // ── Activation: instrument must open BELOW 20 EMA ────────────────────────
    const firstEma20 = ema20Values[0];
    if (firstEma20 == null || firstCandle.open >= firstEma20) return results;

    // ── Classify first candle ────────────────────────────────────────────────
    const isSuperBearishFC = (() => {
      if (!fcBearish || fcRange < 0.5) return false;
      const bodyRatioOk =
        fcRange > 0 && fcBody / fcRange >= cfg.superBearishBodyRatio;
      const tailOk =
        fcRange > 0 &&
        (firstCandle.close - firstCandle.low) / fcRange <=
          cfg.superBearishTailRatio;
      return bodyRatioOk && tailOk;
    })();

    const isLargeFC = fcRange > cfg.largeFirstCandleATRMultiplier * avgRange;

    // ── First-candle retracement zones (50 % / 61.8 %) ──────────────────────
    const fcRetraceZones = cfg.retracements.map((lvl) => {
      const midPrice = firstCandle.high - fcRange * lvl;
      const tol = fcRange * cfg.retracementTol;
      return { level: lvl, low: midPrice - tol, high: midPrice + tol };
    });

    // ── First 1-hour range ────────────────────────────────────────────────────
    const fhSlice = candles.slice(
      0,
      Math.min(cfg.firstHourCandles, candles.length),
    );
    const firstHourHigh = Math.max(...fhSlice.map((c) => c.high));

    // ── V4 session setup diagnostics ─────────────────────────────────────────
    diagLog('v4', '[V4-SETUP]', {
      instrument: params.instrumentName ?? '',
      firstCandleOpen: +firstCandle.open.toFixed(2),
      firstEma20: +firstEma20.toFixed(2),
      isSuperBearishFC,
      isLargeFC,
      fcRange: +fcRange.toFixed(2),
      atr: +atr.toFixed(2),
      firstHourHigh: +firstHourHigh.toFixed(2),
    });

    // ── Per-session zone / dedup memory ──────────────────────────────────────
    const usedZones = { firstCandleTop: false, firstHourHigh: false };
    const usedRetraceLevels = new Set<number>();
    let fcLowOriginal = firstCandle.low;
    let fcLowBrokenOnce = false;
    let reversalLow: number | null = null;
    let lastSignalIndex = -999;
    let lastSignalPrice = 0;

    // ── Candle helpers ────────────────────────────────────────────────────────
    const isStrongBearish = (c: any): boolean => {
      if (c.close >= c.open) return false;
      const range = c.high - c.low;
      if (range < 0.5) return false;
      return (c.open - c.close) / range >= cfg.candleBodyRatio;
    };

    const isBearishRejection = (c: any): boolean => {
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const upperWick = c.high - Math.max(c.open, c.close);
      return upperWick / range >= 0.35 && c.close < c.open;
    };

    const isNearLevel = (price: number, level: number, tol: number) =>
      Math.abs(price - level) <= tol;

    const isDuplicate = (price: number): boolean =>
      lastSignalIndex >= 0 &&
      Math.abs(price - lastSignalPrice) / Math.max(price, 1) <=
        cfg.dupSuppressZonePct;

    // ── Sideways detection ────────────────────────────────────────────────────
    const isSidewaysAt = (i: number): boolean => {
      if (i < cfg.sidewaysLookback) return false;
      const e8Slice = ema8Values.slice(i - cfg.sidewaysLookback, i + 1);
      const e20Slice = ema20Values.slice(i - cfg.sidewaysLookback, i + 1);
      const window = candles.slice(i - cfg.sidewaysLookback, i + 1);
      let narrowCount = 0;
      for (let k = 0; k < e8Slice.length; k++) {
        const e8 = e8Slice[k];
        const e20 = e20Slice[k];
        if (e8 == null || e20 == null) continue;
        const mid = (e8 + e20) / 2;
        if (mid > 0 && Math.abs(e8 - e20) / mid < cfg.sidewaysEmaGapPct)
          narrowCount++;
      }
      const narrowRatio = narrowCount / cfg.sidewaysLookback;
      let crossings = 0;
      for (let k = 1; k < window.length; k++) {
        const pe = e20Slice[k - 1];
        const ce = e20Slice[k];
        if (pe == null || ce == null) continue;
        if (window[k - 1].close > pe !== window[k].close > ce) crossings++;
      }
      return narrowRatio >= 0.6 && crossings >= cfg.sidewaysCrossings;
    };

    // ── Timestamp helpers ─────────────────────────────────────────────────────
    const getCandleTs = (c: any): number =>
      c.date instanceof Date
        ? Math.floor(c.date.getTime() / 1000) + 19800
        : Math.floor(new Date(c.date).getTime() / 1000) + 19800;

    const getCandleTimeStr = (c: any): string => {
      const d = c.date instanceof Date ? c.date : new Date(c.date);
      return d.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    };

    const buildSignal = (
      i: number,
      reason: string,
      entryPrice: number,
      stopLoss: number,
    ) => {
      const c = candles[i];
      return {
        candleIndex: i,
        actualCandleIndex: i,
        candleTime: getCandleTimeStr(c),
        candleDate: c.date instanceof Date ? c.date : new Date(c.date),
        unixTimestamp: getCandleTs(c),
        reason,
        entryPrice,
        stopLoss,
        risk: stopLoss - entryPrice,
        candleRSI: null as number | null,
        isDayHighZoneRejection: false,
        nearDayHighZone: false,
        isNearDailyHigh: false,
      };
    };

    const scanStart = realtimeMode ? Math.max(2, candles.length - 2) : 2;

    // ── Main scan loop ─────────────────────────────────────────────────────────
    for (let i = scanStart; i < candles.length; i++) {
      const candle = candles[i];
      const ema20 = ema20Values[i];
      const ema8 = ema8Values[i];
      if (!ema20 || !ema8) continue;

      // Track false-breakdown of first candle low
      if (
        !fcLowBrokenOnce &&
        candle.low < fcLowOriginal &&
        candle.close > fcLowOriginal
      ) {
        fcLowBrokenOnce = true;
        reversalLow = candle.low;
      }

      const sideways = isSidewaysAt(i);
      let signalReason: string | null = null;
      let entryPrice = 0;
      let stopLoss = 0;

      // ── Scenario 1: FIRST_CANDLE_PULLBACK_SELL ────────────────────────────
      if (
        !signalReason &&
        isSuperBearishFC &&
        !usedZones.firstCandleTop &&
        !sideways
      ) {
        const topZone = firstCandle.open;
        const tol = Math.max(zoneMargin, atr * 0.3);
        if (
          isNearLevel(candle.high, topZone, tol) &&
          (isBearishRejection(candle) || isStrongBearish(candle))
        ) {
          entryPrice = candle.close;
          stopLoss = Math.max(firstCandle.high, candle.high) + zoneMargin * 0.3;
          const risk = stopLoss - entryPrice;
          if (risk > 0 && risk <= maxSellRiskPts) {
            signalReason = 'FIRST_CANDLE_PULLBACK_SELL';
            usedZones.firstCandleTop = true;
          }
        }
      }

      // ── Scenario 2: FIRST_CANDLE_RETRACEMENT_SELL ────────────────────────
      if (!signalReason && isLargeFC && fcBearish) {
        for (const zone of fcRetraceZones) {
          if (usedRetraceLevels.has(zone.level)) continue;
          if (candle.high >= zone.low && candle.high <= zone.high + atr * 0.2) {
            if (isBearishRejection(candle) || isStrongBearish(candle)) {
              entryPrice = candle.close;
              stopLoss = firstCandle.high + zoneMargin * 0.3;
              const risk = stopLoss - entryPrice;
              if (risk > 0 && risk <= maxSellRiskPts) {
                signalReason = `FIRST_CANDLE_RETRACEMENT_SELL (${(zone.level * 100).toFixed(0)}%)`;
                usedRetraceLevels.add(zone.level);
                break;
              }
            }
          }
        }
      }

      // ── Scenario 3: FIRST_CANDLE_LOW_BREAK_SELL ───────────────────────────
      if (!signalReason) {
        const breakLevel =
          fcLowBrokenOnce && reversalLow != null ? reversalLow : fcLowOriginal;
        const prevC = candles[i - 1];
        if (
          candle.close < breakLevel &&
          prevC.close >= breakLevel &&
          isStrongBearish(candle)
        ) {
          entryPrice = candle.close;
          stopLoss = Math.max(candle.high, breakLevel) + zoneMargin * 0.3;
          const risk = stopLoss - entryPrice;
          if (risk > 0 && risk <= maxSellRiskPts) {
            signalReason = 'FIRST_CANDLE_LOW_BREAK_SELL';
          }
        }
      }

      // ── Scenario 4: EMA_REJECTION_SELL ────────────────────────────────────
      // Price below 20 EMA; pulls back to EMA zone from below; rejects.
      if (!signalReason && candle.close < ema20 && !sideways) {
        const emaTol = ema20 * cfg.ema20TolPct + zoneMargin * 0.5;
        const prevEma20 = ema20Values[i - 1];
        if (prevEma20 != null) {
          const prevBelowEma = candles[i - 1].close < prevEma20;
          const priceReachedEma =
            candle.high >= ema20 - emaTol &&
            candle.high <= ema20 + emaTol * 1.5;
          if (
            priceReachedEma &&
            prevBelowEma &&
            (isBearishRejection(candle) || isStrongBearish(candle))
          ) {
            entryPrice = candle.close;
            stopLoss = candle.high + zoneMargin * 0.3;
            const risk = stopLoss - entryPrice;
            if (risk > 0 && risk <= maxSellRiskPts) {
              signalReason = 'EMA_REJECTION_SELL';
            }
          }
        }
      }

      // ── Scenario 5: EMA_FAKE_BREAK_SELL ───────────────────────────────────
      // Previous candle closed above EMA/VWAP; current candle fails back below.
      if (!signalReason) {
        const prevC5 = candles[i - 1];
        const prevEma20_5 = ema20Values[i - 1];
        const prevVwap = vwapValues[i - 1] ?? 0;
        const currVwap = vwapValues[i] ?? 0;
        if (prevEma20_5 != null) {
          const prevFakeEma = prevC5.close > prevEma20_5;
          const currBelowEma = candle.close < ema20;
          const prevFakeVwap = prevVwap > 0 && prevC5.close > prevVwap;
          const currBelowVwap = currVwap > 0 && candle.close < currVwap;
          if (
            (prevFakeEma && currBelowEma) ||
            (prevFakeVwap && currBelowVwap)
          ) {
            if (isStrongBearish(candle) || isBearishRejection(candle)) {
              entryPrice = candle.close;
              stopLoss = Math.max(prevC5.high, candle.high) + zoneMargin * 0.3;
              const risk = stopLoss - entryPrice;
              if (risk > 0 && risk <= maxSellRiskPts) {
                signalReason = 'EMA_FAKE_BREAK_SELL';
              }
            }
          }
        }
      }

      // ── Scenario 6: FIRST_HOUR_HIGH_REJECTION_SELL ────────────────────────
      // Sideways market fallback: price touches first-hour high and rejects.
      if (!signalReason && sideways && !usedZones.firstHourHigh) {
        const fhTol = Math.max(zoneMargin, atr * 0.3);
        if (
          isNearLevel(candle.high, firstHourHigh, fhTol) &&
          (isBearishRejection(candle) || isStrongBearish(candle))
        ) {
          entryPrice = candle.close;
          stopLoss = firstHourHigh + zoneMargin * 0.5;
          const risk = stopLoss - entryPrice;
          if (risk > 0 && risk <= maxSellRiskPts) {
            signalReason = 'FIRST_HOUR_HIGH_REJECTION_SELL';
            usedZones.firstHourHigh = true;
          }
        }
      }

      // ── Emit signal ────────────────────────────────────────────────────────
      if (signalReason && entryPrice > 0 && stopLoss > entryPrice) {
        if (!isDuplicate(entryPrice)) {
          results.push(buildSignal(i, signalReason, entryPrice, stopLoss));
          lastSignalIndex = i;
          lastSignalPrice = entryPrice;
        }
      }

      // ── V4 per-candle eval diagnostic ────────────────────────────────────
      diagLog('v4', '[V4-EVAL]', {
        instrument: params.instrumentName ?? '',
        candleTime: getCandleTimeStr(candle),
        candleClose: +candle.close.toFixed(2),
        ema20: +ema20.toFixed(2),
        ema8: +ema8.toFixed(2),
        vwap: +(vwapValues[i] ?? 0).toFixed(2),
        fcLowBrokenOnce,
        sideways,
        signalReason: signalReason ?? 'SKIP',
      });
    }

    return results;
  }

  /**
   * DAY_SELLING_V2_ENHANCED — v2 upgraded with the strongest v4 quality filters.
   *
   * Preserves v2's three core setups:
   *   A. First Candle Low Break
   *   B. Day High Zone Rejection
   *   C. 20 EMA Rejection (refactored to multi-candle event window)
   *
   * Adds upgraded filters:
   *   - Session activation: open-below-EMA + delayed activation + late bearish activation
   *   - Market state engine: BEARISH_TREND / SIDEWAYS_RANGE / BEARISH_REVERSAL_TRANSITION / BULLISH_OR_NEUTRAL
   *   - Sideways detection using 8 EMA / 20 EMA gap and price-crossing count
   *   - Master EMA-resistance filter (isBearishEmaContext) applied to setups B and C
   *   - Setup D (sideways): D1 FHH rejection, D2 FHH sweep rejection, D3 first-hour-low breakdown (opt-in)
   *   - Setup E: Liquidity sweep / failed breakout rejection (score-based, generic)
   *   - Zone memory with rearm logic replacing simple cooldown
   *
   * Do NOT modify V2 (detectDaySellSignalsV2). This is an independent enhanced variant.
   */
  private detectDaySellSignalsV2Enhanced(params: {
    candles: any[];
    ema20Values: (number | null)[];
    ema8Values: (number | null)[];
    rsiValues: (number | null)[];
    swingHighs: Array<{ price: number; index: number }>;
    yesterdayHigh: number;
    prevDayLow?: number;
    prevDayClose?: number;
    marginPoints: number;
    maxSellRiskPts?: number;
    realtimeMode?: boolean;
    instrumentName?: string;
    superTrendData?: Array<{ superTrend: number; trend: 'up' | 'down' } | null>;
  }): Array<{
    candleIndex: number;
    actualCandleIndex: number;
    candleTime: string;
    candleDate: Date;
    unixTimestamp: number;
    reason: string;
    entryPrice: number;
    stopLoss: number;
    risk: number;
    candleRSI: number | null;
    isDayHighZoneRejection: boolean;
    nearDayHighZone: boolean;
    isNearDailyHigh: boolean;
  }> {
    const {
      candles,
      ema20Values,
      ema8Values,
      rsiValues,
      yesterdayHigh,
      prevDayLow = 0,
      prevDayClose = 0,
      marginPoints,
      maxSellRiskPts = 30,
      realtimeMode = false,
    } = params;

    const results: ReturnType<typeof this.detectDaySellSignalsV2Enhanced> = [];
    if (candles.length < 3) return results;

    // ── Config ────────────────────────────────────────────────────────────────
    const cfg = {
      // Session activation
      requireOpenBelow20Ema: true,
      allowDelayedActivation: true,
      delayedActivationLookback: 6,
      delayedActivationBelowCloseCount: 4,
      delayedActivationEmaSlopeThreshold: 0,
      // Late bearish activation (EMA loss + sustained closes below EMA)
      lateBearishActivationEnabled: true,
      lateBearishActivationLookback: 5,
      lateBearishActivationBelowCloses: 3,
      // EMA resistance context
      emaResistanceLookback: 6,
      minBelowEmaCloses: 3,
      maxAllowedAboveEmaCloses: 3,
      emaSlopePeriod: 3,
      // Sideways detection
      sidewaysEmaGapPct: 0.004,
      sidewaysLookback: 8,
      sidewaysCrossings: 2,
      // First hour range
      firstHourCandles: 12,
      enableFirstHourLowBreakdown: false,
      // Liquidity sweep setup E
      sweepBufferPts: 2,
      sweepMaxAboveRefPts: 15,
      sweepMaxAboveRefAtrMult: 0.8,
      sweepReturnRequired: true,
      // Multi-candle EMA rejection window
      emaRejectionWindow: 3,
      // Confluence scoring for reversal setups
      minReversalScore: 4,
      // Zone memory
      dupSuppressZonePct: 0.0015,
      dupCooldownCandles: 5,
      zoneRearmPct: 0.003,
      zoneRearmCandles: 8,
      // Candle quality
      candleBodyRatio: 0.55,
      sidewaysBreakdownStrictMode: true,
      // Sweep / Transition DHR (Setup B2)
      sweepDhrMinScore: 4,
      // EMA rejection confluence scoring threshold (Setup C)
      minEmaRejectionScore: 2,
      // Allow EMA rejection in sideways when near range edges
      sidewaysAllowsRangeEdgeSells: true,
      sidewaysRangeEdgeTolMult: 2, // marginPoints multiplier for range-edge tolerance
      // Trigger entry quality
      triggerCandleBodyRatio: 0.32, // min body/range ratio for direct close-entry
      triggerCandleCloseLowPct: 0.45, // close must be in lower portion of range
      directEntryMinScore: 6, // min score for direct entry (else arm) — non-trend default
      sweepDirectMinScore: 5, // min score for direct B2/E entry with a moderate sweep trigger
      // DHR / sweep trigger quality thresholds
      dhrUpperWickRatio: 0.28, // min upper-wick/range for a valid DHR rejection wick
      dhrWeakCloseRatio: 0.52, // close in lower X fraction of range = weak (DHR/sweep)
      dhrMinBodyRatioForDirect: 0.22, // min bearish body/range fraction for DHR direct trigger
      // Setup B expanded high reference family
      dhrIncludeFirstHourHigh: true, // add 1st-hour high to Setup B reference set
      dhrIncludeSwingHighs: true, // add recent swing highs to Setup B reference set
      // Dynamic armed expiry windows (by market state — replaces fixed armedSetupMaxCandles)
      trendArmedMaxCandles: 4, // BEARISH_TREND — enter quickly or expire
      transitionArmedMaxCandles: 6, // BEARISH_REVERSAL_TRANSITION — extra time for reversal
      sidewaysArmedMaxCandles: 5, // SIDEWAYS_RANGE — range-edge patience
      neutralArmedMaxCandles: 3, // BULLISH_OR_NEUTRAL — very strict
      // Per-setup-type candle adjustments (added to the market-state base window)
      b2ArmedExtraCandles: 0, // B2: use base window
      cArmedExtraCandles: -1, // C: 1 candle shorter (EMA rejection should trigger fast)
      dArmedExtraCandles: 1, // D: 1 extra candle (range timing is slower)
      eArmedExtraCandles: 0, // E: use base window
      // Structure invalidation (expire early when setup premise breaks)
      armedInvalidateOnCloseAboveHigh: true, // expire if candle closes above signal candle high
      armedInvalidationBuffer: 1, // pts tolerance above signal high
      armedInvalidateEmaReclaim: true, // C only: expire if price clearly reclaims EMA
      // ATR-based stale detection (prune setups that have not progressed toward trigger)
      useAtrBasedStaleDetect: false, // disabled by default
      staleMoveThresholdAtr: 0.12, // fraction of ATR: if price is still this far above trigger after half the window, stale
      // Armed setup triggering
      armedSetupTriggerBuffer: 1, // fixed pts below signal candle low
      armedSetupTriggerBufferAtrMult: 0.1, // ATR fraction for trigger buffer
      // Adaptive SL for reversal entries
      reversalSlFixedBuffer: 2,
      reversalSlAtrMult: 0.3,
      // Armed setup dedup + confirmation
      armedNearbyZonePct: 0.005, // max pct price distance for same-zone armed dedup check
      armedNearbyWindow: 6, // max candle gap to still consider an armed setup "active"
      armedTriggerNeedConfirm: true, // require secondary bearish confirmation on intrabar low break
      // Setup B2 state-aware thresholds
      b2TrendDirectMinScore: 4, // min b2Score for direct B2 in BEARISH_TREND (easier)
      b2TransitionDirectMinScore: 6, // min b2Score for direct B2 in non-trend states (stricter)
      // Setup C state-aware thresholds
      cTrendDirectMinScore: 4, // min cScore for direct C entry in BEARISH_TREND
      cTransitionDirectMinScore: 5, // min cScore for direct C entry in non-trend states
      cArmMinScore: 3, // min cScore to arm a C setup (non-trend states only)
      cRearmCooldownCandles: 8, // candles after a C expiry before same EMA zone may rearm
      cMoveAwayPct: 0.004, // price must have moved this % from C zone ref to override cooldown
      // ── Inherited bearish continuation context ──────────────────────────────
      // Used ONLY for B2 (DHR) and E (Liquidity Sweep) when strict bearishEma is
      // temporarily false but prior structure is clearly bearish.
      // Setup B, C, D — still require strict bearishEma. Not touched.
      inheritedBiasEnabled: true, // master switch
      prevSessionBearishLookback: 15, // early-session candles used to score prior bearishness
      prevSessionMinBelowEmaRatio: 0.55, // fraction of early candles that must sit below EMA
      prevSessionMinScore: 4, // inherited bias threshold (0-7 scale)
      pullbackMaxAboveEmaPct: 0.006, // if close > EMA by > this fraction → likely real reversal
      pullbackMaxAtrMove: 1.5, // if session up-move > N * ATR → likely real reversal
      setupBAllowInheritedContinuation: true, // allow Setup B (DHR) with inherited bearish bias path
      // 2-candle rejection sequence confirmation
      seqConfirmWindowCandles: 3, // candles after setup candle allowed for confirmation
      seqConfirmBelowMidpoint: true, // confirm candle must close below setup candle midpoint
      seqConfirmBelowSetupLow: false, // stricter alternative: confirm candle closes below setup low
      seqSetupMinUwickRatio: 0.18, // min upper-wick/range fraction to qualify as DHR/sweep setup candle
      seqDuplicateZonePts: 5, // zone proximity tolerance for pending-sequence de-duplication (raw points)
    };

    // ── ATR ───────────────────────────────────────────────────────────────────
    const atrSlice = candles.slice(0, Math.min(10, candles.length));
    const atr =
      atrSlice.reduce((s: number, c: any) => s + (c.high - c.low), 0) /
      atrSlice.length;

    // ── First candle data ─────────────────────────────────────────────────────
    const firstCandle = candles[0];
    const firstCandleLow = firstCandle.low;
    const firstCandleHigh = firstCandle.high;
    const firstCandleLowBreakLevel =
      prevDayLow > 0 &&
      firstCandleLow > 0 &&
      Math.abs(firstCandleLow - prevDayLow) <= marginPoints * 2
        ? Math.min(firstCandleLow, prevDayLow) - 1
        : firstCandleLow;

    // ── Session activation ────────────────────────────────────────────────────
    const firstEma20 = ema20Values[0];
    let sessionActive = false;
    if (firstEma20 != null) {
      if (!cfg.requireOpenBelow20Ema || firstCandle.open < firstEma20) {
        sessionActive = true;
      }
    }

    // ── First 1-hour range ────────────────────────────────────────────────────
    const fhSlice = candles.slice(
      0,
      Math.min(cfg.firstHourCandles, candles.length),
    );
    const firstHourHigh =
      fhSlice.length > 0 ? Math.max(...fhSlice.map((c: any) => c.high)) : 0;
    const firstHourLow =
      fhSlice.length > 0 ? Math.min(...fhSlice.map((c: any) => c.low)) : 0;

    // ── Helpers ───────────────────────────────────────────────────────────────
    const getCandleTs = (c: any): number =>
      c.date instanceof Date
        ? Math.floor(c.date.getTime() / 1000) + 19800
        : Math.floor(new Date(c.date).getTime() / 1000) + 19800;

    const getCandleTimeStr = (c: any): string => {
      const d = c.date instanceof Date ? c.date : new Date(c.date);
      return d.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    };

    const isStrongBearish = (c: any): boolean => {
      if (c.close >= c.open) return false;
      const range = c.high - c.low;
      if (range < 0.5) return false;
      return (c.open - c.close) / range >= cfg.candleBodyRatio;
    };

    const isBearishRejection = (c: any): boolean => {
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const uw = c.high - Math.max(c.open, c.close);
      return uw / range >= 0.35 && c.close < c.open;
    };

    // ── Sideways detection ────────────────────────────────────────────────────
    const isSidewaysAt = (i: number): boolean => {
      if (i < cfg.sidewaysLookback) return false;
      const e8Slice = ema8Values.slice(i - cfg.sidewaysLookback, i + 1);
      const e20Slice = ema20Values.slice(i - cfg.sidewaysLookback, i + 1);
      const window = candles.slice(i - cfg.sidewaysLookback, i + 1);
      let narrowCount = 0;
      for (let k = 0; k < e8Slice.length; k++) {
        const e8 = e8Slice[k];
        const e20 = e20Slice[k];
        if (e8 == null || e20 == null) continue;
        const mid = (e8 + e20) / 2;
        if (mid > 0 && Math.abs(e8 - e20) / mid < cfg.sidewaysEmaGapPct)
          narrowCount++;
      }
      const narrowRatio = narrowCount / cfg.sidewaysLookback;
      let crossings = 0;
      for (let k = 1; k < window.length; k++) {
        const pe = e20Slice[k - 1];
        const ce = e20Slice[k];
        if (pe == null || ce == null) continue;
        if (window[k - 1].close > pe !== window[k].close > ce) crossings++;
      }
      return narrowRatio >= 0.6 && crossings >= cfg.sidewaysCrossings;
    };

    // ── Master EMA-resistance filter ──────────────────────────────────────────
    const isBearishEmaContext = (i: number, ema20: number): boolean => {
      const lookback = Math.min(cfg.emaResistanceLookback, i);
      let belowCount = 0;
      let aboveCount = 0;
      for (let k = i - lookback; k < i; k++) {
        const ke = ema20Values[k];
        if (ke == null) continue;
        if (candles[k].close < ke) belowCount++;
        else aboveCount++;
      }
      const prevEma = ema20Values[Math.max(0, i - cfg.emaSlopePeriod)];
      return (
        belowCount >= cfg.minBelowEmaCloses &&
        aboveCount < cfg.maxAllowedAboveEmaCloses &&
        (prevEma == null || ema20 <= prevEma)
      );
    };

    // ── Delayed activation ────────────────────────────────────────────────────
    const checkDelayedActivation = (i: number): boolean => {
      if (!cfg.allowDelayedActivation) return false;
      if (i < cfg.delayedActivationLookback) return false;
      const e20 = ema20Values[i];
      if (e20 == null) return false;
      const prevEma = ema20Values[i - cfg.delayedActivationLookback];
      if (
        prevEma != null &&
        e20 - prevEma > cfg.delayedActivationEmaSlopeThreshold
      )
        return false;
      let belowCount = 0;
      for (let k = i - cfg.delayedActivationLookback; k <= i; k++) {
        const ke = ema20Values[k];
        if (ke != null && candles[k].close < ke) belowCount++;
      }
      return belowCount >= cfg.delayedActivationBelowCloseCount;
    };

    // ── Late bearish activation (EMA loss mid-session) ────────────────────────
    const checkLateBearishActivation = (i: number): boolean => {
      if (!cfg.lateBearishActivationEnabled) return false;
      const e20 = ema20Values[i];
      if (e20 == null) return false;
      const lb = Math.min(cfg.lateBearishActivationLookback, i);
      let belowCount = 0;
      for (let k = i - lb + 1; k <= i; k++) {
        const ke = ema20Values[k];
        if (ke != null && candles[k].close < ke) belowCount++;
      }
      if (belowCount < cfg.lateBearishActivationBelowCloses) return false;
      const prevEma = ema20Values[Math.max(0, i - cfg.emaSlopePeriod)];
      return prevEma == null || e20 <= prevEma * 1.001;
    };

    // ── Zone memory ───────────────────────────────────────────────────────────
    const zoneMemory = new Map<string, { lastUsed: number; level: number }>();
    const makeZoneKey = (type: string, level: number): string => {
      const snap =
        Math.round(level / Math.max(marginPoints, 1)) *
        Math.round(Math.max(marginPoints, 1));
      return `${type}_${snap}`;
    };
    const isZoneRecentlyUsed = (key: string, i: number): boolean => {
      const entry = zoneMemory.get(key);
      return !!entry && i - entry.lastUsed < cfg.zoneRearmCandles;
    };
    const markZoneUsed = (key: string, i: number, level: number): void => {
      zoneMemory.set(key, { lastUsed: i, level });
    };
    const canRearmZone = (key: string, currentPrice: number): boolean => {
      const entry = zoneMemory.get(key);
      if (!entry) return true;
      return (
        Math.abs(currentPrice - entry.level) / Math.max(currentPrice, 1) >
        cfg.zoneRearmPct
      );
    };

    // ── Market state ──────────────────────────────────────────────────────────
    type MarketState =
      | 'BEARISH_TREND'
      | 'SIDEWAYS_RANGE'
      | 'BEARISH_REVERSAL_TRANSITION'
      | 'BULLISH_OR_NEUTRAL';

    const getMarketState = (
      i: number,
      ema20: number,
      sideways: boolean,
      bearishEma: boolean,
    ): MarketState => {
      if (sideways) return 'SIDEWAYS_RANGE';
      if (bearishEma && candles[i].close < ema20) return 'BEARISH_TREND';
      const lb = Math.min(cfg.lateBearishActivationLookback, i);
      let belowCount = 0;
      for (let k = i - lb + 1; k <= i; k++) {
        const ke = ema20Values[k];
        if (ke != null && candles[k].close < ke) belowCount++;
      }
      if (belowCount >= cfg.lateBearishActivationBelowCloses) {
        const prevEma = ema20Values[Math.max(0, i - cfg.emaSlopePeriod)];
        if (prevEma == null || ema20 <= prevEma * 1.001)
          return 'BEARISH_REVERSAL_TRANSITION';
      }
      return 'BULLISH_OR_NEUTRAL';
    };

    // ── Duplicate suppression ─────────────────────────────────────────────────
    let lastSignalIndex = -999;
    let lastSignalPrice = 0;
    const isDuplicate = (price: number, i: number): boolean => {
      if (lastSignalIndex < 0) return false;
      const tooClose =
        Math.abs(price - lastSignalPrice) / Math.max(price, 1) <=
        cfg.dupSuppressZonePct;
      const tooSoon = i - lastSignalIndex < cfg.dupCooldownCandles;
      return tooClose && tooSoon;
    };

    const buildSignal = (
      i: number,
      reason: string,
      entryPrice: number,
      stopLoss: number,
      isDayHighZoneRejection = false,
      nearDayHighZone = false,
      isNearDailyHigh = false,
    ) => {
      const c = candles[i];
      return {
        candleIndex: i,
        actualCandleIndex: i,
        candleTime: getCandleTimeStr(c),
        candleDate: c.date instanceof Date ? c.date : new Date(c.date),
        unixTimestamp: getCandleTs(c),
        reason,
        entryPrice,
        stopLoss,
        risk: stopLoss - entryPrice,
        candleRSI: (rsiValues[i] ?? null) as number | null,
        isDayHighZoneRejection,
        nearDayHighZone,
        isNearDailyHigh,
      };
    };

    // ── Strong bearish trigger candle ─────────────────────────────────────────
    // Returns true only when the candle has enough body / close quality to
    // justify a direct short entry without waiting for a low-break trigger.
    const isStrongBearishTriggerCandle = (c: any): boolean => {
      if (c.close >= c.open) return false;
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const body = c.open - c.close;
      return (
        body / range >= cfg.triggerCandleBodyRatio &&
        (c.close - c.low) / range <= cfg.triggerCandleCloseLowPct
      );
    };

    // ── 2-candle sequence helpers ────────────────────────────────────────────────

    // Candle A (setup): touched zone, any rejection sign, closed below it.
    const isValidDhrSetupCandle = (c: any, zoneLevel: number): boolean => {
      const range = c.high - c.low;
      if (range < 0.5) return false;
      if (c.high < zoneLevel - marginPoints) return false; // didn't reach zone
      if (c.close >= zoneLevel) return false; // closed above zone = no rejection
      const uw = c.high - Math.max(c.open, c.close);
      const hasWick = uw / range >= cfg.seqSetupMinUwickRatio;
      const hasWeakClose = (c.close - c.low) / range < 0.65;
      return hasWick || hasWeakClose;
    };

    // Candle B (confirm): closes below setup candle midpoint (or low if strict mode).
    // Relaxed: any one of — close < midpoint, low < setupLow, strong bearish follow-through.
    const isValidDhrConfirmationCandle = (
      c: any,
      setupMidpoint: number,
      setupLow: number,
    ): boolean => {
      if (cfg.seqConfirmBelowSetupLow)
        return c.close < setupLow || c.low < setupLow;
      if (c.close < setupMidpoint) return true;
      if (c.low < setupLow) return true;
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const body = Math.abs(c.close - c.open);
      return (
        c.close < c.open &&
        body / range >= 0.5 &&
        (c.close - c.low) / range < 0.35
      );
    };

    // Candle A (setup): swept a key level and closed back below it.
    const isValidSweepSetupCandle = (c: any, refLevel: number): boolean => {
      if (c.high <= refLevel + cfg.sweepBufferPts) return false; // not swept
      if (c.close >= refLevel) return false; // held above = no rejection
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const uw = c.high - Math.max(c.open, c.close);
      const hasWick = uw / range >= cfg.seqSetupMinUwickRatio;
      const hasWeakClose = (c.close - c.low) / range < 0.65;
      return hasWick || hasWeakClose;
    };

    // Candle B (confirm): closes below sweep setup candle midpoint (or low if strict mode).
    // Relaxed: any one of — close < midpoint, low < setupLow, strong bearish follow-through.
    const isValidSweepConfirmationCandle = (
      c: any,
      setupMidpoint: number,
      setupLow: number,
    ): boolean => {
      if (cfg.seqConfirmBelowSetupLow)
        return c.close < setupLow || c.low < setupLow;
      if (c.close < setupMidpoint) return true;
      if (c.low < setupLow) return true;
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const body = Math.abs(c.close - c.open);
      return (
        c.close < c.open &&
        body / range >= 0.5 &&
        (c.close - c.low) / range < 0.35
      );
    };

    // ── Relaxed DHR trigger (Setup B) ─────────────────────────────────────────
    // More permissive than isStrongBearishTriggerCandle.
    // Zone proximity is the primary filter; this only validates candle shape.
    const isValidDhrTriggerCandle = (c: any, zoneLevel: number): boolean => {
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const uw = c.high - Math.max(c.open, c.close);
      const body = Math.abs(c.open - c.close);
      const isCandleDoji = body < range * 0.12;
      // Close must sit in the lower portion of the candle
      const hasWeakClose = (c.close - c.low) / range < cfg.dhrWeakCloseRatio;
      // Reject: close back at or above the tested zone = no rejection
      if (c.close >= zoneLevel + marginPoints) return false;
      const hasUppWick = uw / range >= cfg.dhrUpperWickRatio;
      const hasBearishBody =
        c.close < c.open && body / range >= cfg.dhrMinBodyRatioForDirect;
      return hasWeakClose && (isCandleDoji || hasUppWick || hasBearishBody);
    };

    // ── Relaxed sweep/failure trigger (Setup B2, E) ───────────────────────────
    // Accepts any candle showing meaningful wick OR bearish body AND weak close.
    // The swept-level check (candleClose < ref.level) is enforced upstream.
    const isValidSweepTriggerCandle = (c: any): boolean => {
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const uw = c.high - Math.max(c.open, c.close);
      const body = Math.abs(c.open - c.close);
      const hasUppWick = uw / range >= cfg.dhrUpperWickRatio;
      const hasBearishBody =
        c.close < c.open && body / range >= cfg.dhrMinBodyRatioForDirect;
      const hasWeakClose = (c.close - c.low) / range < cfg.dhrWeakCloseRatio;
      return (hasUppWick || hasBearishBody) && hasWeakClose;
    };

    // ── Adaptive reversal stop-loss ───────────────────────────────────────────
    const reversalSL = (refHigh: number): number =>
      refHigh +
      Math.max(cfg.reversalSlFixedBuffer, atr * cfg.reversalSlAtrMult);

    // ── Armed sell setup state ────────────────────────────────────────────────
    type ArmedSellSetup = {
      type: string;
      signalIndex: number;
      signalLow: number;
      signalHigh: number;
      zoneReference: number;
      expiryIndex: number;
      stopLoss: number;
      reason: string;
      isDayHighZoneRejection: boolean;
      nearDayHighZone: boolean;
      isNearDailyHigh: boolean;
      armMarketState: string;
    };
    const armedSellSetups: ArmedSellSetup[] = [];

    // Returns the candle-count expiry window for a given setup type + market state.
    const getArmedExpiryWindow = (setupType: string, state: string): number => {
      const base =
        state === 'BEARISH_TREND'
          ? cfg.trendArmedMaxCandles
          : state === 'BEARISH_REVERSAL_TRANSITION'
            ? cfg.transitionArmedMaxCandles
            : state === 'SIDEWAYS_RANGE'
              ? cfg.sidewaysArmedMaxCandles
              : cfg.neutralArmedMaxCandles;
      const extra =
        setupType === 'B2'
          ? cfg.b2ArmedExtraCandles
          : setupType === 'C'
            ? cfg.cArmedExtraCandles
            : setupType.startsWith('D')
              ? cfg.dArmedExtraCandles
              : setupType === 'E'
                ? cfg.eArmedExtraCandles
                : 0;
      return Math.max(2, base + extra);
    };

    const armSetup = (
      type: string,
      i: number,
      signalHigh: number,
      signalLow: number,
      zoneReference: number,
      sl: number,
      reason: string,
      isDayHighZoneRej = false,
      nearDayHighZn = false,
      isNearDailyH = false,
      armMarketState = 'UNKNOWN',
    ): void => {
      const existingIdx = armedSellSetups.findIndex(
        (a) =>
          a.type === type &&
          Math.abs(a.zoneReference - zoneReference) <=
            Math.max(marginPoints, 1),
      );
      if (existingIdx >= 0) armedSellSetups.splice(existingIdx, 1);
      armedSellSetups.push({
        type,
        signalIndex: i,
        signalLow,
        signalHigh,
        zoneReference,
        expiryIndex: i + getArmedExpiryWindow(type, armMarketState),
        stopLoss: sl,
        reason,
        isDayHighZoneRejection: isDayHighZoneRej,
        nearDayHighZone: nearDayHighZn,
        isNearDailyHigh: isNearDailyH,
        armMarketState,
      });
    };

    // Returns true when there is already a non-expired armed setup of the same
    // type whose zone reference is within armedNearbyZonePct of `zoneReference`.
    const hasActiveArmedSetupOfTypeNearby = (
      type: string,
      zoneReference: number,
      currentIndex: number,
    ): boolean =>
      armedSellSetups.some(
        (a) =>
          a.type === type &&
          a.expiryIndex >= currentIndex &&
          currentIndex - a.signalIndex <= cfg.armedNearbyWindow &&
          Math.abs(a.zoneReference - zoneReference) /
            Math.max(Math.abs(zoneReference), 1) <=
            cfg.armedNearbyZonePct,
      );

    // Tracks EMA zone references of recently-expired armed C setups.
    // Used to prevent immediate re-arming in the same EMA rejection sequence.
    const expiredCSetups: Array<{ level: number; expiredAt: number }> = [];

    // Returns true when a Setup C expired nearby within cRearmCooldownCandles.
    const recentlyExpiredNearbyCSetup = (
      zoneRef: number,
      currentIndex: number,
    ): boolean =>
      expiredCSetups.some(
        (e) =>
          currentIndex - e.expiredAt <= cfg.cRearmCooldownCandles &&
          Math.abs(e.level - zoneRef) / Math.max(Math.abs(zoneRef), 1) <=
            cfg.armedNearbyZonePct,
      );

    // Returns true when currentPrice has moved far enough from the C zone
    // reference to justify overriding the rearm cooldown.
    const hasMovedAwayEnoughFromCZone = (
      zoneRef: number,
      currentPrice: number,
    ): boolean =>
      Math.abs(currentPrice - zoneRef) / Math.max(Math.abs(zoneRef), 1) >
      cfg.cMoveAwayPct;

    // ── Armed setup lifecycle helpers ─────────────────────────────────────────

    // Returns true when the setup's structural premise has been broken and the
    // armed setup should expire immediately regardless of candle-count expiry.
    const isArmedSetupInvalidated = (
      armed: ArmedSellSetup,
      candle: any,
      currentEma20: number,
    ): boolean => {
      // Universal: close clearly above the signal candle high → reversal/rejection premise broken.
      if (cfg.armedInvalidateOnCloseAboveHigh) {
        if (candle.close > armed.signalHigh + cfg.armedInvalidationBuffer)
          return true;
      }
      // C-specific: price clearly reclaims EMA → EMA rejection premise invalidated.
      if (cfg.armedInvalidateEmaReclaim && armed.type === 'C') {
        // Only consider it reclaimed if close is meaningfully above EMA (not just a wick).
        if (candle.close > currentEma20 + cfg.armedInvalidationBuffer)
          return true;
      }
      return false;
    };

    // Returns true when an armed setup has not progressed toward its trigger
    // level after half its expiry window (ATR-based stale detection).
    const hasArmedSetupGoneStale = (
      armed: ArmedSellSetup,
      currentIndex: number,
      currentLow: number,
    ): boolean => {
      if (!cfg.useAtrBasedStaleDetect) return false;
      const expiryWindow = armed.expiryIndex - armed.signalIndex;
      const elapsed = currentIndex - armed.signalIndex;
      // Only run stale check after the first half of the expiry window.
      if (elapsed < Math.ceil(expiryWindow / 2)) return false;
      const trigBuf = Math.max(
        cfg.armedSetupTriggerBuffer,
        atr * cfg.armedSetupTriggerBufferAtrMult,
      );
      const triggerLevel = armed.signalLow - trigBuf;
      // If price is still this far above the trigger level, consider it stale.
      return currentLow - triggerLevel > atr * cfg.staleMoveThresholdAtr;
    };

    // Unified expiry decision: time-based OR structure-invalidated OR stale.
    const shouldExpireArmedSetup = (
      armed: ArmedSellSetup,
      currentIndex: number,
      candle: any,
      currentEma20: number,
    ): boolean => {
      if (currentIndex > armed.expiryIndex) return true;
      if (isArmedSetupInvalidated(armed, candle, currentEma20)) return true;
      if (hasArmedSetupGoneStale(armed, currentIndex, candle.low)) return true;
      return false;
    };

    // ── Inherited bearish bias (previous session / early session structure) ───
    // Scores prior structure to detect bearish continuation context even when
    // the current candle is temporarily above EMA (pullback / fake breakout).
    // Only used by B2 and E. Setup B, C, D remain unaffected.
    const scorePreviousSessionBearishness = (): number => {
      let score = 0;
      // 1. Prior close below first EMA → prior session closed bearish
      if (firstEma20 != null && prevDayClose > 0 && prevDayClose < firstEma20)
        score += 2;
      // 2. Prior close was in the lower half of the prev session range (weak close)
      if (prevDayClose > 0 && yesterdayHigh > 0 && prevDayLow > 0) {
        const priorRange = yesterdayHigh - prevDayLow;
        if (priorRange > 0 && (prevDayClose - prevDayLow) / priorRange < 0.45)
          score += 1;
      }
      // 3. Prior close did not reach the high (no late bullish surge)
      if (
        prevDayClose > 0 &&
        yesterdayHigh > 0 &&
        prevDayClose < yesterdayHigh * 0.997
      )
        score += 1;
      // 4. Early session candles mostly below EMA
      const earlyWindow = Math.min(
        cfg.prevSessionBearishLookback,
        candles.length,
      );
      let earlyBelowCount = 0;
      let earlyTotal = 0;
      for (let k = 0; k < earlyWindow; k++) {
        const ke = ema20Values[k];
        if (ke == null) continue;
        earlyTotal++;
        if (candles[k].close < ke) earlyBelowCount++;
      }
      if (
        earlyTotal > 0 &&
        earlyBelowCount / earlyTotal >= cfg.prevSessionMinBelowEmaRatio
      )
        score += 2;
      // 5. EMA itself was declining in the early session (down-slope)
      if (firstEma20 != null) {
        const laterEmaIdx = Math.min(
          cfg.emaSlopePeriod + 2,
          candles.length - 1,
        );
        const laterEma = ema20Values[laterEmaIdx];
        if (laterEma != null && laterEma < firstEma20) score += 1;
      }
      return score;
    };

    const prevSessionBearishScore = scorePreviousSessionBearishness();
    const inheritedBearishBias =
      cfg.inheritedBiasEnabled &&
      prevSessionBearishScore >= cfg.prevSessionMinScore;

    // Returns true when the current session up-move looks corrective (pullback / fake breakout)
    // rather than an impulsive bullish reversal. Used alongside inheritedBearishBias.
    const isCurrentMoveLikelyPullback = (
      i: number,
      currentEma20: number,
    ): boolean => {
      const close = candles[i].close;
      // If price is well above EMA, the EMA is no longer acting as resistance → real reversal
      if (currentEma20 > 0) {
        const aboveEmaPct = (close - currentEma20) / Math.max(currentEma20, 1);
        if (aboveEmaPct > cfg.pullbackMaxAboveEmaPct) return false;
      }
      // If the session high-to-now has surged far above yesterday's close, treat as real reversal
      if (prevDayClose > 0 && atr > 0) {
        let sessionHighToNow = 0;
        for (let k = 0; k <= i; k++) {
          if (candles[k].high > sessionHighToNow)
            sessionHighToNow = candles[k].high;
        }
        const moveAbovePrevClose = sessionHighToNow - prevDayClose;
        if (moveAbovePrevClose > atr * cfg.pullbackMaxAtrMove) return false;
      }
      return true;
    };

    // ── Pending 2-candle rejection sequence state ──────────────────────────────
    type PendingRejectionSetup = {
      seqType: 'DHR' | 'SWEEP';
      setupIndex: number;
      zoneReference: number;
      zoneType?: string;
      setupHigh: number;
      setupLow: number;
      setupMidpoint: number;
      stopLoss: number;
      reason: string;
      isDayHighZoneRejection: boolean;
      nearDayHighZone: boolean;
      isNearDailyHigh: boolean;
      expiryIndex: number;
      marketStateAtSetup: string;
    };
    const pendingSeqs: PendingRejectionSetup[] = [];

    const hasSimilarPendingSequence = (
      seqType: 'DHR' | 'SWEEP',
      zoneRef: number,
    ): boolean => {
      const tol =
        cfg.seqDuplicateZonePts > 0
          ? cfg.seqDuplicateZonePts
          : marginPoints * 2;
      return pendingSeqs.some(
        (s) =>
          s.seqType === seqType && Math.abs(s.zoneReference - zoneRef) <= tol,
      );
    };

    const addPendingSequence = (seq: PendingRejectionSetup): void => {
      if (hasSimilarPendingSequence(seq.seqType, seq.zoneReference)) {
        diagLog('v2e', '[V2E-SEQ-SKIP-DUPE]', {
          instrument: params.instrumentName ?? '',
          seqType: seq.seqType,
          zoneReference: seq.zoneReference,
          setupIndex: seq.setupIndex,
        });
        return;
      }
      pendingSeqs.push(seq);
      diagLog('v2e', '[V2E-SEQ-QUEUED]', {
        instrument: params.instrumentName ?? '',
        seqType: seq.seqType,
        zoneReference: seq.zoneReference,
        setupIndex: seq.setupIndex,
        reason: seq.reason,
        expiryIndex: seq.expiryIndex,
        queueLength: pendingSeqs.length,
      });
    };

    const scanStartIndex = realtimeMode ? Math.max(3, candles.length - 2) : 3;

    let firstCandleLowBreakFired = false;
    for (let pi = 1; pi < scanStartIndex; pi++) {
      if (candles[pi]?.close < firstCandleLowBreakLevel) {
        firstCandleLowBreakFired = true;
        break;
      }
    }

    let rollingHigh = 0;
    for (let pi = 0; pi < scanStartIndex; pi++) {
      if (candles[pi].high > rollingHigh) rollingHigh = candles[pi].high;
    }

    let firstHourHighZoneUsed = false;

    diagLog('v2e', '[V2E-CALL]', {
      instrument: params.instrumentName ?? '',
      candleCount: candles.length,
      realtimeMode,
      sessionActive,
      firstEma20: firstEma20 ?? null,
      firstCandleOpen: firstCandle.open,
      firstHourHigh,
      firstHourLow,
      inheritedBearishBias,
      prevSessionBearishScore,
    });

    // ── Main scan loop ────────────────────────────────────────────────────────
    for (let i = scanStartIndex; i < candles.length; i++) {
      const candle = candles[i];
      const ema20 = ema20Values[i];
      const ema8 = ema8Values[i];

      // Use previous rolling high for signal evaluation so a candle that
      // makes a new high is tested against the prior known reference, not itself.
      const prevRollingHigh = rollingHigh;
      const intradayDayHigh = prevRollingHigh;
      if (candle.high > rollingHigh) rollingHigh = candle.high;

      if (!ema20) continue;

      const candleDate =
        candle.date instanceof Date ? candle.date : new Date(candle.date);
      const hrs = candleDate.getHours();
      const mins = candleDate.getMinutes();
      const minsOfDay = hrs * 60 + mins;
      if (minsOfDay < 9 * 60 + 30 || minsOfDay > 14 * 60 + 30) continue;

      // ── Session activation ────────────────────────────────────────────────
      const isSessionActive =
        sessionActive ||
        checkDelayedActivation(i) ||
        checkLateBearishActivation(i);
      if (!isSessionActive) continue;

      const candleHigh = candle.high;
      const candleLow = candle.low;
      const candleOpen = candle.open;
      const candleClose = candle.close;
      const candleBody = Math.abs(candleClose - candleOpen);
      const upperWick = candleHigh - Math.max(candleOpen, candleClose);
      const totalRange = candleHigh - candleLow;
      const isRedCandle = candleClose < candleOpen;
      const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;
      const prev1 = i >= 1 ? candles[i - 1] : null;

      const sideways = isSidewaysAt(i);
      const bearishEma = isBearishEmaContext(i, ema20);
      const marketState = getMarketState(i, ema20, sideways, bearishEma);

      diagLog('v2e', '[V2E-CANDLE]', {
        instrument: params.instrumentName ?? '',
        candleTime: getCandleTimeStr(candle),
        candleClose,
        ema20,
        ema8: ema8 ?? null,
        sideways,
        bearishEma,
        marketState,
        sessionActive: isSessionActive,
        firstCandleLowBreakFired,
      });

      // ── Armed setup trigger check ─────────────────────────────────────────
      // Trigger when candle LOW breaks the trigger level (intrabar break).
      // Secondary confirmation prevents entries on pure spike wicks.
      for (let a = armedSellSetups.length - 1; a >= 0; a--) {
        const armed = armedSellSetups[a];
        if (shouldExpireArmedSetup(armed, i, candle, ema20)) {
          if (armed.type === 'C') {
            expiredCSetups.push({ level: armed.zoneReference, expiredAt: i });
          }
          const expireReason =
            i > armed.expiryIndex
              ? 'candle-count'
              : isArmedSetupInvalidated(armed, candle, ema20)
                ? 'structure-invalidated'
                : 'stale-no-progress';
          diagLog('v2e', '[V2E-EXPIRED-ARMED]', {
            instrument: params.instrumentName ?? '',
            armedType: armed.type,
            reason: armed.reason,
            expireReason,
            signalIndex: armed.signalIndex,
            expiryIndex: armed.expiryIndex,
            armMarketState: armed.armMarketState,
          });
          armedSellSetups.splice(a, 1);
          continue;
        }
        const trigBuf = Math.max(
          cfg.armedSetupTriggerBuffer,
          atr * cfg.armedSetupTriggerBufferAtrMult,
        );
        const triggerLevel = armed.signalLow - trigBuf;
        const triggerHit = candle.low <= triggerLevel;
        const signalMidpoint = (armed.signalLow + armed.signalHigh) / 2;
        const triggerConfirmed =
          !cfg.armedTriggerNeedConfirm ||
          isRedCandle ||
          candleClose < armed.signalLow ||
          candleClose < signalMidpoint;
        if (triggerHit && triggerConfirmed) {
          const armSL = Math.max(armed.stopLoss, reversalSL(armed.signalHigh));
          const armRisk = armSL - candleClose;
          if (
            armRisk > 0 &&
            armRisk <= maxSellRiskPts &&
            !isDuplicate(candleClose, i)
          ) {
            const triggerReason = isRedCandle
              ? 'red-candle'
              : candleClose < armed.signalLow
                ? 'close-below-signal-low'
                : 'close-below-midpoint';
            const sig = buildSignal(
              i,
              armed.reason + ' [Triggered]',
              candleClose,
              armSL,
              armed.isDayHighZoneRejection,
              armed.nearDayHighZone,
              armed.isNearDailyHigh,
            );
            results.push(sig);
            diagLog('v2e', '[V2E-SIGNAL-ARMED]', {
              instrument: params.instrumentName ?? '',
              candleTime: sig.candleTime,
              armedType: armed.type,
              reason: armed.reason,
              triggerLevel,
              triggerReason,
              entryPrice: sig.entryPrice,
              stopLoss: sig.stopLoss,
              risk: sig.risk,
            });
            lastSignalIndex = i;
            lastSignalPrice = candleClose;
            armedSellSetups.splice(a, 1);
            break; // one armed trigger per candle
          }
        }
      }

      // ── Pending 2-candle rejection sequence check ─────────────────────────────
      // Process all active pending sequences independently; remove expired/confirmed ones.
      if (pendingSeqs.length > 0) {
        let seqSignalFired = false;
        const stillActive: PendingRejectionSetup[] = [];
        for (const seq of pendingSeqs) {
          const seqExpired = i > seq.expiryIndex;
          const seqInvalidated =
            candleClose > seq.setupHigh + cfg.armedInvalidationBuffer;
          if (seqExpired || seqInvalidated) {
            diagLog('v2e', '[V2E-EXPIRED-SEQ]', {
              instrument: params.instrumentName ?? '',
              seqType: seq.seqType,
              reason: seq.reason,
              setupIndex: seq.setupIndex,
              invalidReason: seqExpired ? 'candle-count' : 'close-above-high',
            });
            continue; // drop this sequence
          }
          const seqConfirmed =
            seq.seqType === 'DHR'
              ? isValidDhrConfirmationCandle(
                  candle,
                  seq.setupMidpoint,
                  seq.setupLow,
                )
              : isValidSweepConfirmationCandle(
                  candle,
                  seq.setupMidpoint,
                  seq.setupLow,
                );
          if (seqConfirmed) {
            const seqRisk = seq.stopLoss - candleClose;
            if (
              seqRisk > 0 &&
              seqRisk <= maxSellRiskPts &&
              !isDuplicate(candleClose, i)
            ) {
              const sig = buildSignal(
                i,
                seq.reason + ' [2-Candle Seq]',
                candleClose,
                seq.stopLoss,
                seq.isDayHighZoneRejection,
                seq.nearDayHighZone,
                seq.isNearDailyHigh,
              );
              results.push(sig);
              diagLog('v2e', '[V2E-SIGNAL-SEQ]', {
                instrument: params.instrumentName ?? '',
                candleTime: sig.candleTime,
                seqType: seq.seqType,
                setupIndex: seq.setupIndex,
                reason: seq.reason,
                entryPrice: sig.entryPrice,
                stopLoss: sig.stopLoss,
                risk: sig.risk,
                marketState,
              });
              lastSignalIndex = i;
              lastSignalPrice = candleClose;
              seqSignalFired = true;
            }
            continue; // consumed (whether risk check passed or not)
          }
          // Still active — keep it
          stillActive.push(seq);
        }
        pendingSeqs.length = 0;
        pendingSeqs.push(...stillActive);
        if (seqSignalFired && lastSignalIndex === i) continue;
      }

      // ════════════════════════════════════════════════════════════════════════
      // SETUP A: First Candle Low Break  (intentionally direct-entry breakout setup)
      // Direct entry fires only when the breakdown candle is a strong bearish trigger.
      // Weak-candle breakdowns are skipped — no arming for Setup A.
      // ════════════════════════════════════════════════════════════════════════
      if (
        !firstCandleLowBreakFired &&
        firstCandleLow > 0 &&
        isRedCandle &&
        candleClose < firstCandleLowBreakLevel
      ) {
        const brkLargeBearishBody = candleBody > totalRange * 0.4;
        const brkBearishEngulfing =
          !!prev1 &&
          prev1.close > prev1.open &&
          candleOpen >= prev1.close &&
          candleClose < prev1.open;
        const brkStrongCloseNearLow =
          totalRange > 0 && (candleClose - candleLow) / totalRange < 0.2;
        const brkValidCandle =
          brkLargeBearishBody || brkBearishEngulfing || brkStrongCloseNearLow;

        if (!brkValidCandle) continue;

        if (ema20 < candleClose) {
          firstCandleLowBreakFired = true;
          continue;
        }

        if (sideways && cfg.sidewaysBreakdownStrictMode && !bearishEma) {
          firstCandleLowBreakFired = true;
          continue;
        }

        firstCandleLowBreakFired = true;

        const breakSL = firstCandleLow + 2;
        const breakRisk = breakSL - candleClose;

        if (breakRisk > 0 && breakRisk <= maxSellRiskPts * 2) {
          const brkEMASupport =
            ema20 < candleClose && candleClose - ema20 < breakRisk;
          const brkPrevDayLowSupport =
            prevDayLow > 0 &&
            prevDayLow < candleClose &&
            candleClose - prevDayLow < breakRisk;
          let brkIntradaySupport = false;
          for (let k = 1; k < i; k++) {
            if (
              candles[k].low < candleClose &&
              candleClose - candles[k].low < breakRisk
            ) {
              brkIntradaySupport = true;
              break;
            }
          }
          if (!brkEMASupport && !brkPrevDayLowSupport && !brkIntradaySupport) {
            if (!isDuplicate(candleClose, i)) {
              const brkPattern = brkBearishEngulfing
                ? 'Bearish Engulfing'
                : brkStrongCloseNearLow
                  ? 'Strong Close Near Low'
                  : 'Large Bearish Body';
              if (isStrongBearishTriggerCandle(candle)) {
                const sig = buildSignal(
                  i,
                  `V2E: 1st Candle Low Break (${brkPattern})`,
                  candleClose,
                  breakSL,
                );
                results.push(sig);
                diagLog('v2e', '[V2E-SIGNAL-A]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: sig.candleTime,
                  setup: 'A-FirstCandleLowBreak',
                  pattern: brkPattern,
                  entryMode: 'direct',
                  entryPrice: sig.entryPrice,
                  stopLoss: sig.stopLoss,
                  risk: sig.risk,
                  ema20,
                  firstCandleLowBreakLevel,
                });
                lastSignalIndex = i;
                lastSignalPrice = candleClose;
              }
              // else: breakdown candle not strong enough — skip Setup A entirely
            }
          }
        }
        continue;
      }

      // ════════════════════════════════════════════════════════════════════════
      // SETUP B2: Sweep / Transition Day High Rejection  ← evaluated FIRST
      // Confluence-scored. Catches failed breakouts at key highs.
      // Works in bearish trend AND reversal transition (no bearishEma gate).
      // Also fires in BULLISH_OR_NEUTRAL when inheritedBearishBias is true and
      // the current up-move looks like a pullback / fake breakout into resistance.
      // ════════════════════════════════════════════════════════════════════════
      const b2InheritedOk =
        inheritedBearishBias && isCurrentMoveLikelyPullback(i, ema20);
      if (
        marketState === 'BEARISH_REVERSAL_TRANSITION' ||
        marketState === 'BEARISH_TREND' ||
        b2InheritedOk
      ) {
        const b2Refs: Array<{
          level: number;
          label: string;
          zoneType: string;
        }> = [];
        if (intradayDayHigh > 0)
          b2Refs.push({
            level: intradayDayHigh,
            label: `intraday high ${intradayDayHigh.toFixed(0)}`,
            zoneType: 'B2_IH',
          });
        if (yesterdayHigh > 0)
          b2Refs.push({
            level: yesterdayHigh,
            label: `prev day high ${yesterdayHigh.toFixed(0)}`,
            zoneType: 'B2_PH',
          });
        if (firstHourHigh > 0 && i >= cfg.firstHourCandles)
          b2Refs.push({
            level: firstHourHigh,
            label: `1st hour high ${firstHourHigh.toFixed(0)}`,
            zoneType: 'B2_FHH',
          });

        let b2Fired = false;
        for (const ref of b2Refs) {
          if (ref.level <= 0) continue;
          const nearOrSwept =
            Math.abs(candleHigh - ref.level) <= marginPoints * 2 ||
            candleHigh > ref.level + cfg.sweepBufferPts;
          if (!nearOrSwept) continue;
          if (candleClose >= ref.level) continue;

          let b2Score = 2;
          if (candleHigh > ref.level + cfg.sweepBufferPts) b2Score += 1;
          if (isRedCandle) b2Score += 1;
          if (ema20 > candleClose) b2Score += 2;
          if (upperWick > totalRange * 0.4) b2Score += 1;
          if (candleBody > totalRange * 0.3 && isRedCandle) b2Score += 1;
          if (i + 1 < candles.length) {
            const nc = candles[i + 1];
            if (nc && nc.close < nc.open && nc.close < candleClose)
              b2Score += 2;
          }

          const zk = makeZoneKey(ref.zoneType, ref.level);
          if (isZoneRecentlyUsed(zk, i) && !canRearmZone(zk, candleClose))
            continue;

          if (b2Score >= cfg.sweepDhrMinScore && !isDuplicate(candleClose, i)) {
            const b2SL = reversalSL(candleHigh);
            markZoneUsed(zk, i, ref.level);
            // State-aware direct-entry threshold:
            //   BEARISH_TREND       → easier bar: red candle + sweepDhrMinScore is enough
            //   non-trend           → stricter bar: requires strong trigger candle quality
            const b2DirectThreshold =
              marketState === 'BEARISH_TREND'
                ? cfg.b2TrendDirectMinScore
                : cfg.b2TransitionDirectMinScore;
            const b2DirectOk =
              marketState === 'BEARISH_TREND'
                ? isRedCandle && b2Score >= b2DirectThreshold
                : isValidSweepTriggerCandle(candle) &&
                  b2Score >= b2DirectThreshold;
            if (b2DirectOk) {
              // Direct close-entry
              const b2Risk = b2SL - candleClose;
              if (b2Risk > 0 && b2Risk <= maxSellRiskPts) {
                const sig = buildSignal(
                  i,
                  `V2E: Sweep Day High Rejection (${ref.label})`,
                  candleClose,
                  b2SL,
                  true,
                  ref.zoneType === 'B2_IH',
                  intradayDayHigh - candleHigh <= marginPoints * 3,
                );
                results.push(sig);
                diagLog('v2e', '[V2E-SIGNAL-B2]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: sig.candleTime,
                  setup: 'B2-SweepDHR',
                  zone: ref.label,
                  b2Score,
                  entryMode: 'direct',
                  marketState,
                  entryPrice: sig.entryPrice,
                  stopLoss: sig.stopLoss,
                  risk: sig.risk,
                  ema20,
                });
                lastSignalIndex = i;
                lastSignalPrice = candleClose;
              }
            } else {
              // Arm setup: wait for low-break trigger on a future candle
              armSetup(
                'B2',
                i,
                candleHigh,
                candleLow,
                ref.level,
                b2SL,
                `V2E: Sweep Day High Rejection (${ref.label})`,
                true,
                ref.zoneType === 'B2_IH',
                intradayDayHigh - candleHigh <= marginPoints * 3,
                marketState,
              );
              diagLog('v2e', '[V2E-ARMED-B2]', {
                instrument: params.instrumentName ?? '',
                candleTime: getCandleTimeStr(candle),
                zone: ref.label,
                b2Score,
                marketState,
                signalLow: candleLow,
                expiryIndex: i + getArmedExpiryWindow('B2', marketState),
              });
              // Also store as 2-candle sequence candidate alongside the arm.
              if (isValidSweepSetupCandle(candle, ref.level)) {
                const seqSL = reversalSL(candleHigh);
                if (seqSL - candleClose <= maxSellRiskPts) {
                  addPendingSequence({
                    seqType: 'SWEEP',
                    setupIndex: i,
                    zoneReference: ref.level,
                    zoneType: ref.zoneType ?? 'B2_SWEEP',
                    setupHigh: candleHigh,
                    setupLow: candleLow,
                    setupMidpoint: (candleHigh + candleLow) / 2,
                    stopLoss: seqSL,
                    reason: `V2E: Sweep Day High Rejection (${ref.label})`,
                    isDayHighZoneRejection: true,
                    nearDayHighZone: ref.zoneType === 'B2_IH',
                    isNearDailyHigh:
                      intradayDayHigh - candleHigh <= marginPoints * 3,
                    expiryIndex: i + cfg.seqConfirmWindowCandles,
                    marketStateAtSetup: marketState,
                  });
                }
              }
            }
            b2Fired = true;
            break;
          }
        }
        if (b2Fired) continue;
      }

      // ════════════════════════════════════════════════════════════════════════
      // SETUP B: Trend Day High Zone Rejection
      // Path 1 (strict):    bearishEma + non-bullish market state.
      // Path 2 (inherited): inheritedBearishBias + pullback-only current move.
      //   → allows normal DHR when prior session was bearish but current EMA
      //     context is temporarily interrupted by a pullback / fake breakout.
      // ════════════════════════════════════════════════════════════════════════
      const bStrictPath = bearishEma && marketState !== 'BULLISH_OR_NEUTRAL';
      const bInheritedPath =
        cfg.setupBAllowInheritedContinuation &&
        inheritedBearishBias &&
        isCurrentMoveLikelyPullback(i, ema20);
      if (bStrictPath || bInheritedPath) {
        // ── Expanded high reference family for Setup B ──────────────────────────
        const nearIntradayHigh =
          intradayDayHigh > 0 &&
          Math.abs(candleHigh - intradayDayHigh) <= marginPoints * 1.5;
        const nearPrevDayHigh =
          yesterdayHigh > 0 &&
          Math.abs(candleHigh - yesterdayHigh) <= marginPoints;
        const nearPrevDayClose =
          prevDayClose > 0 &&
          Math.abs(candleHigh - prevDayClose) <= marginPoints;
        const nearFirstCandleHighZone =
          firstCandleHigh > 0 &&
          i > 3 &&
          Math.abs(candleHigh - firstCandleHigh) <= marginPoints;
        const nearFirstHourHigh =
          cfg.dhrIncludeFirstHourHigh &&
          firstHourHigh > 0 &&
          i >= cfg.firstHourCandles &&
          Math.abs(candleHigh - firstHourHigh) <= marginPoints * 1.5;
        let nearRecentSwingHigh = false;
        let nearSwingHighLevel = 0;
        if (cfg.dhrIncludeSwingHighs) {
          for (const sh of (params.swingHighs ?? []).slice(-3)) {
            if (
              sh.price > 0 &&
              sh.index < i &&
              sh.index >= i - cfg.sidewaysLookback * 3 &&
              Math.abs(candleHigh - sh.price) <= marginPoints * 1.5
            ) {
              nearRecentSwingHigh = true;
              nearSwingHighLevel = sh.price;
              break;
            }
          }
        }

        const nearAnyResistance =
          nearIntradayHigh ||
          nearPrevDayHigh ||
          nearPrevDayClose ||
          nearFirstCandleHighZone ||
          nearFirstHourHigh ||
          nearRecentSwingHigh;

        // Active zone level (used for closed-below-zone check in trigger helper)
        const dhrActiveLevel = nearIntradayHigh
          ? intradayDayHigh
          : nearPrevDayHigh
            ? yesterdayHigh
            : nearPrevDayClose
              ? prevDayClose
              : nearFirstHourHigh
                ? firstHourHigh
                : nearRecentSwingHigh
                  ? nearSwingHighLevel
                  : firstCandleHigh;

        if (
          nearAnyResistance &&
          isValidDhrTriggerCandle(candle, dhrActiveLevel)
        ) {
          const dhrSL = candleHigh + 2;
          const dhrRisk = dhrSL - candleClose;

          if (dhrRisk > 0 && dhrRisk <= maxSellRiskPts) {
            const emaDistance = ema20 - candleClose;
            // Strict path: EMA must sit at or above close (traditional DHR gate).
            // Inherited path: proximity already enforced by isCurrentMoveLikelyPullback.
            const entryOk = bStrictPath ? emaDistance >= 0 : true;

            if (entryOk && !isDuplicate(candleClose, i)) {
              const dhrZone = nearIntradayHigh
                ? `intraday high ${intradayDayHigh.toFixed(0)}`
                : nearPrevDayHigh
                  ? `prev day high ${yesterdayHigh.toFixed(0)}`
                  : nearPrevDayClose
                    ? `prev day close ${prevDayClose.toFixed(0)}`
                    : nearFirstHourHigh
                      ? `1st hour high ${firstHourHigh.toFixed(0)}`
                      : nearRecentSwingHigh
                        ? `swing high ${nearSwingHighLevel.toFixed(0)}`
                        : `1st candle high ${firstCandleHigh.toFixed(0)}`;
              const bUW =
                upperWick > candleBody * 1.2 || upperWick > totalRange * 0.4;
              const bEngulf =
                !!prev1 &&
                prev1.close > prev1.open &&
                candleOpen >= prev1.close &&
                candleClose < prev1.open &&
                isRedCandle;
              const bStrongBody = isRedCandle && candleBody > totalRange * 0.5;
              const dhrPattern = bEngulf
                ? 'Bearish Engulfing'
                : bStrongBody
                  ? 'Strong Bearish Close'
                  : bUW
                    ? 'Long Upper Wick'
                    : isDoji
                      ? 'Doji'
                      : 'Weak Close';
              const sig = buildSignal(
                i,
                `V2E: Day High Rejection (${dhrPattern} @ ${dhrZone})`,
                candleClose,
                dhrSL,
                true,
                nearIntradayHigh,
                rollingHigh - candleHigh <= marginPoints * 3,
              );
              results.push(sig);
              diagLog('v2e', '[V2E-SIGNAL-B]', {
                instrument: params.instrumentName ?? '',
                candleTime: sig.candleTime,
                setup: 'B-DayHighRejection',
                entryPath: bStrictPath ? 'strict' : 'inherited',
                inheritedBias: bInheritedPath,
                pattern: dhrPattern,
                zone: dhrZone,
                entryPrice: sig.entryPrice,
                stopLoss: sig.stopLoss,
                risk: sig.risk,
                ema20,
                emaDistance,
              });
              lastSignalIndex = i;
              lastSignalPrice = candleClose;
              continue;
            }
          }
        }
        // ─ 2-candle sequence: store setup candle if it qualifies (direct didn't fire above) ─
        if (
          nearAnyResistance &&
          isValidDhrSetupCandle(candle, dhrActiveLevel) &&
          !isDuplicate(candleClose, i)
        ) {
          const seqSL = candleHigh + 2;
          if (seqSL - candleClose <= maxSellRiskPts) {
            addPendingSequence({
              seqType: 'DHR',
              setupIndex: i,
              zoneReference: dhrActiveLevel,
              zoneType: 'B_DHR',
              setupHigh: candleHigh,
              setupLow: candleLow,
              setupMidpoint: (candleHigh + candleLow) / 2,
              stopLoss: seqSL,
              reason: `V2E: Day High Rejection @ ${dhrActiveLevel.toFixed(0)}`,
              isDayHighZoneRejection: true,
              nearDayHighZone: nearIntradayHigh,
              isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
              expiryIndex: i + cfg.seqConfirmWindowCandles,
              marketStateAtSetup: marketState,
            });
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // SETUP C: Multi-candle EMA Rejection
      // Direct entry if current candle is a strong bearish trigger + confirmed bearish close.
      // Otherwise arms with active-nearby and recently-expired anti-rearm guards.
      // ════════════════════════════════════════════════════════════════════════
      const cRangeEdgeNear =
        (firstHourHigh > 0 &&
          Math.abs(candleHigh - firstHourHigh) <=
            marginPoints * cfg.sidewaysRangeEdgeTolMult) ||
        (intradayDayHigh > 0 &&
          Math.abs(candleHigh - intradayDayHigh) <=
            marginPoints * cfg.sidewaysRangeEdgeTolMult);
      const cSidewaysRangeEdge =
        sideways &&
        cfg.sidewaysAllowsRangeEdgeSells &&
        ema20 > candleClose &&
        cRangeEdgeNear;
      if (
        ((!sideways && bearishEma) || cSidewaysRangeEdge) &&
        marketState !== 'BULLISH_OR_NEUTRAL'
      ) {
        const emaWindow = Math.min(cfg.emaRejectionWindow, i);
        let emaEventIdx = -1;
        let emaEventPattern = '';

        for (let w = Math.max(1, i - emaWindow); w <= i; w++) {
          const wc = candles[w];
          const we = ema20Values[w];
          if (!we) continue;
          const wRange = wc.high - wc.low;
          const wUpperWick = wc.high - Math.max(wc.open, wc.close);

          // Pattern 1: direct touch and rejection on the same candle
          const directReject =
            wc.close < wc.open &&
            Math.abs(wc.high - we) <= marginPoints &&
            wc.close < we;

          // Pattern 2: wick pierces EMA, close back below
          const wickAbove =
            wc.high > we + marginPoints * 0.25 &&
            wc.close < we &&
            wRange > 0 &&
            wUpperWick / wRange >= 0.35;

          // Pattern 3: fake reclaim — closed above EMA, next candle closes back below
          const nextWe = w < i ? (ema20Values[w + 1] ?? 0) : 0;
          const fakeReclaim =
            w < i &&
            wc.close > we &&
            wc.close > wc.open &&
            nextWe > 0 &&
            candles[w + 1].close < nextWe;

          // Pattern 4: lower high forming under EMA (current candle, no new high vs prev)
          const lowerHighUnderEma =
            w === i &&
            !!prev1 &&
            prev1.high >= we - marginPoints &&
            candleHigh < prev1.high &&
            isRedCandle &&
            candleHigh < we;

          if (directReject) {
            emaEventIdx = w;
            emaEventPattern = 'Direct Reject';
            break;
          }
          if (wickAbove) {
            emaEventIdx = w;
            emaEventPattern = 'Wick Above EMA';
            break;
          }
          if (fakeReclaim) {
            emaEventIdx = w;
            emaEventPattern = 'Fake Reclaim Fail';
            break;
          }
          if (lowerHighUnderEma) {
            emaEventIdx = w;
            emaEventPattern = 'Lower High Under EMA';
            break;
          }
        }

        if (emaEventIdx >= 0 && i - emaEventIdx <= cfg.emaRejectionWindow) {
          const confirmedNow = candleClose < ema20 && isRedCandle;

          // Allow the event candle itself to qualify when it is strong enough,
          // even if the current (confirmation) candle is not perfectly bearish.
          const ec = candles[emaEventIdx];
          const ecRange = ec.high - ec.low;
          const ecUpperWick = ec.high - Math.max(ec.open, ec.close);
          const ecStrongWick = ecRange > 0 && ecUpperWick / ecRange >= 0.4;
          const ecStrongBody =
            ecRange > 0 &&
            ec.close < ec.open &&
            Math.abs(ec.open - ec.close) / ecRange >= 0.5;
          const eventCandleStrong = ecStrongWick || ecStrongBody;

          const canProceed = confirmedNow || eventCandleStrong;
          if (canProceed) {
            const prevEma3 = ema20Values[Math.max(0, i - 3)];
            const emaSlopingDown =
              prevEma3 != null && (ema20 as number) < prevEma3;

            let emaBounces = 0;
            const supportLookback = Math.min(10, i - 1);
            for (let k = Math.max(0, i - supportLookback); k < i; k++) {
              const ke = ema20Values[k];
              if (ke == null) continue;
              const touched =
                Math.abs(candles[k].low - ke) <= marginPoints ||
                Math.abs(candles[k].close - ke) <= marginPoints;
              if (touched) {
                const nk = k + 1 < candles.length ? candles[k + 1] : null;
                if (nk && nk.close > nk.open) emaBounces++;
              }
            }
            const emaNotSupport = emaBounces < 2;

            let cScore = 0;
            if (emaEventPattern === 'Direct Reject') cScore += 2;
            else if (emaEventPattern === 'Fake Reclaim Fail') cScore += 2;
            else if (emaEventPattern === 'Wick Above EMA') cScore += 2;
            else if (emaEventPattern === 'Lower High Under EMA') cScore += 1;
            if (emaSlopingDown) cScore += 1;
            if (emaNotSupport) cScore += 1;
            if (ema8 != null && ema8 < ema20) cScore += 1;
            if (eventCandleStrong) cScore += 1; // event candle itself is high quality
            if (confirmedNow) cScore += 1; // current candle also confirms
            if (cScore >= cfg.minEmaRejectionScore) {
              const eventHigh = candles[emaEventIdx].high;
              const emaSL = reversalSL(Math.max(candleHigh, eventHigh));
              const emaRisk = emaSL - candleClose;
              if (
                !isDuplicate(candleClose, i) &&
                emaRisk > 0 &&
                emaRisk <= maxSellRiskPts
              ) {
                // State-aware direct-entry for C:
                //   BEARISH_TREND  → direct if candle is bearish + score ≥ trendDirectCMinScore
                //   non-trend      → direct only if strong trigger quality + confirmedNow
                const cDirectOk =
                  marketState === 'BEARISH_TREND'
                    ? confirmedNow && cScore >= cfg.cTrendDirectMinScore
                    : isStrongBearishTriggerCandle(candle) &&
                      confirmedNow &&
                      cScore >= cfg.cTransitionDirectMinScore;
                if (cDirectOk) {
                  // Direct close-entry
                  const sig = buildSignal(
                    i,
                    `V2E: EMA Rejection (${emaEventPattern})`,
                    candleClose,
                    emaSL,
                    false,
                    false,
                    rollingHigh - candleHigh <= marginPoints * 3,
                  );
                  results.push(sig);
                  diagLog('v2e', '[V2E-SIGNAL-C]', {
                    instrument: params.instrumentName ?? '',
                    candleTime: sig.candleTime,
                    setup: 'C-EMAReject',
                    pattern: emaEventPattern,
                    emaEventIdx,
                    cScore,
                    marketState,
                    entryMode: 'direct',
                    entryPrice: sig.entryPrice,
                    stopLoss: sig.stopLoss,
                    risk: sig.risk,
                    ema20,
                  });
                  lastSignalIndex = i;
                  lastSignalPrice = candleClose;
                } else {
                  // Arm with anti-rearm guards (also used in trend for borderline scores)
                  if (hasActiveArmedSetupOfTypeNearby('C', ema20, i)) {
                    diagLog('v2e', '[V2E-SKIP-ARMED-C]', {
                      instrument: params.instrumentName ?? '',
                      candleTime: getCandleTimeStr(candle),
                      reason: 'nearby C already armed',
                      pattern: emaEventPattern,
                      ema20,
                    });
                  } else if (
                    recentlyExpiredNearbyCSetup(ema20, i) &&
                    !hasMovedAwayEnoughFromCZone(ema20, candleClose)
                  ) {
                    diagLog('v2e', '[V2E-SKIP-ARMED-C]', {
                      instrument: params.instrumentName ?? '',
                      candleTime: getCandleTimeStr(candle),
                      reason:
                        'recently expired C nearby, price not moved enough',
                      pattern: emaEventPattern,
                      ema20,
                    });
                  } else {
                    armSetup(
                      'C',
                      i,
                      Math.max(candleHigh, eventHigh),
                      candleLow,
                      ema20,
                      emaSL,
                      `V2E: EMA Rejection (${emaEventPattern})`,
                      false,
                      false,
                      rollingHigh - candleHigh <= marginPoints * 3,
                      marketState,
                    );
                    diagLog('v2e', '[V2E-ARMED-C]', {
                      instrument: params.instrumentName ?? '',
                      candleTime: getCandleTimeStr(candle),
                      pattern: emaEventPattern,
                      cScore,
                      marketState,
                      signalLow: candleLow,
                      expiryIndex: i + getArmedExpiryWindow('C', marketState),
                    });
                  }
                }
              }
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // SETUP D: Sideways Range Logic (D1 / D2 / D3)
      // D1 – Normal first-hour-high rejection
      // D2 – First-hour-high sweep rejection (failed breakout)
      // D3 – First-hour-low continuation breakdown (opt-in, after D1/D2 confirmed)
      // ════════════════════════════════════════════════════════════════════════
      if (sideways) {
        const fhTol = Math.max(marginPoints, atr * 0.3);

        // D1: Normal first-hour-high rejection (touch + rejection candle).
        // EMA overhead is a bonus, not a hard requirement — range edge matters more.
        if (!firstHourHighZoneUsed && firstHourHigh > 0) {
          const nearFHH = Math.abs(candleHigh - firstHourHigh) <= fhTol;
          if (
            nearFHH &&
            (isBearishRejection(candle) || isStrongBearish(candle))
          ) {
            const fhhSL =
              ema20 > candleClose
                ? Math.max(firstHourHigh, ema20) + marginPoints * 0.5
                : firstHourHigh + marginPoints * 0.5;
            const fhhRisk = fhhSL - candleClose;
            const zk = makeZoneKey('FHH', firstHourHigh);
            if (
              fhhRisk > 0 &&
              fhhRisk <= maxSellRiskPts &&
              !isDuplicate(candleClose, i) &&
              (!isZoneRecentlyUsed(zk, i) || canRearmZone(zk, candleClose))
            ) {
              markZoneUsed(zk, i, firstHourHigh);
              firstHourHighZoneUsed = true;
              if (isStrongBearishTriggerCandle(candle)) {
                const sig = buildSignal(
                  i,
                  `V2E: 1st Hour High Rejection (sideways)`,
                  candleClose,
                  fhhSL,
                );
                results.push(sig);
                diagLog('v2e', '[V2E-SIGNAL-D1]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: sig.candleTime,
                  setup: 'D1-FHHReject',
                  entryMode: 'direct',
                  entryPrice: sig.entryPrice,
                  stopLoss: sig.stopLoss,
                  risk: sig.risk,
                  firstHourHigh,
                  ema20,
                });
                lastSignalIndex = i;
                lastSignalPrice = candleClose;
              } else {
                armSetup(
                  'D1',
                  i,
                  Math.max(candleHigh, firstHourHigh),
                  candleLow,
                  firstHourHigh,
                  reversalSL(Math.max(candleHigh, firstHourHigh)),
                  `V2E: 1st Hour High Rejection (sideways)`,
                  false,
                  false,
                  false,
                  marketState,
                );
                diagLog('v2e', '[V2E-ARMED-D1]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: getCandleTimeStr(candle),
                  signalLow: candleLow,
                  firstHourHigh,
                  marketState,
                  expiryIndex: i + getArmedExpiryWindow('D1', marketState),
                });
              }
            }
          }
        }

        // D2: First-hour-high sweep rejection (candle breaks above FHH then closes back below)
        if (!firstHourHighZoneUsed && firstHourHigh > 0) {
          const swept = candleHigh > firstHourHigh + cfg.sweepBufferPts;
          const closedBelow = candleClose < firstHourHigh;
          const sweepExcess = candleHigh - firstHourHigh;
          const maxSweep = Math.max(
            cfg.sweepMaxAboveRefPts,
            atr * cfg.sweepMaxAboveRefAtrMult,
          );
          if (swept && closedBelow && sweepExcess <= maxSweep) {
            let score = 3;
            if (isRedCandle) score += 1;
            if (ema20 > candleClose) score += 2;
            if (upperWick > totalRange * 0.4) score += 1;
            if (candleBody > totalRange * 0.3 && isRedCandle) score += 1;
            const zk = makeZoneKey('FHH_SWEEP', firstHourHigh);
            if (
              score >= cfg.minReversalScore &&
              !isDuplicate(candleClose, i) &&
              (!isZoneRecentlyUsed(zk, i) || canRearmZone(zk, candleClose))
            ) {
              const sl = reversalSL(candleHigh);
              const risk = sl - candleClose;
              if (risk > 0 && risk <= maxSellRiskPts) {
                markZoneUsed(zk, i, firstHourHigh);
                firstHourHighZoneUsed = true;
                if (
                  isStrongBearishTriggerCandle(candle) &&
                  score >= cfg.directEntryMinScore
                ) {
                  const sig = buildSignal(
                    i,
                    `V2E: 1st Hour High Sweep Rejection (sideways)`,
                    candleClose,
                    sl,
                    true,
                    true,
                    false,
                  );
                  results.push(sig);
                  diagLog('v2e', '[V2E-SIGNAL-D2]', {
                    instrument: params.instrumentName ?? '',
                    candleTime: sig.candleTime,
                    setup: 'D2-FHHSweep',
                    score,
                    sweepExcess,
                    entryMode: 'direct',
                    entryPrice: sig.entryPrice,
                    stopLoss: sig.stopLoss,
                    risk: sig.risk,
                    firstHourHigh,
                    ema20,
                  });
                  lastSignalIndex = i;
                  lastSignalPrice = candleClose;
                } else {
                  armSetup(
                    'D2',
                    i,
                    candleHigh,
                    candleLow,
                    firstHourHigh,
                    sl,
                    `V2E: 1st Hour High Sweep Rejection (sideways)`,
                    true,
                    true,
                    false,
                    marketState,
                  );
                  diagLog('v2e', '[V2E-ARMED-D2]', {
                    instrument: params.instrumentName ?? '',
                    candleTime: getCandleTimeStr(candle),
                    score,
                    sweepExcess,
                    signalLow: candleLow,
                    firstHourHigh,
                    marketState,
                    expiryIndex: i + getArmedExpiryWindow('D2', marketState),
                  });
                }
              }
            }
          }
        }

        // D3: First-hour-low continuation breakdown (opt-in, after range top was tested)
        if (
          cfg.enableFirstHourLowBreakdown &&
          firstHourHighZoneUsed &&
          firstHourLow > 0 &&
          candleClose < firstHourLow &&
          isRedCandle
        ) {
          const zk = makeZoneKey('FHL', firstHourLow);
          if (!isZoneRecentlyUsed(zk, i) && !isDuplicate(candleClose, i)) {
            const sl = firstHourLow + marginPoints;
            const risk = sl - candleClose;
            if (risk > 0 && risk <= maxSellRiskPts) {
              const sig = buildSignal(
                i,
                `V2E: 1st Hour Low Breakdown (sideways continuation)`,
                candleClose,
                sl,
              );
              results.push(sig);
              diagLog('v2e', '[V2E-SIGNAL-D3]', {
                instrument: params.instrumentName ?? '',
                candleTime: sig.candleTime,
                setup: 'D3-FHLBreakdown',
                entryPrice: sig.entryPrice,
                stopLoss: sig.stopLoss,
                risk: sig.risk,
                firstHourLow,
              });
              markZoneUsed(zk, i, firstHourLow);
              lastSignalIndex = i;
              lastSignalPrice = candleClose;
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // SETUP E: Liquidity Sweep / Failed Breakout Rejection
      // Score-based. Catches trapped buyers above key highs.
      // Works across all non-bullish market states.
      // Also fires in BULLISH_OR_NEUTRAL when inheritedBearishBias + pullback confirmed.
      // ════════════════════════════════════════════════════════════════════════
      const eInheritedOk =
        inheritedBearishBias && isCurrentMoveLikelyPullback(i, ema20);
      if (marketState !== 'BULLISH_OR_NEUTRAL' || eInheritedOk) {
        const maxSweep = Math.max(
          cfg.sweepMaxAboveRefPts,
          atr * cfg.sweepMaxAboveRefAtrMult,
        );

        const keyHighRefs: Array<{
          level: number;
          label: string;
          zoneType: string;
        }> = [];
        if (intradayDayHigh > 0)
          keyHighRefs.push({
            level: intradayDayHigh,
            label: `intraday high ${intradayDayHigh.toFixed(0)}`,
            zoneType: 'IH',
          });
        if (yesterdayHigh > 0)
          keyHighRefs.push({
            level: yesterdayHigh,
            label: `prev day high ${yesterdayHigh.toFixed(0)}`,
            zoneType: 'PH',
          });
        if (firstCandleHigh > 0 && i > 3)
          keyHighRefs.push({
            level: firstCandleHigh,
            label: `1st candle high ${firstCandleHigh.toFixed(0)}`,
            zoneType: 'FC',
          });
        if (firstHourHigh > 0 && i >= cfg.firstHourCandles)
          keyHighRefs.push({
            level: firstHourHigh,
            label: `1st hour high ${firstHourHigh.toFixed(0)}`,
            zoneType: 'FHH_E',
          });
        for (const sh of (params.swingHighs ?? []).slice(-3)) {
          if (
            sh.price > 0 &&
            sh.index < i &&
            sh.index >= i - cfg.sidewaysLookback * 2
          ) {
            keyHighRefs.push({
              level: sh.price,
              label: `swing high ${sh.price.toFixed(0)}`,
              zoneType: 'SH',
            });
          }
        }

        for (const ref of keyHighRefs) {
          if (ref.level <= 0) continue;
          const swept = candleHigh > ref.level + cfg.sweepBufferPts;
          if (!swept) continue;
          const sweepExcess = candleHigh - ref.level;
          if (sweepExcess > maxSweep) continue;
          if (cfg.sweepReturnRequired && candleClose >= ref.level) continue;

          let score = 3; // base: swept a key high
          if (candleClose < ref.level) score += 2;
          if (isRedCandle) score += 1;
          if (ema20 > candleClose) score += 2;
          if (upperWick > totalRange * 0.4) score += 1;
          if (candleBody > totalRange * 0.3 && isRedCandle) score += 1;
          // Check next candle follow-through
          if (i + 1 < candles.length) {
            const nc = candles[i + 1];
            if (nc && nc.close < nc.open && nc.close < candleClose) score += 2;
          }

          const zk = makeZoneKey(ref.zoneType, ref.level);
          if (isZoneRecentlyUsed(zk, i) && !canRearmZone(zk, candleClose))
            continue;

          if (score >= cfg.minReversalScore && !isDuplicate(candleClose, i)) {
            const sl = reversalSL(candleHigh);
            const risk = sl - candleClose;
            if (risk > 0 && risk <= maxSellRiskPts) {
              markZoneUsed(zk, i, ref.level);
              if (
                isValidSweepTriggerCandle(candle) &&
                score >= cfg.sweepDirectMinScore
              ) {
                const sig = buildSignal(
                  i,
                  `V2E: Liquidity Sweep Rejection (${ref.label})`,
                  candleClose,
                  sl,
                  true,
                  true,
                  false,
                );
                results.push(sig);
                diagLog('v2e', '[V2E-SIGNAL-E]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: sig.candleTime,
                  setup: 'E-LiquiditySweep',
                  zone: ref.label,
                  score,
                  sweepExcess,
                  marketState,
                  entryMode: 'direct',
                  entryPrice: sig.entryPrice,
                  stopLoss: sig.stopLoss,
                  risk: sig.risk,
                  ema20,
                });
                lastSignalIndex = i;
                lastSignalPrice = candleClose;
              } else {
                armSetup(
                  'E',
                  i,
                  candleHigh,
                  candleLow,
                  ref.level,
                  sl,
                  `V2E: Liquidity Sweep Rejection (${ref.label})`,
                  true,
                  true,
                  false,
                  marketState,
                );
                diagLog('v2e', '[V2E-ARMED-E]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: getCandleTimeStr(candle),
                  zone: ref.label,
                  score,
                  sweepExcess,
                  signalLow: candleLow,
                  marketState,
                  expiryIndex: i + getArmedExpiryWindow('E', marketState),
                });
                // Also store as 2-candle sequence candidate alongside the arm.
                if (isValidSweepSetupCandle(candle, ref.level)) {
                  if (sl - candleClose <= maxSellRiskPts) {
                    addPendingSequence({
                      seqType: 'SWEEP',
                      setupIndex: i,
                      zoneReference: ref.level,
                      zoneType: ref.zoneType ?? 'E_SWEEP',
                      setupHigh: candleHigh,
                      setupLow: candleLow,
                      setupMidpoint: (candleHigh + candleLow) / 2,
                      stopLoss: sl,
                      reason: `V2E: Liquidity Sweep Rejection (${ref.label})`,
                      isDayHighZoneRejection: true,
                      nearDayHighZone: true,
                      isNearDailyHigh: false,
                      expiryIndex: i + cfg.seqConfirmWindowCandles,
                      marketStateAtSetup: marketState,
                    });
                  }
                }
              }
              break; // one sweep signal per candle
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Get chart data for a specific option with candles, EMA, and signals
   */
  async getOptionChartData(
    brokerId: string,
    instrumentToken: string,
    targetDate: string,
    interval: 'minute' | '5minute' | '15minute' | '30minute' | '60minute',
    strategy:
      | 'PREV_DAY_HIGH_LOW'
      | '20_EMA'
      | 'DAY_SELLING'
      | 'DAY_SELLING_V2'
      | 'DAY_SELLING_V2_ENHANCED'
      | 'DAY_SELLING_V1V2'
      | 'DAY_SELLING_V3'
      | 'DAY_SELLING_V4'
      | 'DAY_BUYING'
      | 'SMART_SELL'
      | 'TREND_NIFTY'
      | 'DAY_HIGH_REJECTION',
    marginPoints: number,
  ) {
    this.logger.log(
      `getOptionChartData called with: brokerId=${brokerId}, instrumentToken=${instrumentToken}, targetDate=${targetDate}, interval=${interval}, strategy=${strategy}`,
    );

    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker) {
      this.logger.error(`Broker not found: ${brokerId}`);
      throw new Error('Broker not found');
    }

    if (!broker.accessToken) {
      throw new Error('Broker access token not found');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    const today = new Date(targetDate);
    const todayStr = today.toISOString().split('T')[0];

    // Get yesterday's date (skip weekends)
    const yesterday = new Date(targetDate);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayDay = yesterday.getDay();
    if (yesterdayDay === 0) {
      yesterday.setDate(yesterday.getDate() - 2);
    } else if (yesterdayDay === 6) {
      yesterday.setDate(yesterday.getDate() - 1);
    }
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const todayFrom = `${todayStr} 09:15:00`;
    const todayTo = `${todayStr} 15:30:00`;
    const yesterdayFrom = `${yesterdayStr} 09:15:00`;
    const yesterdayTo = `${yesterdayStr} 15:30:00`;

    // Wide lookback window (7 calendar days) to handle market holidays.
    // Kite will only return candles for actual trading days within this range.
    const prevWindowStart = new Date(targetDate);
    prevWindowStart.setDate(prevWindowStart.getDate() - 7);
    const prevWindowFrom = `${prevWindowStart.toISOString().split('T')[0]} 09:15:00`;

    // Fetch today's intraday candles
    const candles = await kc.getHistoricalData(
      instrumentToken,
      interval,
      todayFrom,
      todayTo,
    );

    if (!candles || candles.length === 0) {
      throw new Error('No candle data available');
    }

    // Log first candle to check date format
    if (candles.length > 0) {
      this.logger.log(
        `First candle date: ${candles[0].date}, type: ${typeof candles[0].date}, ISO: ${candles[0].date instanceof Date ? candles[0].date.toISOString() : 'N/A'}`,
      );
    }

    const chartData: any = {
      candles: candles.map((c: any) => {
        // Kite returns dates as Date objects in IST (UTC+5:30)
        // We need to adjust timestamps so they display correctly in the chart
        // Since charts typically display in UTC, we add IST offset to preserve the local time
        let timestamp: number;
        if (c.date instanceof Date) {
          // Get the timestamp and add IST offset (5 hours 30 minutes = 19800 seconds)
          timestamp = Math.floor(c.date.getTime() / 1000) + 19800;
        } else if (typeof c.date === 'string') {
          timestamp = Math.floor(new Date(c.date).getTime() / 1000) + 19800;
        } else {
          timestamp = Math.floor(c.date / 1000) + 19800;
        }

        return {
          time: timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        };
      }),
      signals: [],
      ema: [],
      yesterdayHigh: null,
      yesterdayLow: null,
    };

    if (strategy === '20_EMA') {
      // Calculate 20 EMA with pre-seeding from yesterday's data
      // Fetch yesterday's intraday data to pre-seed EMA
      const yesterdayIntraday20EMA = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      this.logger.debug(
        `20_EMA: Fetched ${yesterdayIntraday20EMA?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      let emaValues: (number | null)[];
      if (yesterdayIntraday20EMA && yesterdayIntraday20EMA.length > 0) {
        const yesterdaySeed = yesterdayIntraday20EMA.slice(-25);
        const combinedClosePrices = [
          ...yesterdaySeed.map((c: any) => c.close),
          ...candles.map((c: any) => c.close),
        ];
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );
        emaValues = combinedEMA.slice(yesterdaySeed.length);
        this.logger.debug(
          `20_EMA: Pre-seeded with ${yesterdaySeed.length} yesterday candles. EMA from first candle.`,
        );
      } else {
        this.logger.warn(
          `20_EMA: No yesterday data available, using standard EMA (will be null for first 19 candles)`,
        );
        const closePrices = candles.map((c: any) => c.close);
        emaValues = this.indicators.calculateEMA(closePrices, 20);
      }

      // Add EMA line data
      chartData.ema = candles
        .map((c: any, i: number) => {
          const timestamp =
            c.date instanceof Date
              ? Math.floor(c.date.getTime() / 1000) + 19800
              : Math.floor(new Date(c.date).getTime() / 1000) + 19800;
          return {
            time: timestamp,
            value: emaValues[i],
          };
        })
        .filter((e: any) => e.value !== null);

      // Determine EMA trend
      let emaTrend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
      if (emaValues.length >= 25) {
        const currentEMA = emaValues[emaValues.length - 1];
        const pastEMA = emaValues[emaValues.length - 6];
        if (currentEMA && pastEMA) {
          if (currentEMA > pastEMA * 1.002) {
            emaTrend = 'UP';
          } else if (currentEMA < pastEMA * 0.998) {
            emaTrend = 'DOWN';
          }
        }
      }

      // === DAILY TRADING LIMITS ===
      let dailyTradesCount = 0;
      let dailyPnL = 0;
      let dailyStopTrading = false;
      const MAX_DAILY_TRADES = 2;
      const MAX_DAILY_LOSS = 35; // points

      // Detect signals
      for (let i = 19; i < candles.length; i++) {
        // === CHECK DAILY LIMITS ===
        if (dailyStopTrading || dailyTradesCount >= MAX_DAILY_TRADES) {
          break; // Stop generating new signals for the day
        }

        const candle = candles[i];
        const candleEMA = emaValues[i];

        if (!candleEMA) continue;

        const candleHigh = candle.high;
        const candleLow = candle.low;
        const candleOpen = candle.open;
        const candleClose = candle.close;

        const distanceHighToEMA = Math.abs(candleHigh - candleEMA);
        const distanceLowToEMA = Math.abs(candleLow - candleEMA);
        const distanceCloseToEMA = Math.abs(candleClose - candleEMA);

        const touchedEMA =
          distanceHighToEMA <= marginPoints ||
          distanceLowToEMA <= marginPoints ||
          distanceCloseToEMA <= marginPoints;

        if (touchedEMA) {
          const candleBody = Math.abs(candleClose - candleOpen);
          const upperWick = candleHigh - Math.max(candleOpen, candleClose);
          const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
          const isGreenCandle = candleClose > candleOpen;
          const isRedCandle = candleClose < candleOpen;

          // BUY signals in uptrend
          if (emaTrend === 'UP') {
            const hasLowerWickRejection =
              lowerWick > candleBody * 1.2 &&
              candleClose > candleEMA &&
              candleLow <= candleEMA * 1.01;

            const hasBullishBounce =
              candleOpen < candleEMA &&
              candleClose > candleEMA &&
              isGreenCandle &&
              candleBody > (candleHigh - candleLow) * 0.4;

            if (hasLowerWickRejection || hasBullishBounce) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'BUY',
                  candle,
                );
              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
              chartData.signals.push({
                time: timestamp,
                type: 'BUY',
                price: candleClose,
                stopLoss,
                target,
                text: hasLowerWickRejection
                  ? 'Lower wick rejection'
                  : 'Bullish bounce',
              });

              dailyTradesCount++;

              // Look ahead to check trade outcome
              const risk = Math.abs(candleClose - stopLoss);
              const target1_3 = candleClose + risk * 3;
              const target1_4 = candleClose + risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                if (futureCandle.low <= stopLoss) {
                  dailyPnL -= candleClose - stopLoss;
                  tradeCompleted = true;
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                  }
                  break;
                }

                if (futureCandle.high >= target1_4) {
                  dailyPnL += target1_4 - candleClose;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.high >= target1_3) {
                  dailyPnL += target1_3 - candleClose;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.high >= target) {
                  dailyPnL += target - candleClose;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          // SELL signals in downtrend
          if (emaTrend === 'DOWN') {
            const hasUpperWickRejection =
              upperWick > candleBody * 1.2 &&
              candleClose < candleEMA &&
              candleHigh >= candleEMA * 0.99;

            const hasBearishRejection =
              candleOpen > candleEMA &&
              candleClose < candleEMA &&
              isRedCandle &&
              candleBody > (candleHigh - candleLow) * 0.4;

            if (hasUpperWickRejection || hasBearishRejection) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'SELL',
                  candle,
                );
              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
              chartData.signals.push({
                time: timestamp,
                type: 'SELL',
                price: candleClose,
                stopLoss,
                target,
                text: hasUpperWickRejection
                  ? 'Upper wick rejection'
                  : 'Bearish rejection',
              });

              dailyTradesCount++;

              // Look ahead to check trade outcome
              const risk = Math.abs(stopLoss - candleClose);
              const target1_3 = candleClose - risk * 3;
              const target1_4 = candleClose - risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                if (futureCandle.high >= stopLoss) {
                  dailyPnL -= stopLoss - candleClose;
                  tradeCompleted = true;
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                  }
                  break;
                }

                if (futureCandle.low <= target1_4) {
                  dailyPnL += candleClose - target1_4;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.low <= target1_3) {
                  dailyPnL += candleClose - target1_3;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.low <= target) {
                  dailyPnL += candleClose - target;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          // Break out of main loop if daily stop triggered
          if (dailyStopTrading) break;
        }
      }
    } else if (strategy === 'PREV_DAY_HIGH_LOW') {
      // Fetch yesterday's data (use wide window to handle holidays)
      const yesterdayHistorical = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      if (yesterdayHistorical && yesterdayHistorical.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        const yesterdayData =
          yesterdayHistorical[yesterdayHistorical.length - 1];
        chartData.yesterdayHigh = yesterdayData.high;
        chartData.yesterdayLow = yesterdayData.low;

        // === DAILY TRADING LIMITS ===
        let dailyTradesCount = 0;
        let dailyPnL = 0;
        let dailyStopTrading = false;
        const MAX_DAILY_TRADES = 2;
        const MAX_DAILY_LOSS = 35; // points

        // Detect signals at yesterday's high/low
        for (let i = 0; i < candles.length; i++) {
          // === CHECK DAILY LIMITS ===
          if (dailyStopTrading || dailyTradesCount >= MAX_DAILY_TRADES) {
            break; // Stop generating new signals for the day
          }

          const candle = candles[i];
          const candleHigh = candle.high;
          const candleLow = candle.low;
          const candleOpen = candle.open;
          const candleClose = candle.close;
          const candleBody = Math.abs(candleClose - candleOpen);
          const upperWick = candleHigh - Math.max(candleOpen, candleClose);
          const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
          const totalCandleRange = candleHigh - candleLow;
          const isRedCandle = candleClose < candleOpen;
          const isGreenCandle = candleClose > candleOpen;

          const distanceHighToYesterdayHigh = Math.abs(
            candleHigh - yesterdayData.high,
          );
          const distanceLowToYesterdayLow = Math.abs(
            candleLow - yesterdayData.low,
          );

          const nearYesterdayHigh = distanceHighToYesterdayHigh <= marginPoints;
          const nearYesterdayLow = distanceLowToYesterdayLow <= marginPoints;

          // SELL signals at yesterday's high - bearish patterns OR rejection signals
          if (nearYesterdayHigh) {
            const pattern = this.indicators.detectBearishPattern(candles, i);

            // Check for rejection at resistance even without perfect pattern
            const hasUpperWickRejection =
              upperWick > candleBody * 1.5 &&
              candleClose < yesterdayData.high &&
              candleHigh >= yesterdayData.high * 0.998;

            const hasBreakoutFailure =
              candleOpen > yesterdayData.high &&
              candleClose < yesterdayData.high &&
              isRedCandle &&
              candleBody > totalCandleRange * 0.5;

            const hasBearishClose =
              isRedCandle &&
              candleHigh >= yesterdayData.high * 0.998 &&
              candleClose < yesterdayData.high * 0.995;

            if (
              pattern ||
              hasUpperWickRejection ||
              hasBreakoutFailure ||
              hasBearishClose
            ) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'SELL',
                  candle,
                );

              let signalText = '';
              if (pattern) {
                signalText = `${pattern} @ Resistance`;
              } else if (hasUpperWickRejection) {
                signalText = 'Rejection @ Resistance';
              } else if (hasBreakoutFailure) {
                signalText = 'Breakout Failure';
              } else {
                signalText = 'Bearish @ Resistance';
              }

              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

              chartData.signals.push({
                time: timestamp,
                type: 'SELL',
                price: candleClose,
                stopLoss,
                target,
                text: signalText,
              });

              dailyTradesCount++;

              // Look ahead to check if this trade hits SL or Target
              const risk = Math.abs(stopLoss - candleClose);
              const target1_3 = candleClose - risk * 3;
              const target1_4 = candleClose - risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                // Check if SL hit (price goes above SL for SELL)
                if (futureCandle.high >= stopLoss) {
                  const loss = stopLoss - candleClose;
                  dailyPnL -= loss;
                  tradeCompleted = true;

                  // Check if max daily loss reached
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                    this.logger.log(
                      `MAX DAILY LOSS REACHED: ${Math.abs(dailyPnL).toFixed(1)} pts. Stopping trading.`,
                    );
                  }
                  break;
                }

                // Check targets
                if (futureCandle.low <= target1_4) {
                  dailyPnL += candleClose - target1_4;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:4 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.low <= target1_3) {
                  dailyPnL += candleClose - target1_3;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:3 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.low <= target) {
                  dailyPnL += candleClose - target;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:2 HIT. Stopping trading for the day.',
                  );
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          // Break out of main loop if daily stop triggered
          if (dailyStopTrading) break;

          // BUY signals at yesterday's low - bullish patterns OR rejection signals
          if (nearYesterdayLow) {
            const pattern = this.indicators.detectBullishPattern(candles, i);

            // Check for rejection at support even without perfect pattern
            const hasLowerWickRejection =
              lowerWick > candleBody * 1.5 &&
              candleClose > yesterdayData.low &&
              candleLow <= yesterdayData.low * 1.002;

            const hasBreakdownFailure =
              candleOpen < yesterdayData.low &&
              candleClose > yesterdayData.low &&
              isGreenCandle &&
              candleBody > totalCandleRange * 0.5;

            const hasBullishClose =
              isGreenCandle &&
              candleLow <= yesterdayData.low * 1.002 &&
              candleClose > yesterdayData.low * 1.005;

            if (
              pattern ||
              hasLowerWickRejection ||
              hasBreakdownFailure ||
              hasBullishClose
            ) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'BUY',
                  candle,
                );

              let signalText = '';
              if (pattern) {
                signalText = `${pattern} @ Support`;
              } else if (hasLowerWickRejection) {
                signalText = 'Rejection @ Support';
              } else if (hasBreakdownFailure) {
                signalText = 'Breakdown Failure';
              } else {
                signalText = 'Bullish @ Support';
              }

              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

              chartData.signals.push({
                time: timestamp,
                type: 'BUY',
                price: candleClose,
                stopLoss,
                target,
                text: signalText,
              });

              dailyTradesCount++;

              // Look ahead to check if this trade hits SL or Target
              const risk = Math.abs(candleClose - stopLoss);
              const target1_3 = candleClose + risk * 3;
              const target1_4 = candleClose + risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                // Check if SL hit (price goes below SL for BUY)
                if (futureCandle.low <= stopLoss) {
                  const loss = candleClose - stopLoss;
                  dailyPnL -= loss;
                  tradeCompleted = true;

                  // Check if max daily loss reached
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                    this.logger.log(
                      `MAX DAILY LOSS REACHED: ${Math.abs(dailyPnL).toFixed(1)} pts. Stopping trading.`,
                    );
                  }
                  break;
                }

                // Check targets (highest to lowest)
                if (futureCandle.high >= target1_4) {
                  dailyPnL += target1_4 - candleClose;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:4 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.high >= target1_3) {
                  dailyPnL += target1_3 - candleClose;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:3 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.high >= target) {
                  dailyPnL += target - candleClose;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:2 HIT. Stopping trading for the day.',
                  );
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          //Break out of main loop if daily stop triggered
          if (dailyStopTrading) break;
        }
      }
    } else if (strategy === 'DAY_SELLING') {
      // DAY_SELLING Strategy: Only SELL signals using bearish patterns
      // Fetch previous trading day data (wide window to handle holidays)
      const yesterdayDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHigh = 0;
      let prevDayLow = 0;
      let prevDayClose = 0;
      if (yesterdayDayData && yesterdayDayData.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        yesterdayHigh = yesterdayDayData[yesterdayDayData.length - 1].high;
        prevDayLow = yesterdayDayData[yesterdayDayData.length - 1].low;
        prevDayClose = yesterdayDayData[yesterdayDayData.length - 1].close;
        chartData.yesterdayHigh = yesterdayHigh;
        this.logger.debug(
          `Yesterday high = ${yesterdayHigh}, prev day low = ${prevDayLow}, prev day close = ${prevDayClose}`,
        );
      }

      // Fetch previous trading days' intraday data to pre-seed EMA calculation
      const yesterdayIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      this.logger.debug(
        `Fetched ${yesterdayIntradayData?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      // Calculate 20 EMA with pre-seeding from yesterday's data
      let emaValues: (number | null)[];

      if (yesterdayIntradayData && yesterdayIntradayData.length > 0) {
        // Pre-seed EMA: Combine yesterday's last 25 candles + today's candles
        const yesterdayLast25 = yesterdayIntradayData.slice(-25);
        const combinedCandles = [...yesterdayLast25, ...candles];
        const combinedClosePrices = combinedCandles.map((c) => c.close);

        // Calculate EMA on combined data
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );

        // Extract only today's EMA values (skip yesterday's candles)
        emaValues = combinedEMA.slice(yesterdayLast25.length);

        this.logger.debug(
          `Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday. EMA available from first candle.`,
        );
      } else {
        // Fallback: Standard EMA calculation if no yesterday data
        this.logger.warn(
          `No sufficient yesterday data for EMA pre-seeding, using standard calculation`,
        );
        const closePrices = candles.map((c) => c.close);
        emaValues = this.indicators.calculateEMA(closePrices, 20);
      }

      // Build EMA data for chart
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValues[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return {
            time: timestamp,
            value: ema,
          };
        })
        .filter((e: any) => e !== null);

      // Calculate RSI for signal gating (signals above first candle high allowed only if RSI > 60)
      let rsiValues: (number | null)[];
      if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
        const yesterdayForRSI = yesterdayIntradayData.slice(-30);
        const combinedForRSI = [...yesterdayForRSI, ...candles];
        const combinedRSIClosePrices = combinedForRSI.map((c) => c.close);
        const combinedRSI = this.indicators.calculateRSI(
          combinedRSIClosePrices,
          14,
        );
        rsiValues = combinedRSI.slice(yesterdayForRSI.length);
      } else {
        const closePrices = candles.map((c) => c.close);
        rsiValues = this.indicators.calculateRSI(closePrices, 14);
      }

      // Find swing highs (local peaks)
      const swingHighs: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const candle = candles[i];
        const prevCandles = candles.slice(i - 5, i);
        const nextCandles = candles.slice(i + 1, i + 6);

        const isLocalHigh =
          prevCandles.every((c) => c.high < candle.high) &&
          nextCandles.every((c) => c.high < candle.high);

        if (isLocalHigh) {
          swingHighs.push({ price: candle.high, index: i });
        }
      }

      this.logger.debug(`Found ${swingHighs.length} swing highs`);

      // Chart path: show ALL signals — no trade cap here.
      // Trade capping (max 2/day, daily loss limit) belongs in the simulator only.
      const superTrendData = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );
      // Load sell signal thresholds from user settings (non-blocking)
      const chartInstrument = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbol = this.normalizeSettingsSymbol(
        chartInstrument?.name ?? 'NIFTY',
      );
      const chartSettings = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbol },
          },
        })
        .catch(() => null);
      const chartMinSellRsi = chartSettings?.minSellRsi ?? 45;
      const chartMaxSellRiskPts = chartSettings?.maxSellRiskPts ?? 25;
      const daySellSignals = this.detectDaySellSignals({
        candles,
        emaValues,
        rsiValues,
        swingHighs,
        yesterdayHigh,
        prevDayLow,
        prevDayClose,
        marginPoints,
        minSellRsi: chartMinSellRsi,
        maxSellRiskPts: chartMaxSellRiskPts,
        superTrendData,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignals) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;

        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V2') {
      // DAY_SELLING_V2: Fresh V2 engine — 3 independent setups
      const yesterdayDayDataV2 = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHighV2 = 0;
      let prevDayLowV2 = 0;
      let prevDayCloseV2 = 0;
      if (yesterdayDayDataV2 && yesterdayDayDataV2.length > 0) {
        yesterdayHighV2 =
          yesterdayDayDataV2[yesterdayDayDataV2.length - 1].high;
        prevDayLowV2 = yesterdayDayDataV2[yesterdayDayDataV2.length - 1].low;
        prevDayCloseV2 =
          yesterdayDayDataV2[yesterdayDayDataV2.length - 1].close;
        chartData.yesterdayHigh = yesterdayHighV2;
        this.logger.debug(
          `V2: Yesterday high = ${yesterdayHighV2}, prev day low = ${prevDayLowV2}, prev day close = ${prevDayCloseV2}`,
        );
      }

      const yesterdayIntradayDataV2 = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let emaValuesV2: (number | null)[];
      if (yesterdayIntradayDataV2 && yesterdayIntradayDataV2.length > 0) {
        const seedV2 = yesterdayIntradayDataV2.slice(-25);
        const combinedV2 = [...seedV2, ...candles];
        const combinedEMAV2 = this.indicators.calculateEMA(
          combinedV2.map((c) => c.close),
          20,
        );
        emaValuesV2 = combinedEMAV2.slice(seedV2.length);
      } else {
        emaValuesV2 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // Build EMA chart data
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValuesV2[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI with pre-seeding
      let rsiValuesV2: (number | null)[];
      if (yesterdayIntradayDataV2 && yesterdayIntradayDataV2.length >= 14) {
        const yesterdayForRSIV2 = yesterdayIntradayDataV2.slice(-30);
        const combinedForRSIV2 = [...yesterdayForRSIV2, ...candles];
        const combinedRSIV2 = this.indicators.calculateRSI(
          combinedForRSIV2.map((c) => c.close),
          14,
        );
        rsiValuesV2 = combinedRSIV2.slice(yesterdayForRSIV2.length);
      } else {
        rsiValuesV2 = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsV2: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsV2.push({ price: c.high, index: i });
        }
      }

      const superTrendDataV2 = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV2 = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV2 = this.normalizeSettingsSymbol(
        chartInstrumentV2?.name ?? 'NIFTY',
      );
      const chartSettingsV2 = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV2 },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV2 = chartSettingsV2?.maxSellRiskPts ?? 25;

      const daySellSignalsV2 = this.detectDaySellSignalsV2({
        candles,
        emaValues: emaValuesV2,
        rsiValues: rsiValuesV2,
        swingHighs: swingHighsV2,
        yesterdayHigh: yesterdayHighV2,
        prevDayLow: prevDayLowV2,
        prevDayClose: prevDayCloseV2,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV2,
        superTrendData: superTrendDataV2,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV2) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V1V2') {
      // DAY_SELLING_V1V2: Combined engine — V1 first, V2 as fallback.
      // Uses the same data as V2 (same pre-seeding, same prev-day levels).
      // Both V1 and V2 receive IDENTICAL data so the comparison is fair.
      const yesterdayDayDataC = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHighC = 0;
      let prevDayLowC = 0;
      let prevDayCloseC = 0;
      if (yesterdayDayDataC && yesterdayDayDataC.length > 0) {
        yesterdayHighC = yesterdayDayDataC[yesterdayDayDataC.length - 1].high;
        prevDayLowC = yesterdayDayDataC[yesterdayDayDataC.length - 1].low;
        prevDayCloseC = yesterdayDayDataC[yesterdayDayDataC.length - 1].close;
        chartData.yesterdayHigh = yesterdayHighC;
      }

      const yesterdayIntradayDataC = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // EMA pre-seeding
      let emaValuesC: (number | null)[];
      if (yesterdayIntradayDataC && yesterdayIntradayDataC.length > 0) {
        const seedC = yesterdayIntradayDataC.slice(-25);
        const combinedC = [...seedC, ...candles];
        const combinedEMAC = this.indicators.calculateEMA(
          combinedC.map((c) => c.close),
          20,
        );
        emaValuesC = combinedEMAC.slice(seedC.length);
      } else {
        emaValuesC = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // Build EMA chart data
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValuesC[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI pre-seeding
      let rsiValuesC: (number | null)[];
      if (yesterdayIntradayDataC && yesterdayIntradayDataC.length >= 14) {
        const seedForRSIC = yesterdayIntradayDataC.slice(-30);
        const combinedForRSIC = [...seedForRSIC, ...candles];
        const combinedRSIC = this.indicators.calculateRSI(
          combinedForRSIC.map((c) => c.close),
          14,
        );
        rsiValuesC = combinedRSIC.slice(seedForRSIC.length);
      } else {
        rsiValuesC = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsC: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsC.push({ price: c.high, index: i });
        }
      }

      const superTrendDataC = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentC = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolC = this.normalizeSettingsSymbol(
        chartInstrumentC?.name ?? 'NIFTY',
      );
      const chartSettingsC = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolC },
          },
        })
        .catch(() => null);
      const chartMinSellRsiC = chartSettingsC?.minSellRsi ?? 45;
      const chartMaxSellRiskPtsC = chartSettingsC?.maxSellRiskPts ?? 25;

      const combinedSignals = this.detectDaySellSignalsCombined({
        candles,
        emaValues: emaValuesC,
        rsiValues: rsiValuesC,
        swingHighs: swingHighsC,
        yesterdayHigh: yesterdayHighC,
        prevDayLow: prevDayLowC,
        prevDayClose: prevDayCloseC,
        marginPoints,
        minSellRsi: chartMinSellRsiC,
        maxSellRiskPts: chartMaxSellRiskPtsC,
        superTrendData: superTrendDataC,
        instrumentName: instrumentToken,
      });

      for (const sig of combinedSignals) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V3') {
      // DAY_SELLING_V3: 4-engine strategy — First Candle Breakdown | Resistance Rejection
      //                                     | EMA Rejection | Lower High Breakdown
      const yesterdayDayDataV3 = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHighV3 = 0;
      let prevDayLowV3 = 0;
      let prevDayCloseV3 = 0;
      if (yesterdayDayDataV3 && yesterdayDayDataV3.length > 0) {
        yesterdayHighV3 =
          yesterdayDayDataV3[yesterdayDayDataV3.length - 1].high;
        prevDayLowV3 = yesterdayDayDataV3[yesterdayDayDataV3.length - 1].low;
        prevDayCloseV3 =
          yesterdayDayDataV3[yesterdayDayDataV3.length - 1].close;
        chartData.yesterdayHigh = yesterdayHighV3;
        this.logger.debug(
          `V3: Yesterday high = ${yesterdayHighV3}, prev day low = ${prevDayLowV3}, prev day close = ${prevDayCloseV3}`,
        );
      }

      const yesterdayIntradayDataV3 = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let emaValuesV3: (number | null)[];
      if (yesterdayIntradayDataV3 && yesterdayIntradayDataV3.length > 0) {
        const seedV3 = yesterdayIntradayDataV3.slice(-25);
        const combinedV3 = [...seedV3, ...candles];
        const combinedEMAV3 = this.indicators.calculateEMA(
          combinedV3.map((c) => c.close),
          20,
        );
        emaValuesV3 = combinedEMAV3.slice(seedV3.length);
      } else {
        emaValuesV3 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // Build EMA chart data
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValuesV3[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI with pre-seeding
      let rsiValuesV3: (number | null)[];
      if (yesterdayIntradayDataV3 && yesterdayIntradayDataV3.length >= 14) {
        const yesterdayForRSIV3 = yesterdayIntradayDataV3.slice(-30);
        const combinedForRSIV3 = [...yesterdayForRSIV3, ...candles];
        const combinedRSIV3 = this.indicators.calculateRSI(
          combinedForRSIV3.map((c) => c.close),
          14,
        );
        rsiValuesV3 = combinedRSIV3.slice(yesterdayForRSIV3.length);
      } else {
        rsiValuesV3 = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsV3: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsV3.push({ price: c.high, index: i });
        }
      }

      const superTrendDataV3 = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV3 = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV3 = this.normalizeSettingsSymbol(
        chartInstrumentV3?.name ?? 'NIFTY',
      );
      const chartSettingsV3 = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV3 },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV3 = chartSettingsV3?.maxSellRiskPts ?? 35;

      const daySellSignalsV3 = this.detectDaySellSignalsV3({
        candles,
        emaValues: emaValuesV3,
        rsiValues: rsiValuesV3,
        swingHighs: swingHighsV3,
        yesterdayHigh: yesterdayHighV3,
        prevDayLow: prevDayLowV3,
        prevDayClose: prevDayCloseV3,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV3,
        superTrendData: superTrendDataV3,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV3) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V4') {
      // DAY_SELLING_V4: 6-scenario sell signal detection on option candle data.
      // Works purely on option chart — no NIFTY-spot dependency.
      const v4YestDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      if (v4YestDayData && v4YestDayData.length > 0) {
        chartData.yesterdayHigh = v4YestDayData[v4YestDayData.length - 1].high;
      }

      const v4YestIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let ema20ValuesV4: (number | null)[];
      if (v4YestIntradayData && v4YestIntradayData.length > 0) {
        const seedV4 = v4YestIntradayData.slice(-25);
        const combinedV4 = [...seedV4, ...candles];
        ema20ValuesV4 = this.indicators
          .calculateEMA(
            combinedV4.map((c) => c.close),
            20,
          )
          .slice(seedV4.length);
      } else {
        ema20ValuesV4 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // 8 EMA with pre-seeding
      let ema8ValuesV4: (number | null)[];
      if (v4YestIntradayData && v4YestIntradayData.length > 0) {
        const seedV4 = v4YestIntradayData.slice(-15);
        const combinedV4 = [...seedV4, ...candles];
        ema8ValuesV4 = this.indicators
          .calculateEMA(
            combinedV4.map((c) => c.close),
            8,
          )
          .slice(seedV4.length);
      } else {
        ema8ValuesV4 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          8,
        );
      }

      // Build EMA chart data (20 EMA)
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = ema20ValuesV4[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // VWAP (today's candles only, no pre-seeding)
      const vwapValuesV4 = this.indicators.calculateVWAP(
        candles.map((c) => ({
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        })),
      );

      const superTrendDataV4 = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV4 = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV4 = this.normalizeSettingsSymbol(
        chartInstrumentV4?.name ?? 'NIFTY',
      );
      const chartSettingsV4 = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV4 },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV4 = chartSettingsV4?.maxSellRiskPts ?? 40;

      const daySellSignalsV4 = this.detectDaySellSignalsV4({
        candles,
        ema8Values: ema8ValuesV4,
        ema20Values: ema20ValuesV4,
        vwapValues: vwapValuesV4,
        superTrendData: superTrendDataV4,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV4,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV4) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V2_ENHANCED') {
      // DAY_SELLING_V2_ENHANCED: v2 upgraded with v4 quality filters.
      // Needs both 20 EMA + 8 EMA (for sideways detection), RSI, prev-day levels.
      const v2eYestDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let v2eYestHigh = 0;
      let v2ePrevDayLow = 0;
      let v2ePrevDayClose = 0;
      if (v2eYestDayData && v2eYestDayData.length > 0) {
        v2eYestHigh = v2eYestDayData[v2eYestDayData.length - 1].high;
        v2ePrevDayLow = v2eYestDayData[v2eYestDayData.length - 1].low;
        v2ePrevDayClose = v2eYestDayData[v2eYestDayData.length - 1].close;
        chartData.yesterdayHigh = v2eYestHigh;
      }

      const v2eYestIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let ema20ValuesV2e: (number | null)[];
      if (v2eYestIntradayData && v2eYestIntradayData.length > 0) {
        const seedV2e = v2eYestIntradayData.slice(-25);
        const combinedV2e = [...seedV2e, ...candles];
        ema20ValuesV2e = this.indicators
          .calculateEMA(
            combinedV2e.map((c) => c.close),
            20,
          )
          .slice(seedV2e.length);
      } else {
        ema20ValuesV2e = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // 8 EMA with pre-seeding
      let ema8ValuesV2e: (number | null)[];
      if (v2eYestIntradayData && v2eYestIntradayData.length > 0) {
        const seedV2e8 = v2eYestIntradayData.slice(-15);
        const combinedV2e8 = [...seedV2e8, ...candles];
        ema8ValuesV2e = this.indicators
          .calculateEMA(
            combinedV2e8.map((c) => c.close),
            8,
          )
          .slice(seedV2e8.length);
      } else {
        ema8ValuesV2e = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          8,
        );
      }

      // Build EMA chart data (20 EMA)
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = ema20ValuesV2e[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI with pre-seeding
      let rsiValuesV2e: (number | null)[];
      if (v2eYestIntradayData && v2eYestIntradayData.length >= 14) {
        const seedRsiV2e = v2eYestIntradayData.slice(-30);
        const combinedRsiV2e = [...seedRsiV2e, ...candles];
        rsiValuesV2e = this.indicators
          .calculateRSI(
            combinedRsiV2e.map((c) => c.close),
            14,
          )
          .slice(seedRsiV2e.length);
      } else {
        rsiValuesV2e = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsV2e: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsV2e.push({ price: c.high, index: i });
        }
      }

      const superTrendDataV2e = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV2e = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV2e = this.normalizeSettingsSymbol(
        chartInstrumentV2e?.name ?? 'NIFTY',
      );
      const chartSettingsV2e = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV2e },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV2e = chartSettingsV2e?.maxSellRiskPts ?? 30;

      const daySellSignalsV2e = this.detectDaySellSignalsV2Enhanced({
        candles,
        ema20Values: ema20ValuesV2e,
        ema8Values: ema8ValuesV2e,
        rsiValues: rsiValuesV2e,
        swingHighs: swingHighsV2e,
        yesterdayHigh: v2eYestHigh,
        prevDayLow: v2ePrevDayLow,
        prevDayClose: v2ePrevDayClose,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV2e,
        superTrendData: superTrendDataV2e,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV2e) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_BUYING') {
      // DAY_BUYING Strategy: Only BUY signals using bullish patterns
      // Fetch previous trading day data (wide window to handle holidays)
      const yesterdayDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayLow = 0;
      if (yesterdayDayData && yesterdayDayData.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        yesterdayLow = yesterdayDayData[yesterdayDayData.length - 1].low;
        chartData.yesterdayLow = yesterdayLow;
        this.logger.debug(`Yesterday low = ${yesterdayLow}`);
      }

      // Fetch previous trading days' intraday data to pre-seed EMA calculation
      const yesterdayIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      this.logger.debug(
        `Fetched ${yesterdayIntradayData?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      // Calculate 20 EMA with pre-seeding from yesterday's data
      let emaValues: (number | null)[];

      if (yesterdayIntradayData && yesterdayIntradayData.length > 0) {
        const yesterdayLast25 = yesterdayIntradayData.slice(-25);
        const combinedCandles = [...yesterdayLast25, ...candles];
        const combinedClosePrices = combinedCandles.map((c) => c.close);
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );
        emaValues = combinedEMA.slice(yesterdayLast25.length);
        this.logger.debug(
          `Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday. EMA available from first candle.`,
        );
      } else {
        this.logger.warn(
          `No sufficient yesterday data for EMA pre-seeding, using standard calculation`,
        );
        const closePrices = candles.map((c) => c.close);
        emaValues = this.indicators.calculateEMA(closePrices, 20);
      }

      // Build EMA data for chart
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValues[idx];
          if (ema == null) return null;
          const time =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return {
            time: time,
            value: ema,
          };
        })
        .filter((e: any) => e !== null);

      // First candle low (9:15 AM)
      const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
      if (firstCandleLow > 0) {
        this.logger.debug(
          `First Candle Low (9:15 AM) = ${firstCandleLow.toFixed(2)} (BUY signals must be ABOVE this)`,
        );
      }

      // Calculate RSI for filtering (only BUY when RSI < 60)
      let rsiValues: (number | null)[];

      if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
        // Pre-seed RSI: Combine yesterday's candles + today's candles
        const yesterdayForRSI = yesterdayIntradayData.slice(-30);
        const combinedCandles = [...yesterdayForRSI, ...candles];
        const combinedClosePrices = combinedCandles.map((c: any) => c.close);

        // Calculate RSI on combined data
        const combinedRSI = this.indicators.calculateRSI(
          combinedClosePrices,
          14,
        );

        // Extract only today's RSI values
        rsiValues = combinedRSI.slice(yesterdayForRSI.length);

        this.logger.debug(
          `Pre-seeded RSI with ${yesterdayForRSI.length} candles from yesterday. RSI available from first candle.`,
        );
      } else {
        // Fallback: Standard RSI calculation
        const closePrices = candles.map((c: any) => c.close);
        rsiValues = this.indicators.calculateRSI(closePrices, 14);
      }

      // MAIN SIGNAL DETECTION LOOP
      for (let i = 3; i < candles.length; i++) {
        const candle = candles[i];
        const candleIST = new Date(candle.date);
        const candleHours = candleIST.getHours();
        const candleMinutes = candleIST.getMinutes();

        // Time filter: 9:30 AM - 2:30 PM
        if (candleHours < 9 || (candleHours === 9 && candleMinutes < 30)) {
          continue;
        }
        if (candleHours > 14 || (candleHours === 14 && candleMinutes >= 30)) {
          break;
        }

        const candleEMA = emaValues[i] ?? 0;
        const prev1 = i >= 1 ? candles[i - 1] : null;
        const prev2 = i >= 2 ? candles[i - 2] : null;

        const actualCandleOpen = candle.open;
        const actualCandleClose = candle.close;
        const actualCandleHigh = candle.high;
        const actualCandleLow = candle.low;
        const actualCandleBody = Math.abs(actualCandleClose - actualCandleOpen);
        const actualTotalRange = actualCandleHigh - actualCandleLow;
        const actualLowerWick =
          Math.min(actualCandleOpen, actualCandleClose) - actualCandleLow;
        const actualUpperWick =
          actualCandleHigh - Math.max(actualCandleOpen, actualCandleClose);

        const actualIsGreenCandle = actualCandleClose > actualCandleOpen;

        // EMA trend filter
        const trendMarginPoints = 35;
        const isAboveEMA = actualCandleClose > candleEMA;
        const isFarBelowEMA = actualCandleClose < candleEMA - trendMarginPoints;

        if (!isAboveEMA && !isFarBelowEMA && candleEMA > 0) {
          continue;
        }

        // Support detection
        const marginPoints = 5;
        const nearEMA =
          Math.abs(actualCandleLow - candleEMA) <= marginPoints &&
          candleEMA > 0;
        const nearYesterdayLow =
          Math.abs(actualCandleLow - yesterdayLow) <= marginPoints &&
          yesterdayLow > 0;

        let signalDetected = false;
        let signalReason = '';
        const candleRSI = rsiValues[i];

        // Two separate buy signal scenarios:

        // Scenario 1: Oversold Green Candle (any green candle when RSI < 40)
        if (actualIsGreenCandle && candleRSI != null && candleRSI < 40) {
          signalDetected = true;
          signalReason = `Oversold Green Candle (RSI ${candleRSI.toFixed(1)})`;
          this.logger.debug(
            `🔍 Scenario 1: Oversold green candle at ${i} (${candleIST.toLocaleTimeString('en-IN')}) | RSI: ${candleRSI.toFixed(1)} < 40`,
          );
        }

        // Scenario 2: EMA Crossover (opens below EMA, closes above EMA, RSI < 60)
        else if (
          actualCandleOpen < candleEMA &&
          actualCandleClose > candleEMA &&
          candleEMA > 0 &&
          candleRSI != null &&
          candleRSI < 60
        ) {
          signalDetected = true;
          signalReason = `EMA Crossover (RSI ${candleRSI.toFixed(1)})`;
          this.logger.debug(
            `🔍 Scenario 2: EMA crossover at ${i} (${candleIST.toLocaleTimeString('en-IN')}) | Open: ${actualCandleOpen.toFixed(2)} < EMA: ${candleEMA.toFixed(2)} < Close: ${actualCandleClose.toFixed(2)} | RSI: ${candleRSI.toFixed(1)} < 60`,
          );
        }

        if (signalDetected) {
          const entryPrice = actualCandleClose;

          this.logger.debug(
            `✅ BUY SIGNAL: ${signalReason} at ${actualCandleClose.toFixed(2)}`,
          );

          const stopLoss = actualCandleLow - 7;
          const risk = entryPrice - stopLoss;
          const target = entryPrice + risk * 2;

          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

          const buySignal = {
            time: timestamp,
            type: 'BUY',
            price: entryPrice,
            stopLoss,
            target,
            text: `${signalReason} (RSI ${candleRSI != null ? candleRSI.toFixed(1) : 'N/A'})`,
          };

          chartData.signals.push(buySignal);

          this.logger.log(
            `✅ BUY SIGNAL (${signalReason}) | RSI: ${candleRSI != null ? candleRSI.toFixed(1) : 'N/A'} | Entry: ${entryPrice.toFixed(2)} | SL: ${stopLoss.toFixed(2)} | Target: ${target.toFixed(2)} | Time: ${timestamp}`,
          );
          this.logger.debug(`Signal object:`, JSON.stringify(buySignal));

          break; // Only one signal per chart
        }
      }
    } else if (strategy === 'SMART_SELL') {
      // SMART_SELL Strategy: Enhanced DAY_SELLING with RSI + Volume + Time filters
      // Fetch previous trading day data (wide window to handle holidays)
      const yesterdayHistorical = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHigh = 0;
      if (yesterdayHistorical && yesterdayHistorical.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        yesterdayHigh =
          yesterdayHistorical[yesterdayHistorical.length - 1].high;
        chartData.yesterdayHigh = yesterdayHigh;
        this.logger.debug(`Yesterday high = ${yesterdayHigh}`);
      }

      // Calculate 20 EMA with pre-seeding from previous trading days
      const yesterdaySmartSell = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      this.logger.debug(
        `SMART_SELL: Fetched ${yesterdaySmartSell?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      let smartSellEmaValues: (number | null)[];
      let smartSellClosePrices: number[];
      if (yesterdaySmartSell && yesterdaySmartSell.length > 0) {
        const yesterdaySeed = yesterdaySmartSell.slice(-25);
        const combinedClosePrices = [
          ...yesterdaySeed.map((c: any) => c.close),
          ...candles.map((c) => c.close),
        ];
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );
        smartSellEmaValues = combinedEMA.slice(yesterdaySeed.length);
        this.logger.debug(
          `SMART_SELL: Pre-seeded EMA with ${yesterdaySeed.length} yesterday candles.`,
        );
      } else {
        this.logger.warn(
          `SMART_SELL: No yesterday data, using standard EMA calculation`,
        );
        smartSellClosePrices = candles.map((c) => c.close);
        smartSellEmaValues = this.indicators.calculateEMA(
          smartSellClosePrices,
          20,
        );
      }
      const emaValues = smartSellEmaValues;
      const closePrices = candles.map((c) => c.close);

      // Build EMA data for chart
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValues[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return {
            time: timestamp,
            value: ema,
          };
        })
        .filter((e: any) => e !== null);

      // Calculate RSI (14-period)
      const rsiValues = this.indicators.calculateRSI(closePrices, 14);

      // Find swing highs (local peaks)
      const swingHighs: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const candle = candles[i];
        const prevCandles = candles.slice(i - 5, i);
        const nextCandles = candles.slice(i + 1, i + 6);

        const isLocalHigh =
          prevCandles.every((c) => c.high < candle.high) &&
          nextCandles.every((c) => c.high < candle.high);

        if (isLocalHigh) {
          swingHighs.push({ price: candle.high, index: i });
        }
      }

      this.logger.debug(`Found ${swingHighs.length} swing highs`);

      let lastSignalSL = 0;

      // === DAILY TRADING LIMITS ===
      let dailyTradesCount = 0;
      let dailyPnL = 0;
      let dailyStopTrading = false;
      const MAX_DAILY_TRADES = 2;
      const MAX_DAILY_LOSS = 35; // points

      // Scan for SELL signals (same patterns as DAY_SELLING but with filters)
      for (let i = 25; i < candles.length; i++) {
        // === CHECK DAILY LIMITS ===
        if (dailyStopTrading || dailyTradesCount >= MAX_DAILY_TRADES) {
          break; // Stop generating new signals for the day
        }

        const candle = candles[i];
        const candleOpen = candle.open;
        const candleHigh = candle.high;
        const candleLow = candle.low;
        const candleClose = candle.close;

        // ===== SMART_SELL FILTERS =====
        // Filter 1: Time window (10:30 AM - 2:30 PM)
        const candleDate =
          candle.date instanceof Date ? candle.date : new Date(candle.date);
        const candleHour = candleDate.getHours();
        const candleMinute = candleDate.getMinutes();
        const candleTimeInMinutes = candleHour * 60 + candleMinute;
        const timeFilterStart = 10 * 60 + 30; // 10:30 AM
        const timeFilterEnd = 14 * 60 + 30; // 2:30 PM

        if (
          candleTimeInMinutes < timeFilterStart ||
          candleTimeInMinutes > timeFilterEnd
        ) {
          continue; // Skip candles outside time window
        }

        // Filter 2: RSI > 60 (overbought)
        if (!rsiValues[i] || rsiValues[i]! <= 60) {
          continue;
        }

        // Filter 3: Volume confirmation
        const volumes = candles
          .slice(Math.max(0, i - 5), i)
          .map((c) => c.volume);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const volumeRatio = candle.volume / avgVolume;
        if (volumeRatio < 1.2) {
          continue; // Need at least 1.2x average volume
        }

        // Continue with pattern detection (same as DAY_SELLING)
        const candleBody = Math.abs(candleClose - candleOpen);
        const upperWick = candleHigh - Math.max(candleOpen, candleClose);
        const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
        const totalRange = candleHigh - candleLow;
        const isRedCandle = candleClose < candleOpen;
        const isGreenCandle = candleClose > candleOpen;

        const emaValue = emaValues[i];
        const prev1 = i > 0 ? candles[i - 1] : null;
        const prev2 = i > 1 ? candles[i - 2] : null;

        const entryPrice = candleClose;

        if (entryPrice <= lastSignalSL) {
          continue; // Skip if already signaled
        }

        const nearEMA =
          emaValue &&
          candleHigh >= emaValue * 0.995 && // widen: catch high touching EMA from below
          candleHigh <= emaValue * 1.015;
        const nearYesterdayHigh =
          yesterdayHigh > 0 &&
          candleHigh >= yesterdayHigh * 0.998 &&
          candleHigh <= yesterdayHigh * 1.01;

        let nearSwingHigh = false;
        for (const swingHigh of swingHighs) {
          if (
            candleHigh >= swingHigh.price * 0.998 &&
            candleHigh <= swingHigh.price * 1.01
          ) {
            nearSwingHigh = true;
            break;
          }
        }

        if (!nearEMA && !nearYesterdayHigh && !nearSwingHigh) {
          continue;
        }

        // Count pattern confirmations
        let confirmations = 0;
        const patterns: string[] = [];

        // Pattern 1: Weak close at resistance
        let resistanceTests = 0;
        for (let j = Math.max(0, i - 10); j < i; j++) {
          const testCandle = candles[j];
          if (
            (nearEMA && testCandle.high >= emaValue * 0.998) ||
            (nearYesterdayHigh && testCandle.high >= yesterdayHigh * 0.998) ||
            (nearSwingHigh &&
              swingHighs.some(
                (sh) =>
                  testCandle.high >= sh.price * 0.998 &&
                  testCandle.high <= sh.price * 1.01,
              ))
          ) {
            resistanceTests++;
          }
        }
        const weakCloseAtResistance =
          (isGreenCandle
            ? candleClose < candleOpen + candleBody * 0.5
            : true) && resistanceTests >= 2;
        if (weakCloseAtResistance) {
          confirmations++;
          patterns.push(`Weak Close (${resistanceTests} tests)`);
        }

        // Pattern 2: Early rejection
        const earlyRejection =
          (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
          upperWick > candleBody * 1.2 &&
          upperWick > totalRange * 0.4 &&
          candleClose < candleHigh * 0.99;
        if (earlyRejection) {
          confirmations++;
          patterns.push('Early Rejection');
        }

        // Pattern 3: Momentum slowing
        let momentumSlowing = false;
        if (prev2 && prev1) {
          const body2 = Math.abs(prev2.close - prev2.open);
          const body1 = Math.abs(prev1.close - prev1.open);
          momentumSlowing =
            candleBody < body1 && body1 < body2 && resistanceTests >= 2;
          if (momentumSlowing) {
            confirmations++;
            patterns.push('Momentum Slowing');
          }
        }

        // Pattern 4: Shooting star (red or green — green SS at EMA is valid with next red confirmation)
        const nextCandle = i + 1 < candles.length ? candles[i + 1] : null;
        const nextIsRed = nextCandle
          ? nextCandle.close < nextCandle.open
          : false;
        const isShootingStar =
          upperWick > candleBody * 2 &&
          lowerWick < candleBody * 0.5 &&
          upperWick > totalRange * 0.6 &&
          (isRedCandle || nextIsRed); // green SS valid only if followed by red confirmation
        if (isShootingStar) {
          confirmations++;
          patterns.push(isRedCandle ? 'Shooting Star' : 'Green Shooting Star');
        }

        // Pattern 5: Bearish engulfing
        const isBearishEngulfing =
          prev1 &&
          prev1.close > prev1.open &&
          candleOpen > prev1.close &&
          candleClose < prev1.open &&
          isRedCandle;
        if (isBearishEngulfing) {
          confirmations++;
          patterns.push('Bearish Engulfing');
        }

        // Pattern 6: Strong rejection
        const hasStrongRejection =
          isRedCandle &&
          upperWick > candleBody * 2 &&
          upperWick > totalRange * 0.5 &&
          candleClose < candleOpen * 0.98;
        if (hasStrongRejection) {
          confirmations++;
          patterns.push('Strong Rejection');
        }

        // Filter 4: Need at least 2 pattern confirmations
        if (confirmations < 2) {
          continue;
        }

        // Generate signal
        const stopLoss = candleHigh + 7;
        const risk = stopLoss - entryPrice;
        const target = entryPrice - risk * 2;
        const target1_3 = entryPrice - risk * 3;
        const target1_4 = entryPrice - risk * 4;

        const timestamp =
          candle.date instanceof Date
            ? Math.floor(candle.date.getTime() / 1000) + 19800
            : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

        const signalReason = `${patterns.slice(0, 2).join(' + ')} | RSI:${Math.round(rsiValues[i]!)} | Vol:${volumeRatio.toFixed(1)}x`;

        chartData.signals.push({
          time: timestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${signalReason} (SL: ${risk.toFixed(1)}pts)`,
        });

        lastSignalSL = stopLoss;
        dailyTradesCount++; // Increment daily trades count

        this.logger.debug(
          `SMART_SELL signal ${dailyTradesCount}: ${signalReason}, Entry: ${entryPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)}`,
        );

        // Look ahead to check if this trade hits SL or Target
        let tradeCompleted = false;
        for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
          const futureCandle = candles[j];

          // Check if SL hit (price goes above SL for SELL)
          if (futureCandle.high >= stopLoss) {
            const loss = stopLoss - entryPrice;
            dailyPnL -= loss;
            tradeCompleted = true;

            this.logger.debug(
              `Trade ${dailyTradesCount} SL HIT at ${stopLoss.toFixed(2)}, Loss: ${loss.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );

            // Check if max daily loss reached (30-35 points)
            if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
              dailyStopTrading = true;
              this.logger.log(
                `MAX DAILY LOSS REACHED: ${Math.abs(dailyPnL).toFixed(1)} pts. Stopping trading for the day.`,
              );
            }
            break;
          }

          // Check targets (highest to lowest for better profit)
          if (futureCandle.low <= target1_4) {
            const profit = entryPrice - target1_4;
            dailyPnL += profit;
            tradeCompleted = true;
            this.logger.debug(
              `Trade ${dailyTradesCount} TARGET 1:4 HIT at ${target1_4.toFixed(2)}, Profit: ${profit.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );
            dailyStopTrading = true; // Stop trading after hitting any target
            this.logger.log('TARGET HIT. Stopping trading for the day.');
            break;
          } else if (futureCandle.low <= target1_3) {
            const profit = entryPrice - target1_3;
            dailyPnL += profit;
            tradeCompleted = true;
            this.logger.debug(
              `Trade ${dailyTradesCount} TARGET 1:3 HIT at ${target1_3.toFixed(2)}, Profit: ${profit.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );
            dailyStopTrading = true; // Stop trading after hitting any target
            this.logger.log('TARGET HIT. Stopping trading for the day.');
            break;
          } else if (futureCandle.low <= target) {
            const profit = entryPrice - target;
            dailyPnL += profit;
            tradeCompleted = true;
            this.logger.debug(
              `Trade ${dailyTradesCount} TARGET 1:2 HIT at ${target.toFixed(2)}, Profit: ${profit.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );
            dailyStopTrading = true; // Stop trading after hitting any target
            this.logger.log('TARGET HIT. Stopping trading for the day.');
            break;
          }
        }

        // If daily stop triggered, break out of main loop
        if (dailyStopTrading) {
          break;
        }
      }
    } else if (strategy === 'TREND_NIFTY') {
      // TREND_NIFTY Chart: SELL signal at first candle >= 9:30 IST
      // SL = entry + SL_PTS, T1 (1:2) → breakeven, T2/T3 trail
      const SL_PTS = marginPoints > 0 ? marginPoints : 30;

      let signalCandle: any = null;
      let signalIndex = -1;
      for (let i = 0; i < candles.length; i++) {
        const t =
          candles[i].date instanceof Date
            ? candles[i].date
            : new Date(candles[i].date);
        const istMinutes =
          (t.getUTCHours() * 60 + t.getUTCMinutes() + 330) % 1440;
        const istHour = Math.floor(istMinutes / 60);
        const istMin = istMinutes % 60;
        if (istHour > 9 || (istHour === 9 && istMin >= 30)) {
          signalCandle = candles[i];
          signalIndex = i;
          break;
        }
      }

      if (signalCandle) {
        const entryPrice = signalCandle.close;
        const stopLoss = entryPrice + SL_PTS;
        const t1_2 = entryPrice - SL_PTS * 2;
        const ts =
          signalCandle.date instanceof Date
            ? Math.floor(signalCandle.date.getTime() / 1000) + 19800
            : Math.floor(new Date(signalCandle.date).getTime() / 1000) + 19800;

        chartData.signals.push({
          time: ts,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target: t1_2,
          text: `TREND NIFTY SELL \u2014 SL:+${SL_PTS}pts | T1:${SL_PTS * 2}pts | T2:${SL_PTS * 3}pts | T3:${SL_PTS * 4}pts`,
        });

        // Simulate SL / target management across remaining candles
        let activeSL = stopLoss;
        let t1Hit = false;
        let trailLow = entryPrice;
        for (let j = signalIndex + 1; j < candles.length; j++) {
          const fc = candles[j];
          if (fc.high >= activeSL) break; // SL hit
          if (fc.low <= entryPrice - SL_PTS * 4) break; // T3 exit
          if (fc.low <= entryPrice - SL_PTS * 3) break; // T2 exit
          if (!t1Hit && fc.low <= t1_2) {
            t1Hit = true;
            activeSL = entryPrice; // Move to breakeven
            trailLow = fc.low;
          }
          if (t1Hit && fc.low < trailLow) {
            trailLow = fc.low;
            activeSL = Math.min(activeSL, trailLow + 10); // Trail SL
          }
        }
      }
    }

    // Calculate trade statistics with detailed trade information
    let slHits = 0;
    let targetHits = 0;
    let totalProfit = 0;
    const detailedTrades: any[] = [];

    chartData.signals.forEach((signal: any, index: number) => {
      const signalIndex = candles.findIndex((c: any) => {
        const candleTimestamp =
          c.date instanceof Date
            ? Math.floor(c.date.getTime() / 1000) + 19800
            : Math.floor(new Date(c.date).getTime() / 1000) + 19800;
        return candleTimestamp === signal.time;
      });

      if (signalIndex === -1) return;

      const trade: any = {
        entryLogic: signal.text || 'Signal detected',
        entryPrice: signal.price,
        exitPrice: null,
        exitReason: 'OPEN',
        profitLoss: 0,
        entryTime: signal.time,
        exitTime: null,
      };

      // Check subsequent candles to see if SL or Target was hit
      for (let i = signalIndex + 1; i < candles.length; i++) {
        const candle = candles[i];
        const candleTimestamp =
          candle.date instanceof Date
            ? Math.floor(candle.date.getTime() / 1000) + 19800
            : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

        if (signal.type === 'BUY') {
          // Check if SL hit (price goes below SL)
          if (candle.low <= signal.stopLoss) {
            slHits++;
            const loss = signal.price - signal.stopLoss;
            totalProfit -= loss;
            trade.exitPrice = signal.stopLoss;
            trade.exitReason = 'SL_HIT';
            trade.profitLoss = -loss;
            trade.exitTime = candleTimestamp;
            break;
          }
          // Check if Target hit (price goes above Target)
          if (candle.high >= signal.target) {
            targetHits++;
            const profit = signal.target - signal.price;
            totalProfit += profit;
            trade.exitPrice = signal.target;
            trade.exitReason = 'TARGET_HIT';
            trade.profitLoss = profit;
            trade.exitTime = candleTimestamp;
            break;
          }
        } else {
          // SELL trade
          // Check if SL hit (price goes above SL)
          if (candle.high >= signal.stopLoss) {
            slHits++;
            const loss = signal.stopLoss - signal.price;
            totalProfit -= loss;
            trade.exitPrice = signal.stopLoss;
            trade.exitReason = 'SL_HIT';
            trade.profitLoss = -loss;
            trade.exitTime = candleTimestamp;
            break;
          }
          // Check if Target hit (price goes below Target)
          if (candle.low <= signal.target) {
            targetHits++;
            const profit = signal.price - signal.target;
            totalProfit += profit;
            trade.exitPrice = signal.target;
            trade.exitReason = 'TARGET_HIT';
            trade.profitLoss = profit;
            trade.exitTime = candleTimestamp;
            break;
          }
        }
      }

      detailedTrades.push(trade);
    });

    const openTrades = chartData.signals.length - slHits - targetHits;

    const buySignals = chartData.signals.filter(
      (s: any) => s.type === 'BUY',
    ).length;
    const sellSignals = chartData.signals.filter(
      (s: any) => s.type === 'SELL',
    ).length;

    chartData.statistics = {
      totalTrades: chartData.signals.length,
      slHits,
      targetHits,
      openTrades,
      totalProfitPerLot: Math.round(totalProfit * 100) / 100, // Round to 2 decimals
      trades: detailedTrades, // Detailed trade-by-trade information
    };

    this.logger.log(
      `Returning chart data: ${chartData.candles.length} candles, ${chartData.signals.length} signals (${buySignals} BUY, ${sellSignals} SELL), EMA points: ${chartData.ema.length}`,
    );
    this.logger.log(
      `Trade Statistics: Total=${chartData.statistics.totalTrades}, SL Hits=${chartData.statistics.slHits}, Target Hits=${chartData.statistics.targetHits}, Profit/Lot=${chartData.statistics.totalProfitPerLot}`,
    );

    // Debug log for signals
    if (chartData.signals.length > 0) {
      this.logger.debug(
        `📊 Signals in response: ${JSON.stringify(chartData.signals.map((s: any) => ({ type: s.type, time: s.time, text: s.text })))}`,
      );
    }

    return chartData;
  }

  /**
   * Returns the nearest NIFTY option expiry date on or after `dateStr` by
   * querying the Instrument DB table (updated daily from Kite instruments download).
   */
  private async getSimulationExpiry(dateStr: string): Promise<string> {
    const row = await this.prisma.instrument.findFirst({
      where: {
        tradingsymbol: { startsWith: 'NIFTY' },
        segment: { in: ['NFO-OPT', 'NFO'] },
        instrumentType: { in: ['CE', 'PE'] },
        expiry: { not: null, gte: dateStr },
      },
      select: { expiry: true },
      orderBy: { expiry: 'asc' },
    });

    if (!row?.expiry) {
      throw new Error(
        `[SIM] No NIFTY expiry found in Instrument DB for date ${dateStr}. ` +
          `Make sure instruments are downloaded and include contracts expiring on or after ${dateStr}.`,
      );
    }

    return row.expiry;
  }

  /**
   * TREND_NIFTY core — fetches NIFTY 50 15-min candles, runs
   * SuperTrend(10,2) + VWAP + CandleStructure (3/3 confluence required),
   * then returns the OTM CE or PE to sell with SL/target info.
   */
  private async executeTrendNiftyStrategy(
    kc: any,
    otmDistance: number,
    targetDate: string,
    allInstruments: KiteInstrument[],
    interval: string = '15minute',
  ): Promise<{ options: any[] }> {
    const todayStr = targetDate;
    const yesterday = new Date(targetDate);
    yesterday.setDate(yesterday.getDate() - 1);
    if (yesterday.getDay() === 0) yesterday.setDate(yesterday.getDate() - 2);
    else if (yesterday.getDay() === 6)
      yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const niftyIndex = allInstruments.find(
      (i) => i.segment === 'INDICES' && i.tradingsymbol === 'NIFTY 50',
    );
    if (!niftyIndex) {
      this.logger.error('[TREND_NIFTY] NIFTY 50 index instrument not found');
      return { options: [] };
    }

    try {
      const yesterdayCandles = await kc.getHistoricalData(
        niftyIndex.instrument_token,
        interval,
        `${yesterdayStr} 09:15:00`,
        `${yesterdayStr} 15:30:00`,
      );
      const todayCandles = await kc.getHistoricalData(
        niftyIndex.instrument_token,
        interval,
        `${todayStr} 09:15:00`,
        `${todayStr} 09:31:00`, // First candle of the day
      );

      if (!todayCandles || todayCandles.length === 0) {
        this.logger.warn(
          '[TREND_NIFTY] No 9:30 candle for NIFTY 50. Market may be closed.',
        );
        return { options: [] };
      }

      // Warm-up: last 20 candles from yesterday + today's first candle
      const warmup = (yesterdayCandles || []).slice(-20);
      const allCandles = [...warmup, ...todayCandles];
      const last = allCandles[allCandles.length - 1];
      const spotPrice: number = last.close;

      // === SuperTrend(10, 2) ===
      const stResults = this.indicators.calculateSuperTrend(allCandles, 10, 2);
      const lastST = stResults[stResults.length - 1];
      if (!lastST) {
        this.logger.warn(
          '[TREND_NIFTY] Not enough data for SuperTrend (need 11+ candles)',
        );
        return { options: [] };
      }
      const superTrendSignal: 'bullish' | 'bearish' =
        lastST.trend === 'up' ? 'bullish' : 'bearish';

      // === VWAP (today session only) ===
      const vwapValues = this.indicators.calculateVWAP(todayCandles);
      const lastVWAP = vwapValues[vwapValues.length - 1];
      const vwapSignal: 'bullish' | 'bearish' | 'neutral' =
        spotPrice > lastVWAP
          ? 'bullish'
          : spotPrice < lastVWAP
            ? 'bearish'
            : 'neutral';

      // === Candle Structure ===
      const structureSignal = this.indicators.detectCandleStructure(allCandles);

      this.logger.log(
        `[TREND_NIFTY] Spot=${spotPrice.toFixed(2)} VWAP=${lastVWAP.toFixed(2)} STLine=${lastST.superTrend.toFixed(2)} | ST=${superTrendSignal} | VWAP=${vwapSignal} | Structure=${structureSignal}`,
      );

      const trendInfo: any = {
        superTrend: superTrendSignal,
        vwap: vwapSignal,
        structure: structureSignal,
        confluence: false,
        spotPrice,
        vwapPrice: lastVWAP,
        superTrendLine: lastST.superTrend,
      };

      // === 3/3 Confluence ===
      const allBullish =
        superTrendSignal === 'bullish' &&
        vwapSignal === 'bullish' &&
        structureSignal === 'bullish';
      const allBearish =
        superTrendSignal === 'bearish' &&
        vwapSignal === 'bearish' &&
        structureSignal === 'bearish';

      if (!allBullish && !allBearish) {
        this.logger.log(`[TREND_NIFTY] No 3/3 confluence — no signal.`);
        return { options: [{ noTrade: true, trendInfo }] };
      }

      trendInfo.confluence = true;
      const trendDirection = allBullish ? 'bullish' : 'bearish';
      const optionType = allBullish ? 'PE' : 'CE';

      // === OTM strike ===
      const strikeInterval = 50;
      const atmStrike = Math.round(spotPrice / strikeInterval) * strikeInterval;
      const otmOffset =
        Math.round(otmDistance / strikeInterval) * strikeInterval;
      const otmStrike = allBullish
        ? atmStrike - otmOffset // PE: below spot
        : atmStrike + otmOffset; // CE: above spot

      // === Nearest weekly expiry ===
      const expiries = new Set<string>();
      allInstruments
        .filter((i) => {
          let name = i.name;
          if (name?.startsWith('"') && name?.endsWith('"'))
            name = name.slice(1, -1);
          return (
            name === 'NIFTY' &&
            i.exchange === 'NFO' &&
            (i.instrument_type === 'CE' || i.instrument_type === 'PE')
          );
        })
        .forEach((i) => {
          let exp = i.expiry as any;
          if (typeof exp === 'object' && exp !== null)
            exp = exp.toISOString().split('T')[0];
          if (exp >= todayStr) expiries.add(exp);
        });

      const nearestExpiry = Array.from(expiries).sort()[0];
      if (!nearestExpiry) {
        this.logger.warn(
          '[TREND_NIFTY] No future expiry found in instruments cache',
        );
        return { options: [] };
      }

      // === Find the option instrument ===
      const optionInst = allInstruments.find((i) => {
        let name = i.name;
        if (name?.startsWith('"') && name?.endsWith('"'))
          name = name.slice(1, -1);
        let exp = i.expiry as any;
        if (typeof exp === 'object' && exp !== null)
          exp = exp.toISOString().split('T')[0];
        return (
          name === 'NIFTY' &&
          i.exchange === 'NFO' &&
          i.instrument_type === optionType &&
          i.strike === otmStrike &&
          exp === nearestExpiry
        );
      });

      if (!optionInst) {
        this.logger.warn(
          `[TREND_NIFTY] Instrument not found: NIFTY ${otmStrike} ${optionType} exp=${nearestExpiry}`,
        );
        return { options: [] };
      }

      // === LTP ===
      let ltp = 0;
      try {
        const key = `NFO:${optionInst.tradingsymbol}`;
        const q = await kc.getQuote([key]);
        if (q && q[key]) ltp = q[key].last_price;
      } catch (e: any) {
        this.logger.warn(`[TREND_NIFTY] LTP fetch failed: ${e.message}`);
      }

      // === Risk Management ===
      const slPts = 30;
      const sl = ltp + slPts; // Hard SL
      const t1 = ltp - slPts * 2; // 1:2 → move SL to breakeven
      const t2 = ltp - slPts * 3; // 1:3 → trail tighter
      const t3 = ltp - slPts * 4; // 1:4 → best case

      const signal = {
        type: 'SELL',
        recommendation: 'SELL',
        price: ltp,
        stopLoss: sl,
        target: t1,
        target2: t2,
        target3: t3,
        breakeven: ltp,
        text: `${trendDirection.toUpperCase()} TREND — Sell ${optionInst.tradingsymbol} @ ₹${ltp}`,
        reason: `SuperTrend(10,2)=${superTrendSignal} | VWAP=${vwapSignal} | Structure=${structureSignal} | OTM=${otmDistance}pts | Exp=${nearestExpiry}`,
        trailingActive: false,
      };

      this.logger.log(
        `[TREND_NIFTY] SIGNAL: SELL ${optionInst.tradingsymbol} | Entry=${ltp} SL=${sl} T1=${t1} T2=${t2} T3=${t3}`,
      );

      return {
        options: [
          {
            symbol: 'NIFTY',
            strike: otmStrike,
            optionType,
            tradingsymbol: optionInst.tradingsymbol,
            instrumentToken: optionInst.instrument_token,
            signals: [signal],
            ltp,
            lotSize: optionInst.lot_size,
            candles: [],
            trendInfo: {
              ...trendInfo,
              trendDirection,
              otmStrike,
              nearestExpiry,
            },
          },
        ],
      };
    } catch (err: any) {
      this.logger.error(
        `[TREND_NIFTY] Unexpected error: ${err.message}`,
        err.stack,
      );
      return { options: [] };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Option Monitor: Find options using selected trading strategy.
   *
   * Strategies:
   * - PREV_DAY_HIGH_LOW: Find options near yesterday's high or low (IMPLEMENTED)
   * - 20_EMA: Find options based on 20 EMA rejection (TODO: To be implemented next)
   */
  async optionMonitor(
    brokerId: string,
    symbol: string,
    expiry: string,
    marginPoints: number,
    targetDate: string,
    interval:
      | 'day'
      | 'minute'
      | '3minute'
      | '5minute'
      | '10minute'
      | '15minute'
      | '30minute'
      | '60minute',
    specificTime: string,
    strategy:
      | 'PREV_DAY_HIGH_LOW'
      | '20_EMA'
      | 'DAY_SELLING'
      | 'DAY_SELLING_V2'
      | 'DAY_SELLING_V2_ENHANCED'
      | 'DAY_SELLING_V1V2'
      | 'DAY_SELLING_V3'
      | 'DAY_SELLING_V4'
      | 'DAY_BUYING'
      | 'SMART_SELL'
      | 'TREND_NIFTY'
      | 'DAY_HIGH_REJECTION' = 'PREV_DAY_HIGH_LOW',
    realtimeMode: boolean = false,
    instrumentSource: 'live' | 'db' = 'live',
    lockedInstruments?: any[],
  ): Promise<{ options: any[]; selectedInstruments?: any[] }> {
    try {
      const broker = await this.prisma.broker.findUnique({
        where: { id: brokerId },
      });

      if (!broker) {
        throw new Error('Broker not found. Please add a broker first.');
      }

      if (!broker.apiKey) {
        throw new Error('API key not configured for this broker.');
      }

      if (!broker.accessToken) {
        throw new Error(
          'Access token missing. Please reconnect your broker account.',
        );
      }

      const kc = new KiteConnect({ api_key: broker.apiKey });
      kc.setAccessToken(broker.accessToken);

      // ── TREND_NIFTY: dedicated early-return path ─────────────────────────
      if (strategy === 'TREND_NIFTY') {
        const instruments = await this.getInstruments();
        return this.executeTrendNiftyStrategy(
          kc,
          marginPoints,
          targetDate,
          instruments,
          interval,
        );
      }
      // ─────────────────────────────────────────────────────────────────────

      this.logger.log(
        `Option Monitor: Using strategy=${strategy} for ${symbol} expiry=${expiry}`,
      );

      // Get instruments for the symbol and expiry
      const instruments = await this.getInstruments();

      // ── SPOT MODE: run strategy directly on the index instrument (no options) ──
      if (symbol.endsWith('_SPOT')) {
        const baseSymbol = symbol.replace('_SPOT', '');
        const indexInst = instruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            ((baseSymbol === 'NIFTY' && i.tradingsymbol === 'NIFTY 50') ||
              (baseSymbol === 'BANKNIFTY' &&
                i.tradingsymbol === 'NIFTY BANK') ||
              (baseSymbol === 'FINNIFTY' && i.tradingsymbol === 'FINNIFTY') ||
              (baseSymbol === 'SENSEX' && i.tradingsymbol === 'SENSEX') ||
              (baseSymbol === 'MIDCPNIFTY' &&
                i.tradingsymbol === 'NIFTY MIDCAP SELECT')),
        );
        if (!indexInst) {
          this.logger.warn(
            `[SPOT] Could not find index instrument for ${baseSymbol}`,
          );
          return { options: [] };
        }

        const todayStr = new Date(targetDate).toISOString().split('T')[0];
        const todayFrom = `${todayStr} 09:15:00`;
        const todayTo = `${todayStr} 15:30:00`;
        const prevWindowStart = new Date(targetDate);
        prevWindowStart.setDate(prevWindowStart.getDate() - 7);
        const prevWindowFrom = `${prevWindowStart.toISOString().split('T')[0]} 09:15:00`;
        const prevWindowEnd = new Date(targetDate);
        prevWindowEnd.setDate(prevWindowEnd.getDate() - 1);
        const yesterdayTo = `${prevWindowEnd.toISOString().split('T')[0]} 15:30:00`;

        this.logger.log(
          `[SPOT] ${baseSymbol} token=${indexInst.instrument_token}, date=${todayStr}, interval=${interval}, strategy=${strategy}`,
        );

        // ── DAY_HIGH_REJECTION SPOT path — dedicated, clean, no mixing ──────
        if (strategy === 'DAY_HIGH_REJECTION') {
          if (interval === 'day') {
            this.logger.warn(
              `[DHR SPOT] Cannot use day interval for DAY_HIGH_REJECTION`,
            );
            return { options: [] };
          }

          const dhrSpotIntraday = await kc.getHistoricalData(
            indexInst.instrument_token,
            interval,
            todayFrom,
            todayTo,
          );

          if (!dhrSpotIntraday || dhrSpotIntraday.length < 5) {
            this.logger.warn(
              `[DHR SPOT] Not enough intraday candles (${dhrSpotIntraday?.length || 0})`,
            );
            return { options: [] };
          }

          const [dhrSpotTargetHour, dhrSpotTargetMin] = specificTime
            .split(':')
            .map(Number);
          const dhrSpotCandles = dhrSpotIntraday.filter((c: any) => {
            const d = new Date(c.date);
            return (
              d.getHours() < dhrSpotTargetHour ||
              (d.getHours() === dhrSpotTargetHour &&
                d.getMinutes() <= dhrSpotTargetMin)
            );
          });

          if (dhrSpotCandles.length < 2) return { options: [] };

          const dhrSpotPrevDay = await kc.getHistoricalData(
            indexInst.instrument_token,
            'day',
            prevWindowFrom,
            yesterdayTo,
          );
          const dhrSpotPrevDayHigh =
            dhrSpotPrevDay && dhrSpotPrevDay.length > 0
              ? dhrSpotPrevDay[dhrSpotPrevDay.length - 1].high
              : 0;

          const dhrSpotSignals = detectDHR(
            dhrSpotCandles,
            DEFAULT_DHR_CONFIG,
            {},
            dhrSpotPrevDayHigh,
            1,
            baseSymbol,
          );

          if (dhrSpotSignals.length === 0) return { options: [] };

          const dhrSpotLtp =
            dhrSpotCandles[dhrSpotCandles.length - 1].close || 0;
          const dhrSpotEodClose =
            dhrSpotCandles[dhrSpotCandles.length - 1].close ?? 0;

          const dhrSpotPaperSettings = await this.prisma.tradingSettings
            .findUnique({
              where: {
                userId_symbol: { userId: broker.userId, symbol: baseSymbol },
              },
            })
            .catch(() => null);
          const dhrSpotLotSizes: Record<string, number> = {
            NIFTY: 65,
            BANKNIFTY: 30,
            FINNIFTY: 65,
            SENSEX: 20,
            MIDCPNIFTY: 75,
          };
          const dhrSpotLotSize = dhrSpotLotSizes[baseSymbol] ?? 1;
          const dhrSpotPaperLots = dhrSpotPaperSettings?.paperLots ?? 1;
          const dhrSpotTotalQty = dhrSpotPaperLots * dhrSpotLotSize;
          const dhrSpotHalfQty = Math.floor(dhrSpotTotalQty / 2);
          const dhrSpotRemainingQty = dhrSpotTotalQty - dhrSpotHalfQty;

          const dhrSpotSellSignals: any[] = [];

          for (const sig of dhrSpotSignals) {
            const setupCandle = dhrSpotCandles[sig.setupCandleIndex];
            const candleDate = new Date(setupCandle.date);
            const candleTime = candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            const unixTs = Math.floor(candleDate.getTime() / 1000) + 19800;

            const entryPrice = sig.entryPrice;
            const stopLoss = sig.stopLoss;
            const risk = stopLoss - entryPrice;
            const target1 = entryPrice - risk * 2;
            const target2 = entryPrice - risk * 3;
            const target3 = entryPrice - risk * 4;
            const actualIdx =
              sig.confirmationCandleIndex ?? sig.setupCandleIndex;

            let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
            let t1HitIdx = -1;

            for (let j = actualIdx + 1; j < dhrSpotCandles.length; j++) {
              const fc = dhrSpotCandles[j];
              if (fc.high >= stopLoss) {
                outcome = 'SL';
                break;
              }
              if (fc.low <= target1) {
                t1HitIdx = j;
                break;
              }
            }

            if (t1HitIdx >= 0) {
              let phase2Done = false;
              for (let j = t1HitIdx + 1; j < dhrSpotCandles.length; j++) {
                const fc = dhrSpotCandles[j];
                if (fc.high >= entryPrice) {
                  outcome = 'BE';
                  phase2Done = true;
                  break;
                }
                if (fc.low <= target3) {
                  outcome = 'T3';
                  phase2Done = true;
                  break;
                } else if (fc.low <= target2) {
                  outcome = 'T2';
                  phase2Done = true;
                  break;
                }
              }
              if (!phase2Done) outcome = 'T1';
            }

            let pnl: number;
            if (outcome === 'SL') {
              pnl = (entryPrice - stopLoss) * dhrSpotTotalQty;
            } else if (t1HitIdx >= 0) {
              const t1Profit = (entryPrice - target1) * dhrSpotHalfQty;
              if (outcome === 'BE') pnl = t1Profit;
              else if (outcome === 'T2')
                pnl = t1Profit + (entryPrice - target2) * dhrSpotRemainingQty;
              else if (outcome === 'T3')
                pnl = t1Profit + (entryPrice - target3) * dhrSpotRemainingQty;
              else
                pnl =
                  t1Profit +
                  (entryPrice - dhrSpotEodClose) * dhrSpotRemainingQty;
            } else {
              pnl = (entryPrice - dhrSpotEodClose) * dhrSpotTotalQty;
            }

            diagLog('dhr', '[DHR-SPOT-SIGNAL]', {
              instrument: indexInst.tradingsymbol,
              subtype: sig.subtype,
              zoneRef: sig.zoneReference,
              zoneType: sig.zoneType,
              setupIdx: sig.setupCandleIndex,
              confirmIdx: sig.confirmationCandleIndex ?? null,
              entry: entryPrice,
              sl: stopLoss,
              risk: risk.toFixed(2),
              outcome,
              pnl: Math.round(pnl),
              log: sig.log,
            });
            dhrSpotSellSignals.push({
              time: candleTime,
              date: candleDate,
              timestamp: unixTs,
              recommendation: 'SELL',
              reason: `${sig.reason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}`,
              price: entryPrice,
              stopLoss,
              target1,
              target2,
              target3,
              patternName: sig.subtype,
              outcome,
              pnl: Math.round(pnl),
            });
          }

          return {
            options:
              dhrSpotSellSignals.length > 0
                ? [
                    {
                      symbol: baseSymbol,
                      strike: 0,
                      optionType: 'IDX',
                      tradingsymbol: indexInst.tradingsymbol,
                      instrumentToken: indexInst.instrument_token,
                      signals: dhrSpotSellSignals,
                      ltp: dhrSpotLtp,
                    },
                  ]
                : [],
          };
        }
        // ─────────────────────────────────────────────────────────────────────

        if (
          strategy === 'DAY_SELLING' ||
          strategy === 'DAY_SELLING_V2' ||
          strategy === 'DAY_SELLING_V2_ENHANCED' ||
          strategy === 'DAY_SELLING_V1V2' ||
          strategy === 'DAY_SELLING_V3' ||
          strategy === 'DAY_SELLING_V4'
        ) {
          const intradayData = await kc.getHistoricalData(
            indexInst.instrument_token,
            interval,
            todayFrom,
            todayTo,
          );
          if (!intradayData || intradayData.length < 20) {
            this.logger.warn(
              `[SPOT] Not enough intraday candles for ${baseSymbol}`,
            );
            return { options: [] };
          }

          const [targetHour, targetMin] = specificTime.split(':').map(Number);
          const candlesUpToTime = intradayData.filter((c: any) => {
            const d = new Date(c.date);
            return (
              d.getHours() < targetHour ||
              (d.getHours() === targetHour && d.getMinutes() <= targetMin)
            );
          });

          const prevDayData = await kc.getHistoricalData(
            indexInst.instrument_token,
            'day',
            prevWindowFrom,
            yesterdayTo,
          );
          const yesterdayHigh =
            prevDayData && prevDayData.length > 0
              ? prevDayData[prevDayData.length - 1].high
              : 0;
          const prevDayLow =
            prevDayData && prevDayData.length > 0
              ? prevDayData[prevDayData.length - 1].low
              : 0;
          const spotPrevDayClose =
            prevDayData && prevDayData.length > 0
              ? prevDayData[prevDayData.length - 1].close
              : 0;

          const prevIntradayData = await kc.getHistoricalData(
            indexInst.instrument_token,
            interval,
            prevWindowFrom,
            yesterdayTo,
          );

          // EMA pre-seeding (same pattern as per-option processing)
          let emaValues: (number | null)[];
          if (prevIntradayData && prevIntradayData.length >= 20) {
            const seed = prevIntradayData.slice(-25);
            const combined = [...seed, ...candlesUpToTime];
            emaValues = this.indicators
              .calculateEMA(
                combined.map((c: any) => c.close),
                20,
              )
              .slice(seed.length);
          } else {
            emaValues = this.indicators.calculateEMA(
              candlesUpToTime.map((c: any) => c.close),
              20,
            );
          }

          // RSI pre-seeding
          let rsiValues: (number | null)[];
          if (prevIntradayData && prevIntradayData.length >= 14) {
            const seed = prevIntradayData.slice(-30);
            const combined = [...seed, ...candlesUpToTime];
            rsiValues = this.indicators
              .calculateRSI(
                combined.map((c: any) => c.close),
                14,
              )
              .slice(seed.length);
          } else {
            rsiValues = this.indicators.calculateRSI(
              candlesUpToTime.map((c: any) => c.close),
              14,
            );
          }

          // Swing highs
          const swingHighs: Array<{ price: number; index: number }> = [];
          for (let i = 5; i < candlesUpToTime.length - 5; i++) {
            const c = candlesUpToTime[i];
            const prev = candlesUpToTime.slice(i - 5, i);
            const next = candlesUpToTime.slice(i + 1, i + 6);
            if (
              prev.every((p: any) => p.high < c.high) &&
              next.every((n: any) => n.high < c.high)
            ) {
              swingHighs.push({ price: c.high, index: i });
            }
          }

          const superTrendData = this.indicators.calculateSuperTrend(
            candlesUpToTime,
            10,
            2,
          );

          // 8 EMA (required for V4)
          let spotEma8Values: (number | null)[];
          if (prevIntradayData && prevIntradayData.length > 0) {
            const seed8 = prevIntradayData.slice(-15);
            const combined8 = [...seed8, ...candlesUpToTime];
            spotEma8Values = this.indicators
              .calculateEMA(
                combined8.map((c: any) => c.close),
                8,
              )
              .slice(seed8.length);
          } else {
            spotEma8Values = this.indicators.calculateEMA(
              candlesUpToTime.map((c: any) => c.close),
              8,
            );
          }

          // VWAP (today's candles only, no pre-seeding)
          const spotVwapValues = this.indicators.calculateVWAP(
            candlesUpToTime.map((c: any) => ({
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume ?? 0,
            })),
          );

          // P&L setup for spot path
          const spotLotSizes: Record<string, number> = {
            NIFTY: 65,
            BANKNIFTY: 30,
            FINNIFTY: 65,
            SENSEX: 20,
            MIDCPNIFTY: 75,
          };
          const spotLotSize = spotLotSizes[baseSymbol] ?? 1;
          const spotPaperSettings = await this.prisma.tradingSettings
            .findUnique({
              where: {
                userId_symbol: { userId: broker.userId, symbol: baseSymbol },
              },
            })
            .catch(() => null);
          const spotPaperLots = spotPaperSettings?.paperLots ?? 1;
          const spotMinSellRsi = spotPaperSettings?.minSellRsi ?? 45;
          const spotMaxSellRiskPts = spotPaperSettings?.maxSellRiskPts ?? 30;

          const daySellCandidates =
            strategy === 'DAY_SELLING_V4'
              ? this.detectDaySellSignalsV4({
                  candles: candlesUpToTime,
                  ema8Values: spotEma8Values,
                  ema20Values: emaValues,
                  vwapValues: spotVwapValues,
                  superTrendData,
                  marginPoints,
                  maxSellRiskPts: spotMaxSellRiskPts,
                  realtimeMode,
                  instrumentName: indexInst.tradingsymbol,
                })
              : strategy === 'DAY_SELLING_V2_ENHANCED'
                ? this.detectDaySellSignalsV2Enhanced({
                    candles: candlesUpToTime,
                    ema20Values: emaValues,
                    ema8Values: spotEma8Values,
                    rsiValues,
                    swingHighs,
                    yesterdayHigh,
                    prevDayLow,
                    prevDayClose: spotPrevDayClose,
                    marginPoints,
                    maxSellRiskPts: spotMaxSellRiskPts,
                    realtimeMode,
                    instrumentName: indexInst.tradingsymbol,
                    superTrendData,
                  })
                : strategy === 'DAY_SELLING_V3'
                  ? this.detectDaySellSignalsV3({
                      candles: candlesUpToTime,
                      emaValues,
                      rsiValues,
                      swingHighs,
                      yesterdayHigh,
                      prevDayLow,
                      prevDayClose: spotPrevDayClose,
                      marginPoints,
                      maxSellRiskPts: spotMaxSellRiskPts,
                      realtimeMode,
                      instrumentName: indexInst.tradingsymbol,
                      superTrendData,
                    })
                  : this.detectDaySellSignals({
                      candles: candlesUpToTime,
                      emaValues,
                      rsiValues,
                      swingHighs,
                      yesterdayHigh,
                      prevDayLow,
                      prevDayClose: spotPrevDayClose,
                      marginPoints,
                      minSellRsi: spotMinSellRsi,
                      maxSellRiskPts: spotMaxSellRiskPts,
                      realtimeMode,
                      instrumentName: indexInst.tradingsymbol,
                      superTrendData,
                    });
          const spotTotalQty = spotPaperLots * spotLotSize;
          const spotHalfQty = Math.floor(spotTotalQty / 2);
          const spotRemainingQty = spotTotalQty - spotHalfQty;
          const spotEodClose =
            candlesUpToTime[candlesUpToTime.length - 1]?.close ?? 0;

          const sellSignals: any[] = [];
          let activeTradeClosed = true;
          let consecutiveSLHits = 0; // Rule 2: stop after 2 back-to-back SL hits
          let dailyStopTrading = false; // Rule 2+3: halt flag
          for (const sig of daySellCandidates) {
            if (dailyStopTrading) break; // stop generating new signals for the day
            if (!activeTradeClosed) continue;
            const {
              actualCandleIndex,
              candleTime,
              candleDate,
              unixTimestamp,
              reason: signalReason,
              entryPrice,
              stopLoss,
              risk,
              candleRSI,
            } = sig;
            const target1 = entryPrice - risk * 2;
            const target2 = entryPrice - risk * 3;
            const target3 = entryPrice - risk * 4;
            const rsiText =
              candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

            // Phase 1: scan for SL hit or T1 hit
            let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
            activeTradeClosed = false;
            let t1HitIndex = -1;
            for (
              let j = actualCandleIndex + 1;
              j < candlesUpToTime.length;
              j++
            ) {
              const fc = candlesUpToTime[j];
              if (fc.high >= stopLoss) {
                outcome = 'SL';
                activeTradeClosed = true;
                break;
              }
              if (fc.low <= target1) {
                t1HitIndex = j;
                break;
              }
            }

            // Phase 2: T1 hit — track remaining 50% with BE-adjusted SL
            if (t1HitIndex >= 0) {
              let phase2Done = false;
              for (let j = t1HitIndex + 1; j < candlesUpToTime.length; j++) {
                const fc = candlesUpToTime[j];
                if (fc.high >= entryPrice) {
                  outcome = 'BE';
                  activeTradeClosed = true;
                  phase2Done = true;
                  break;
                }
                if (fc.low <= target3) {
                  outcome = 'T3';
                  activeTradeClosed = true;
                  phase2Done = true;
                  break;
                } else if (fc.low <= target2) {
                  outcome = 'T2';
                  activeTradeClosed = true;
                  phase2Done = true;
                  break;
                }
              }
              if (!phase2Done) {
                outcome = 'T1';
                activeTradeClosed = true;
              }
            }

            // P&L calculation (SELL: profit = entry - exit per unit)
            let pnl: number;
            if (outcome === 'SL') {
              pnl = (entryPrice - stopLoss) * spotTotalQty;
            } else if (t1HitIndex >= 0) {
              const t1Profit = (entryPrice - target1) * spotHalfQty;
              if (outcome === 'BE') {
                pnl = t1Profit; // remaining 50% exits at entry → 0 P&L
              } else if (outcome === 'T2') {
                pnl = t1Profit + (entryPrice - target2) * spotRemainingQty;
              } else if (outcome === 'T3') {
                pnl = t1Profit + (entryPrice - target3) * spotRemainingQty;
              } else {
                // T1: remaining 50% closed at EOD
                pnl = t1Profit + (entryPrice - spotEodClose) * spotRemainingQty;
              }
            } else {
              // OPEN: no T1 hit, full position closed at EOD
              pnl = (entryPrice - spotEodClose) * spotTotalQty;
            }

            // === DAILY STOP RULES ===
            // Rule 2: 2 consecutive SL hits → max daily loss reached (2 × 30 pts = 60 pts)
            // Rule 3: Target or BE hit → protect the gain, stop for the day
            if (outcome === 'SL') {
              consecutiveSLHits++;
              if (consecutiveSLHits >= 2) dailyStopTrading = true;
            } else if (outcome !== 'OPEN') {
              // T1 / T2 / T3 / BE — a profitable close → stop trading for the day
              consecutiveSLHits = 0;
              dailyStopTrading = true;
            }

            sellSignals.push({
              time: candleTime,
              date: candleDate,
              timestamp: unixTimestamp,
              recommendation: 'SELL',
              reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
              price: entryPrice,
              stopLoss,
              target1,
              target2,
              target3,
              patternName: signalReason,
              outcome,
              pnl: Math.round(pnl),
            });
          }

          const ltp = candlesUpToTime[candlesUpToTime.length - 1]?.close || 0;
          return {
            options:
              sellSignals.length > 0
                ? [
                    {
                      symbol: baseSymbol,
                      strike: 0,
                      optionType: 'IDX',
                      tradingsymbol: indexInst.tradingsymbol,
                      instrumentToken: indexInst.instrument_token,
                      signals: sellSignals,
                      ltp,
                    },
                  ]
                : [],
          };
        }

        // DAY_BUYING and other strategies on spot: not yet supported
        return { options: [] };
      }
      // ─────────────────────────────────────────────────────────────────────────

      // SENSEX trades on BFO (BSE), others on NFO (NSE)
      const exchange = symbol === 'SENSEX' ? 'BFO' : 'NFO';

      this.logger.log(
        `Filtering instruments: symbol=${symbol}, exchange=${exchange}, expiry=${expiry}`,
      );

      const optionInstruments = instruments.filter((inst) => {
        // Strip quotes from name field (e.g., "NIFTY" -> NIFTY)
        let instName = inst.name;
        if (instName && instName.startsWith('"') && instName.endsWith('"')) {
          instName = instName.slice(1, -1);
        }

        if (instName !== symbol) return false;
        if (inst.exchange !== exchange) return false;
        if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE')
          return false;

        // Handle expiry comparison - could be Date object or string
        let instExpiry = inst.expiry;
        if (typeof instExpiry === 'object' && instExpiry !== null) {
          instExpiry = (instExpiry as any).toISOString().split('T')[0];
        }

        return instExpiry === expiry;
      });

      this.logger.log(
        `Found ${optionInstruments.length} live API instruments for ${symbol} expiry ${expiry}`,
      );

      // ── Resolve option instruments: DB (historical) vs Live API ────────────
      let resolvedInstruments: typeof optionInstruments;

      const dbInstrumentSelect = {
        instrumentToken: true,
        exchangeToken: true,
        tradingsymbol: true,
        name: true,
        lastPrice: true,
        expiry: true,
        strike: true,
        tickSize: true,
        lotSize: true,
        instrumentType: true,
        segment: true,
        exchange: true,
      } as const;

      const mapDbRow = (r: {
        instrumentToken: number;
        exchangeToken: number;
        tradingsymbol: string;
        name: string | null;
        lastPrice: number;
        expiry: string | null;
        strike: number;
        tickSize: number;
        lotSize: number;
        instrumentType: string;
        segment: string;
        exchange: string;
      }) => ({
        instrument_token: r.instrumentToken,
        exchange_token: r.exchangeToken,
        tradingsymbol: r.tradingsymbol,
        name: r.name ?? symbol,
        last_price: r.lastPrice,
        expiry: r.expiry ?? expiry,
        strike: r.strike,
        tick_size: r.tickSize,
        lot_size: r.lotSize,
        instrument_type: r.instrumentType,
        segment: r.segment,
        exchange: r.exchange,
      });

      if (instrumentSource === 'db') {
        // ── HISTORICAL MODE: query Instrument DB directly ─────────────────
        // Expired contracts are no longer in Kite's live feed but persist in
        // our DB (daily sync inserts, never deletes old rows).
        this.logger.log(
          `[optionMonitor] DB mode — loading instruments from DB for ${symbol} expiry ${expiry}`,
        );
        const dbRows = await this.prisma.instrument.findMany({
          where: {
            tradingsymbol: { startsWith: symbol },
            exchange: exchange,
            instrumentType: { in: ['CE', 'PE'] },
            expiry: expiry,
          },
          select: dbInstrumentSelect,
        });
        this.logger.log(
          `[optionMonitor] DB found ${dbRows.length} instruments for ${symbol} expiry ${expiry}`,
        );
        if (dbRows.length === 0) {
          this.logger.warn(
            `[optionMonitor] No instruments in DB for ${symbol} expiry ${expiry}. ` +
              `Make sure instruments were downloaded for this date range.`,
          );
          return { options: [] };
        }
        resolvedInstruments = dbRows.map(mapDbRow);
        // Use DB-stored tokens directly — Kite historical data endpoint supports
        // expired option tokens, provided the token was captured before expiry.
      } else {
        // ── LIVE MODE: use fresh instruments from Kite API ────────────────
        resolvedInstruments = optionInstruments;
        if (optionInstruments.length === 0) {
          const availableExpiries = new Set<string>();
          instruments
            .filter((inst) => {
              let instName = inst.name;
              if (instName?.startsWith('"') && instName?.endsWith('"')) {
                instName = instName.slice(1, -1);
              }
              return (
                instName === symbol &&
                inst.exchange === exchange &&
                (inst.instrument_type === 'CE' || inst.instrument_type === 'PE')
              );
            })
            .forEach((inst) => {
              let instExpiry = inst.expiry;
              if (typeof instExpiry === 'object' && instExpiry !== null) {
                instExpiry = (instExpiry as any).toISOString().split('T')[0];
              }
              availableExpiries.add(instExpiry);
            });
          this.logger.warn(
            `[optionMonitor] No live instruments for ${symbol} expiry ${expiry}. ` +
              `Available expiries: ${Array.from(availableExpiries).sort().join(', ')}. ` +
              `Switch to Historical mode for past dates.`,
          );
          return { options: [] };
        }
      }

      // Get target date and previous trading day's dates
      const today = new Date(targetDate);
      const todayStr = today.toISOString().split('T')[0];

      // Calculate previous trading day (skip weekends)
      const yesterday = new Date(targetDate);
      let daysToSubtract = 1;
      yesterday.setDate(yesterday.getDate() - daysToSubtract);

      // If yesterday is Sunday (0), go back to Friday (subtract 2 more days = 3 total)
      // If yesterday is Saturday (6), go back to Friday (subtract 1 more day = 2 total)
      const yesterdayDay = yesterday.getDay();
      if (yesterdayDay === 0) {
        // Sunday - go back 2 more days to Friday
        yesterday.setDate(yesterday.getDate() - 2);
        this.logger.debug(
          `Target date is Monday, using Friday as previous trading day`,
        );
      } else if (yesterdayDay === 6) {
        // Saturday - go back 1 more day to Friday
        yesterday.setDate(yesterday.getDate() - 1);
        this.logger.debug(
          `Target date is Sunday, using Friday as previous trading day`,
        );
      }

      const yesterdayStr = yesterday.toISOString().split('T')[0];

      // Kite API requires yyyy-mm-dd hh:mm:ss format
      const todayFrom = `${todayStr} 09:15:00`;
      const todayTo = `${todayStr} 15:30:00`;
      const yesterdayFrom = `${yesterdayStr} 09:15:00`;
      const yesterdayTo = `${yesterdayStr} 15:30:00`;

      // Wide 7-day lookback window — same as getOptionChartData.
      // This is critical: if the calendar day before targetDate is a market holiday
      // (e.g. Holi on 2026-03-03 when targetDate = 2026-03-04), yesterdayFrom/To
      // returns zero candles.  The wide window lets Kite return the actual last
      // trading day within the range, so EMA pre-seeding and yesterdayHigh are
      // always correct regardless of holidays.
      const prevWindowStart = new Date(targetDate);
      prevWindowStart.setDate(prevWindowStart.getDate() - 7);
      const prevWindowFrom = `${prevWindowStart.toISOString().split('T')[0]} 09:15:00`;

      this.logger.log(
        `Comparing target date's (${todayStr}) high/low with previous trading day's (${yesterdayStr}) high/low. Interval: ${interval}, Time: ${specificTime}`,
      );

      // Get historical spot price for the target date (not live price)
      this.logger.log(
        `Fetching historical spot price for ${symbol} on ${todayStr}`,
      );
      let spotPrice = 0;
      try {
        // Find the index instrument for the symbol
        let indexInstrument = instruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            ((symbol === 'NIFTY' && i.tradingsymbol === 'NIFTY 50') ||
              (symbol === 'BANKNIFTY' && i.tradingsymbol === 'NIFTY BANK') ||
              (symbol === 'FINNIFTY' && i.tradingsymbol === 'FINNIFTY') ||
              (symbol === 'SENSEX' &&
                (i.tradingsymbol === 'SENSEX' || i.name.includes('SENSEX'))) ||
              (symbol === 'MIDCPNIFTY' &&
                (i.tradingsymbol === 'NIFTY MIDCAP SELECT' ||
                  i.tradingsymbol.includes('MIDCAP')))),
        );

        // Fallback: try to find by tradingsymbol match
        if (!indexInstrument) {
          indexInstrument = instruments.find(
            (i) =>
              (i.segment === 'INDICES' || i.exchange === 'NSE') &&
              i.tradingsymbol === symbol,
          );
        }

        if (indexInstrument) {
          this.logger.log(
            `Found index instrument: ${indexInstrument.tradingsymbol} (token: ${indexInstrument.instrument_token})`,
          );

          // Fetch historical data for the target date
          const indexHistorical = await kc.getHistoricalData(
            indexInstrument.instrument_token,
            'day',
            todayFrom,
            todayTo,
          );

          if (indexHistorical && indexHistorical.length > 0) {
            // Use close price from historical data
            spotPrice =
              indexHistorical[0].close || indexHistorical[0].high || 0;
            this.logger.log(
              `Historical spot price for ${symbol} on ${todayStr}: ${spotPrice}`,
            );
          } else {
            this.logger.warn(
              `No historical data for ${symbol} on ${todayStr}, trying live price as fallback`,
            );
            // Fallback to live price if no historical data (e.g., future date or holiday)
            // Use exact Kite index tradingsymbols, NOT the short symbol name
            const spotSymbol =
              symbol === 'SENSEX'
                ? 'BSE:SENSEX'
                : symbol === 'BANKNIFTY'
                  ? 'NSE:NIFTY BANK'
                  : symbol === 'FINNIFTY'
                    ? 'NSE:FINNIFTY'
                    : symbol === 'MIDCPNIFTY'
                      ? 'NSE:NIFTY MIDCAP SELECT'
                      : 'NSE:NIFTY 50'; // NIFTY — must NOT be 'NSE:NIFTY'
            const spotQuote = await kc.getQuote([spotSymbol]);
            if (spotQuote && spotQuote[spotSymbol]) {
              spotPrice = spotQuote[spotSymbol].last_price;
              this.logger.log(
                `Using live spot price for ${symbol} (${spotSymbol}): ${spotPrice}`,
              );
            }
          }
        } else {
          this.logger.warn(
            `Could not find index instrument for ${symbol}, using live price`,
          );
          const spotSymbol =
            symbol === 'SENSEX'
              ? 'BSE:SENSEX'
              : symbol === 'BANKNIFTY'
                ? 'NSE:NIFTY BANK'
                : symbol === 'FINNIFTY'
                  ? 'NSE:FINNIFTY'
                  : symbol === 'MIDCPNIFTY'
                    ? 'NSE:NIFTY MIDCAP SELECT'
                    : 'NSE:NIFTY 50';
          const spotQuote = await kc.getQuote([spotSymbol]);
          if (spotQuote && spotQuote[spotSymbol]) {
            spotPrice = spotQuote[spotSymbol].last_price;
            this.logger.log(
              `Using live spot price for ${symbol} (${spotSymbol}): ${spotPrice}`,
            );
          }
        }
      } catch (err) {
        this.logger.warn(
          `Could not fetch spot price for ${symbol}: ${err.message}`,
        );
      }

      // Last-resort: if all spot price fetches failed, derive ATM from the
      // midpoint of available DB option strikes.  This is a safe approximation
      // because Kite lists strikes symmetrically around ATM (equal number OTM
      // on each side), so the midpoint of min/max strike ≈ ATM.
      if (spotPrice === 0 && resolvedInstruments.length > 0) {
        const allStrikes = resolvedInstruments
          .map((i) => i.strike)
          .filter((s) => s > 0);
        if (allStrikes.length > 0) {
          const minS = Math.min(...allStrikes);
          const maxS = Math.max(...allStrikes);
          spotPrice = (minS + maxS) / 2;
          this.logger.warn(
            `[optionMonitor] Spot price fetch failed — deriving ATM from DB strike midpoint: (${minS}+${maxS})/2 = ${spotPrice}. ` +
              `Live API may be down or access token invalid.`,
          );
        }
      }

      // Select specific strikes based on strategy
      let limitedInstruments = [];

      if (spotPrice > 0) {
        // Determine strike interval (50 for NIFTY, 100 for BANKNIFTY/SENSEX)
        const strikeInterval =
          symbol === 'BANKNIFTY' || symbol === 'SENSEX' ? 100 : 50;

        // Round spot to nearest ATM strike
        const atmStrike =
          Math.round(spotPrice / strikeInterval) * strikeInterval;

        if (
          strategy === 'DAY_SELLING' ||
          strategy === 'DAY_SELLING_V2' ||
          strategy === 'DAY_SELLING_V2_ENHANCED' ||
          strategy === 'DAY_SELLING_V1V2' ||
          strategy === 'DAY_SELLING_V3' ||
          strategy === 'DAY_SELLING_V4' ||
          strategy === 'DAY_HIGH_REJECTION'
        ) {
          // For DAY_SELLING/V2/V2E/V1V2/V3/V4/DHR: Only 2 strikes - 1 OTM CE (below spot) and 1 OTM PE (above spot)
          const ceStrike = atmStrike - strikeInterval * 2; // 2 strikes below ATM (OTM CE)
          const peStrike = atmStrike + strikeInterval * 2; // 2 strikes above ATM (OTM PE)

          this.logger.log(
            `[DAY_SELLING] Spot: ${spotPrice}, ATM: ${atmStrike}, CE strike target: ${ceStrike}, PE strike target: ${peStrike}`,
          );

          // Helper: find exact match first; if not found, use nearest available strike.
          // This handles gaps in DB coverage when NIFTY has moved since last instrument sync.
          const nearestStrike = (type: 'CE' | 'PE', targetStrike: number) => {
            const pool = resolvedInstruments.filter(
              (i) => i.instrument_type === type,
            );
            if (pool.length === 0) return undefined;
            const exact = pool.find((i) => i.strike === targetStrike);
            if (exact) return exact;
            return pool.reduce((best, curr) =>
              Math.abs(curr.strike - targetStrike) <
              Math.abs(best.strike - targetStrike)
                ? curr
                : best,
            );
          };

          const ceOption = nearestStrike('CE', ceStrike);
          const peOption = nearestStrike('PE', peStrike);

          if (ceOption) {
            if (ceOption.strike !== ceStrike)
              this.logger.warn(
                `[DAY_SELLING] CE exact strike ${ceStrike} not in DB — using nearest available: ${ceOption.strike} (${ceOption.tradingsymbol}). Re-sync instruments for best accuracy.`,
              );
            limitedInstruments.push(ceOption);
          }
          if (peOption) {
            if (peOption.strike !== peStrike)
              this.logger.warn(
                `[DAY_SELLING] PE exact strike ${peStrike} not in DB — using nearest available: ${peOption.strike} (${peOption.tradingsymbol}). Re-sync instruments for best accuracy.`,
              );
            limitedInstruments.push(peOption);
          }

          this.logger.log(
            `[DAY_SELLING] Selected ${limitedInstruments.length} options: ${limitedInstruments.map((i) => i.tradingsymbol).join(', ')}`,
          );
        } else {
          // For other strategies: Select ATM and near-ATM strikes
          // For CE: Select ATM and 3 strikes below ATM (ATM to slightly ITM)
          // CE is ITM when strike < spot, so going below ATM gives ITM options
          const ceStrikes = [
            atmStrike, // ATM
            atmStrike - strikeInterval, // 1 strike ITM
            atmStrike - strikeInterval * 2, // 2 strikes ITM
            atmStrike - strikeInterval * 3, // 3 strikes ITM
          ];

          // For PE: Select ATM and 3 strikes above ATM (ATM to slightly ITM)
          // PE is ITM when strike > spot, so going above ATM gives ITM options
          const peStrikes = [
            atmStrike, // ATM
            atmStrike + strikeInterval, // 1 strike ITM
            atmStrike + strikeInterval * 2, // 2 strikes ITM
            atmStrike + strikeInterval * 3, // 3 strikes ITM
          ];

          this.logger.log(
            `Spot: ${spotPrice}, ATM: ${atmStrike}, CE strikes (ATM to ITM): ${ceStrikes.join(', ')}, PE strikes (ATM to ITM): ${peStrikes.join(', ')}`,
          );

          // Get 4 CE options (ATM and near-ATM/ITM)
          const ceOptions = ceStrikes
            .map((strike) => {
              return resolvedInstruments.find(
                (inst) =>
                  inst.strike === strike && inst.instrument_type === 'CE',
              );
            })
            .filter((inst) => inst !== undefined);

          // Get 4 PE options (ATM and near-ATM/ITM)
          const peOptions = peStrikes
            .map((strike) => {
              return resolvedInstruments.find(
                (inst) =>
                  inst.strike === strike && inst.instrument_type === 'PE',
              );
            })
            .filter((inst) => inst !== undefined);

          limitedInstruments = [...ceOptions, ...peOptions];

          this.logger.log(
            `Selected ${ceOptions.length} CE and ${peOptions.length} PE options (Total: ${limitedInstruments.length}, avoiding OTM/DITM)`,
          );
        }
      } else {
        // Fallback: if no spot price, just take first 8 (4 CE + 4 PE)
        const ceOptions = resolvedInstruments
          .filter((inst) => inst.instrument_type === 'CE')
          .slice(0, 4);
        const peOptions = resolvedInstruments
          .filter((inst) => inst.instrument_type === 'PE')
          .slice(0, 4);
        limitedInstruments = [...ceOptions, ...peOptions];
        this.logger.warn(
          `No spot price, using first 4 CE and 4 PE instruments`,
        );
      }

      // ── 2-hour strike lock: if caller supplies locked instruments, use them ──
      if (
        lockedInstruments &&
        lockedInstruments.length > 0 &&
        (strategy === 'DAY_SELLING' ||
          strategy === 'DAY_SELLING_V2' ||
          strategy === 'DAY_SELLING_V2_ENHANCED' ||
          strategy === 'DAY_SELLING_V1V2' ||
          strategy === 'DAY_SELLING_V3' ||
          strategy === 'DAY_SELLING_V4')
      ) {
        limitedInstruments = lockedInstruments;
        this.logger.log(
          `[DAY_SELLING] ♻️  Using cached 2-hr locked strikes: ${limitedInstruments.map((i) => i.tradingsymbol).join(', ')}`,
        );
      }

      // ── DB signal fallback (Trade Finder, non-realtime) ────────────────────
      // The scheduler's 2-hr in-memory lock expires, but signals saved to the
      // Signal DB persist. When Trade Finder is called after the lock expires
      // (or after a server restart), re-select based on current ATM would scan
      // a different strike and return 0 options. Instead, look up which
      // instruments were used today from the Signal DB and scan those same ones.
      if (
        !realtimeMode &&
        (strategy === 'DAY_SELLING' ||
          strategy === 'DAY_SELLING_V2' ||
          strategy === 'DAY_SELLING_V2_ENHANCED' ||
          strategy === 'DAY_SELLING_V1V2' ||
          strategy === 'DAY_SELLING_V3' ||
          strategy === 'DAY_SELLING_V4') &&
        (!lockedInstruments || lockedInstruments.length === 0)
      ) {
        const todaySignalStart = new Date(`${targetDate}T00:00:00.000Z`);
        const todaySignalEnd = new Date(`${targetDate}T23:59:59.999Z`);
        const savedSignals = await this.prisma.signal
          .findMany({
            where: {
              brokerId,
              strategy,
              signalDate: { gte: todaySignalStart, lte: todaySignalEnd },
            },
            distinct: ['instrumentToken'],
          })
          .catch(() => [] as any[]);

        if (savedSignals.length > 0) {
          const tokens = savedSignals.map((s: any) => s.instrumentToken);
          const dbRows = await this.prisma.instrument
            .findMany({
              where: { instrumentToken: { in: tokens } },
              select: dbInstrumentSelect,
            })
            .catch(() => [] as any[]);

          if (dbRows.length > 0) {
            limitedInstruments = dbRows.map(mapDbRow);
            this.logger.log(
              `[option-monitor] 📋 DB signal fallback (lock expired): using ${limitedInstruments.map((i: any) => i.tradingsymbol).join(', ')}`,
            );
          }
        }
      }

      // Fetch paper trade settings for P&L calculation (once, before batch)
      const paperTradeSettings = await this.prisma.tradingSettings
        .findUnique({
          where: { userId_symbol: { userId: broker.userId, symbol } },
        })
        .catch(() => null);
      const paperLots = paperTradeSettings?.paperLots ?? 1;
      const minSellRsi = paperTradeSettings?.minSellRsi ?? 45;
      const maxSellRiskPts = paperTradeSettings?.maxSellRiskPts ?? 30;

      const results: any[] = [];

      this.logger.log(
        `Starting to fetch data for ${limitedInstruments.length} instruments`,
      );

      // Fetch historical data for each option (simplified - no filtering yet)
      // Process in batches to avoid rate limits
      const batchSize = 5;
      for (let i = 0; i < limitedInstruments.length; i += batchSize) {
        const batch = limitedInstruments.slice(i, i + batchSize);

        this.logger.log(
          `Processing batch ${i / batchSize + 1}, instruments: ${batch.map((b) => b.tradingsymbol).join(', ')}`,
        );

        const batchPromises = batch.map(async (inst) => {
          try {
            // Clean symbol name by removing quotes
            let cleanSymbol = inst.name;
            if (
              cleanSymbol &&
              cleanSymbol.startsWith('"') &&
              cleanSymbol.endsWith('"')
            ) {
              cleanSymbol = cleanSymbol.slice(1, -1);
            }

            // ============ DAY_HIGH_REJECTION STRATEGY ============
            if (strategy === 'DAY_HIGH_REJECTION') {
              this.logger.debug(
                `[DHR] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_HIGH_REJECTION.`,
                );
                return null;
              }

              const dhrIntraday = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              if (!dhrIntraday || dhrIntraday.length < 5) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for DHR (${dhrIntraday?.length || 0})`,
                );
                return null;
              }

              // Fetch yesterday day candle for prevDayHigh
              const dhrYestDay = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                yesterdayFrom,
                yesterdayTo,
              );
              const dhrPrevDayHigh =
                dhrYestDay && dhrYestDay.length > 0 ? dhrYestDay[0].high : 0;

              const [dhrTargetHour, dhrTargetMin] = specificTime
                .split(':')
                .map(Number);
              const dhrCandles = dhrIntraday.filter((c) => {
                const d = new Date(c.date);
                return (
                  d.getHours() < dhrTargetHour ||
                  (d.getHours() === dhrTargetHour &&
                    d.getMinutes() <= dhrTargetMin)
                );
              });

              if (dhrCandles.length < 2) return null;

              const dhrSignals = detectDHR(
                dhrCandles,
                DEFAULT_DHR_CONFIG,
                {},
                dhrPrevDayHigh,
                1,
                inst.tradingsymbol,
              );

              if (dhrSignals.length === 0) return null;

              const dhrLtp = dhrCandles[dhrCandles.length - 1].close || 0;
              const dhrLotSize = inst.lot_size || 1;
              const dhrTotalQty = paperLots * dhrLotSize;
              const dhrHalfQty = Math.floor(dhrTotalQty / 2);
              const dhrRemainingQty = dhrTotalQty - dhrHalfQty;
              const dhrEodClose = dhrCandles[dhrCandles.length - 1].close ?? 0;

              const dhrSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              for (const sig of dhrSignals) {
                const setupCandle = dhrCandles[sig.setupCandleIndex];
                const candleDate = new Date(setupCandle.date);
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });
                const unixTs = Math.floor(candleDate.getTime() / 1000) + 19800;

                const entryPrice = sig.entryPrice;
                const stopLoss = sig.stopLoss;
                const risk = stopLoss - entryPrice;
                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;

                const actualIdx =
                  sig.confirmationCandleIndex ?? sig.setupCandleIndex;

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                let t1HitIdx = -1;

                for (let j = actualIdx + 1; j < dhrCandles.length; j++) {
                  const fc = dhrCandles[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (let j = t1HitIdx + 1; j < dhrCandles.length; j++) {
                    const fc = dhrCandles[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) outcome = 'T1';
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * dhrTotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * dhrHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * dhrRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * dhrRemainingQty;
                  } else {
                    pnl =
                      t1Profit + (entryPrice - dhrEodClose) * dhrRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - dhrEodClose) * dhrTotalQty;
                }

                diagLog('dhr', '[DHR-OPTIONS-SIGNAL]', {
                  instrument: inst.tradingsymbol,
                  subtype: sig.subtype,
                  zoneRef: sig.zoneReference,
                  zoneType: sig.zoneType,
                  setupIdx: sig.setupCandleIndex,
                  confirmIdx: sig.confirmationCandleIndex ?? null,
                  entry: entryPrice,
                  sl: stopLoss,
                  risk: risk.toFixed(2),
                  outcome,
                  pnl: Math.round(pnl),
                  log: sig.log,
                });
                dhrSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: unixTs,
                  recommendation: 'SELL',
                  reason: `${sig.reason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: sig.subtype,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (dhrSellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: dhrSellSignals,
                ltp: dhrLtp,
                lotSize: inst.lot_size,
                candles: dhrCandles,
              };
            }

            // ============ DAY_SELLING STRATEGY ============
            if (strategy === 'DAY_SELLING') {
              // DAY_SELLING: Look for SELL signals only (bearish patterns)
              // - 20 EMA rejection at resistance
              // - Yesterday's high rejection
              // - Swing high rejection
              // - Bearish candlestick patterns
              // - Max loss: 30 points, Targets: 60, 90, 120 points (1:2, 1:3, 1:4)

              this.logger.debug(
                `[DAY_SELLING] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING. Use intraday intervals.`,
                );
                return null;
              }

              // Fetch today's intraday candles
              const intradayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              this.logger.debug(
                `[DAY_SELLING] ${inst.tradingsymbol}: Fetched ${intradayHistorical?.length || 0} candles from ${todayFrom} to ${todayTo}`,
              );

              if (!intradayHistorical || intradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}), need at least 20`,
                );
                return null;
              }

              // Fetch yesterday's day data for high level
              // Use wide 7-day window (prevWindowFrom) — handles market holidays
              // (e.g. if yesterday is Holi, yesterdayFrom returns 0 candles)
              const yesterdayDayData = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                prevWindowFrom,
                yesterdayTo,
              );

              let yesterdayHigh = 0;
              let prevDayLow = 0;
              let perOptPrevDayClose = 0;
              if (yesterdayDayData && yesterdayDayData.length > 0) {
                // Use LAST entry — most recent trading day (handles multi-day window for holidays)
                yesterdayHigh =
                  yesterdayDayData[yesterdayDayData.length - 1].high;
                prevDayLow = yesterdayDayData[yesterdayDayData.length - 1].low;
                perOptPrevDayClose =
                  yesterdayDayData[yesterdayDayData.length - 1].close;
                this.logger.debug(
                  `${inst.tradingsymbol}: Yesterday high = ${yesterdayHigh}, prev day low = ${prevDayLow}, prev day close = ${perOptPrevDayClose}`,
                );
              }

              // Fetch yesterday's intraday data to pre-seed EMA/RSI/SuperTrend
              // Use wide 7-day window — handles market holidays (same as chart path)
              const yesterdayIntradayData = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                prevWindowFrom,
                yesterdayTo,
              );

              this.logger.debug(
                `${inst.tradingsymbol}: Fetched ${yesterdayIntradayData?.length || 0} candles from prev window (${prevWindowFrom} → ${yesterdayTo})`,
              );

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((candle) => {
                const candleDate = new Date(candle.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              if (candlesUpToTime.length < 1) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime}`,
                );
                return null;
              }

              // Calculate 20 EMA with pre-seeding from yesterday's data
              let emaValues: (number | null)[];

              if (yesterdayIntradayData && yesterdayIntradayData.length >= 20) {
                // Pre-seed EMA: Combine yesterday's last 25 candles + today's candles
                const yesterdayLast25 = yesterdayIntradayData.slice(-25);
                const combinedCandles = [
                  ...yesterdayLast25,
                  ...candlesUpToTime,
                ];
                const combinedClosePrices = combinedCandles.map((c) => c.close);

                // Calculate EMA on combined data
                const combinedEMA = this.indicators.calculateEMA(
                  combinedClosePrices,
                  20,
                );

                // Extract only today's EMA values (skip yesterday's candles)
                emaValues = combinedEMA.slice(yesterdayLast25.length);

                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday. EMA available from first candle.`,
                );
              } else {
                // Fallback: Standard EMA calculation if no yesterday data
                this.logger.warn(
                  `${inst.tradingsymbol}: No sufficient yesterday data for EMA pre-seeding, using standard calculation`,
                );
                const closePrices = candlesUpToTime.map((c) => c.close);
                emaValues = this.indicators.calculateEMA(closePrices, 20);
              }

              // Calculate RSI (for display only, doesn't affect signal generation)
              // Pre-seed RSI with yesterday's data for better accuracy
              let rsiValues: (number | null)[];

              if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
                // Pre-seed RSI: Combine yesterday's candles + today's candles
                const yesterdayForRSI = yesterdayIntradayData.slice(-30); // Use more data for RSI smoothing
                const combinedCandles = [
                  ...yesterdayForRSI,
                  ...candlesUpToTime,
                ];
                const combinedClosePrices = combinedCandles.map((c) => c.close);

                // Calculate RSI on combined data
                const combinedRSI = this.indicators.calculateRSI(
                  combinedClosePrices,
                  14,
                );

                // Extract only today's RSI values (skip yesterday's candles)
                rsiValues = combinedRSI.slice(yesterdayForRSI.length);

                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded RSI with ${yesterdayForRSI.length} candles from yesterday. RSI available from first candle.`,
                );
              } else {
                // Fallback: Standard RSI calculation if no yesterday data
                this.logger.debug(
                  `${inst.tradingsymbol}: No sufficient yesterday data for RSI pre-seeding, using standard calculation`,
                );
                const closePrices = candlesUpToTime.map((c) => c.close);
                rsiValues = this.indicators.calculateRSI(closePrices, 14);
              }

              // ── SuperTrend multi-timeframe filter setup ───────────────────────────────
              // SuperTrend(7,3) on primary interval candles (pre-seeded with yesterday)
              let stValues1min: Array<{
                superTrend: number;
                trend: 'up' | 'down';
              } | null> = [];
              {
                const stSeedOffset =
                  yesterdayIntradayData && yesterdayIntradayData.length >= 10
                    ? Math.min(20, yesterdayIntradayData.length)
                    : 0;
                const stSeedCandles =
                  stSeedOffset > 0
                    ? [
                        ...yesterdayIntradayData.slice(-stSeedOffset),
                        ...candlesUpToTime,
                      ]
                    : candlesUpToTime;
                const fullST1 = this.indicators.calculateSuperTrend(
                  stSeedCandles,
                  10,
                  4,
                );
                stValues1min =
                  stSeedOffset > 0 ? fullST1.slice(stSeedOffset) : fullST1;
              }

              // 5min double-check only when primary interval is 1min
              const need5minSTCheck = interval === 'minute';
              let intraday5min: any[] = [];
              let ema5min: (number | null)[] = [];
              let st5minValues: Array<{
                superTrend: number;
                trend: 'up' | 'down';
              } | null> = [];
              if (need5minSTCheck) {
                try {
                  const [hist5min, yest5min] = await Promise.all([
                    kc.getHistoricalData(
                      inst.instrument_token,
                      '5minute',
                      todayFrom,
                      todayTo,
                    ),
                    kc.getHistoricalData(
                      inst.instrument_token,
                      '5minute',
                      yesterdayFrom,
                      yesterdayTo,
                    ),
                  ]);
                  if (hist5min && hist5min.length >= 3) {
                    intraday5min = hist5min;
                    const seed5Offset =
                      yest5min && yest5min.length >= 10
                        ? Math.min(20, yest5min.length)
                        : 0;
                    const seed5 =
                      seed5Offset > 0
                        ? [...yest5min.slice(-seed5Offset), ...hist5min]
                        : hist5min;
                    ema5min = this.indicators
                      .calculateEMA(
                        seed5.map((c) => c.close),
                        20,
                      )
                      .slice(seed5Offset);
                    st5minValues = this.indicators
                      .calculateSuperTrend(seed5, 10, 4)
                      .slice(seed5Offset);
                    this.logger.debug(
                      `${inst.tradingsymbol}: Fetched ${hist5min.length} × 5min candles for ST filter`,
                    );
                  }
                } catch (e: any) {
                  this.logger.warn(
                    `${inst.tradingsymbol}: Failed to fetch 5min data for ST filter — ${e.message}`,
                  );
                }
              }

              // Find swing highs (local peaks in the session)
              const swingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < candlesUpToTime.length - 5; i++) {
                const candle = candlesUpToTime[i];
                const prevCandles = candlesUpToTime.slice(i - 5, i);
                const nextCandles = candlesUpToTime.slice(i + 1, i + 6);

                const isLocalHigh =
                  prevCandles.every((c) => c.high < candle.high) &&
                  nextCandles.every((c) => c.high < candle.high);

                if (isLocalHigh) {
                  swingHighs.push({ price: candle.high, index: i });
                }
              }

              this.logger.debug(
                `${inst.tradingsymbol}: Found ${swingHighs.length} swing highs`,
              );

              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const ltp = lastCandle.close || 0;
              const eodClose = lastCandle.close ?? 0;

              // Per-instrument P&L quantities (paperLots from outer scope, lotSize from instrument)
              const instLotSize = inst.lot_size || 1;
              const instTotalQty = paperLots * instLotSize;
              const instHalfQty = Math.floor(instTotalQty / 2);
              const instRemainingQty = instTotalQty - instHalfQty;

              // Check ALL candles for SELL signals using shared engine
              const sellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              const superTrendData = this.indicators.calculateSuperTrend(
                candlesUpToTime,
                10,
                2,
              );
              const daySellCandidates = this.detectDaySellSignals({
                candles: candlesUpToTime,
                emaValues,
                rsiValues,
                swingHighs,
                yesterdayHigh,
                prevDayLow,
                prevDayClose: perOptPrevDayClose,
                marginPoints,
                minSellRsi,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData,
              });

              let activeTradeClosed = true;
              let consecutiveSLHits = 0; // Rule 2: stop after 2 back-to-back SL hits
              let dailyStopTrading = false; // Rule 2+3: halt flag
              for (const sig of daySellCandidates) {
                // One trade at a time: skip if previous trade is still open
                if (dailyStopTrading) break; // stop generating new signals for the day
                if (!activeTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: candleTimestamp,
                  reason: signalReason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                // No extra ST/RSI filtering here — detectDaySellSignals already applies
                // all quality gates (EMA filter, resistance check, pattern validation, risk cap).
                // Adding extra filters only here (not in getOptionChartData) causes listing vs
                // chart inconsistency. Both paths now use identical signal criteria.

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                // Phase 1: scan for SL hit or T1 hit
                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                activeTradeClosed = false;
                let t1HitIndex = -1;
                for (
                  let j = actualCandleIndex + 1;
                  j < candlesUpToTime.length;
                  j++
                ) {
                  const fc = candlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    activeTradeClosed = true;
                    this.logger.debug(
                      `${inst.tradingsymbol}: SL HIT at ${stopLoss.toFixed(2)}.`,
                    );
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIndex = j;
                    this.logger.debug(
                      `${inst.tradingsymbol}: T1 HIT at ${target1.toFixed(2)}, entering phase 2.`,
                    );
                    break;
                  }
                }

                // Phase 2: T1 hit — track remaining 50% with BE-adjusted SL
                if (t1HitIndex >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIndex + 1;
                    j < candlesUpToTime.length;
                    j++
                  ) {
                    const fc = candlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      activeTradeClosed = true;
                      phase2Done = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: BREAK EVEN triggered, remaining 50% exits at ${entryPrice.toFixed(2)}.`,
                      );
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      activeTradeClosed = true;
                      phase2Done = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: TARGET 1:4 HIT at ${target3.toFixed(2)}.`,
                      );
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      activeTradeClosed = true;
                      phase2Done = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: TARGET 1:3 HIT at ${target2.toFixed(2)}.`,
                      );
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    activeTradeClosed = true;
                    this.logger.debug(
                      `${inst.tradingsymbol}: T1 outcome — market closed before T2/BE, remaining 50% at EOD.`,
                    );
                  }
                }

                // P&L calculation (SELL: profit = entry - exit per unit)
                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * instTotalQty;
                } else if (t1HitIndex >= 0) {
                  const t1Profit = (entryPrice - target1) * instHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit; // remaining 50% exits at entry → 0
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * instRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * instRemainingQty;
                  } else {
                    // T1: remaining 50% closed at EOD
                    pnl = t1Profit + (entryPrice - eodClose) * instRemainingQty;
                  }
                } else {
                  // OPEN: no T1 hit, full position closed at EOD
                  pnl = (entryPrice - eodClose) * instTotalQty;
                }

                // === DAILY STOP RULES ===
                // Rule 2: 2 consecutive SL hits → max daily loss reached (2 × 30 pts = 60 pts)
                // Rule 3: Target or BE hit → protect the gain, stop for the day
                if (outcome === 'SL') {
                  consecutiveSLHits++;
                  if (consecutiveSLHits >= 2) dailyStopTrading = true;
                } else if (outcome !== 'OPEN') {
                  // T1 / T2 / T3 / BE — a profitable close → stop trading for the day
                  consecutiveSLHits = 0;
                  dailyStopTrading = true;
                }

                sellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: candleTimestamp,
                  recommendation: 'SELL',
                  reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: signalReason,
                  outcome,
                  pnl: Math.round(pnl),
                });

                this.logger.debug(
                  `${inst.tradingsymbol}: SELL signal at ${candleTime}, Reason: ${signalReason}, Entry: ${entryPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)} (Risk: ${risk.toFixed(1)}pts), T1: ${target1.toFixed(2)}, Outcome: ${outcome}`,
                );

                if (!activeTradeClosed) {
                  this.logger.debug(
                    `${inst.tradingsymbol}: Trade still OPEN at end of day.`,
                  );
                }
              }
              if (sellSignals.length === 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: No SELL signals found`,
                );
                return null;
              }

              this.logger.log(
                `${inst.tradingsymbol}: ✓ Found ${sellSignals.length} SELL signal(s)`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: sellSignals,
                ltp: ltp,
                lotSize: inst.lot_size,
                candles: candlesUpToTime, // Include candles for historical trade closure
              };
            }

            // ============ DAY_SELLING_V2 STRATEGY ============
            if (strategy === 'DAY_SELLING_V2') {
              this.logger.debug(
                `[DAY_SELLING_V2] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V2.`,
                );
                return null;
              }

              const intradayHistoricalV2 = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              if (!intradayHistoricalV2 || intradayHistoricalV2.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V2 (${intradayHistoricalV2?.length || 0})`,
                );
                return null;
              }

              const yesterday2DayData = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                prevWindowFrom,
                yesterdayTo,
              );

              let v2YestHigh = 0;
              let v2PrevDayLow = 0;
              let v2PrevDayClose = 0;
              if (yesterday2DayData && yesterday2DayData.length > 0) {
                v2YestHigh =
                  yesterday2DayData[yesterday2DayData.length - 1].high;
                v2PrevDayLow =
                  yesterday2DayData[yesterday2DayData.length - 1].low;
                v2PrevDayClose =
                  yesterday2DayData[yesterday2DayData.length - 1].close;
              }

              const yesterday2IntradayData = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                prevWindowFrom,
                yesterdayTo,
              );

              const [v2TargetHour, v2TargetMin] = specificTime
                .split(':')
                .map(Number);
              const v2CandlesUpToTime = intradayHistoricalV2.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v2TargetHour ||
                    (d.getHours() === v2TargetHour &&
                      d.getMinutes() <= v2TargetMin)
                  );
                },
              );

              if (v2CandlesUpToTime.length < 1) return null;

              // EMA pre-seeding
              let v2EmaValues: (number | null)[];
              if (
                yesterday2IntradayData &&
                yesterday2IntradayData.length >= 20
              ) {
                const seed = yesterday2IntradayData.slice(-25);
                const combined = [...seed, ...v2CandlesUpToTime];
                v2EmaValues = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v2EmaValues = this.indicators.calculateEMA(
                  v2CandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // RSI pre-seeding
              let v2RsiValues: (number | null)[];
              if (
                yesterday2IntradayData &&
                yesterday2IntradayData.length >= 14
              ) {
                const seed = yesterday2IntradayData.slice(-30);
                const combined = [...seed, ...v2CandlesUpToTime];
                v2RsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                v2RsiValues = this.indicators.calculateRSI(
                  v2CandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const v2SwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < v2CandlesUpToTime.length - 5; i++) {
                const c = v2CandlesUpToTime[i];
                const prev5 = v2CandlesUpToTime.slice(i - 5, i);
                const next5 = v2CandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  v2SwingHighs.push({ price: c.high, index: i });
                }
              }

              const v2SuperTrend = this.indicators.calculateSuperTrend(
                v2CandlesUpToTime,
                10,
                2,
              );

              const v2LastCandle =
                v2CandlesUpToTime[v2CandlesUpToTime.length - 1];
              const v2Ltp = v2LastCandle.close || 0;
              const v2EodClose = v2LastCandle.close ?? 0;
              const v2LotSize = inst.lot_size || 1;
              const v2TotalQty = paperLots * v2LotSize;
              const v2HalfQty = Math.floor(v2TotalQty / 2);
              const v2RemainingQty = v2TotalQty - v2HalfQty;

              const v2SignalCandidates = this.detectDaySellSignalsV2({
                candles: v2CandlesUpToTime,
                emaValues: v2EmaValues,
                rsiValues: v2RsiValues,
                swingHighs: v2SwingHighs,
                yesterdayHigh: v2YestHigh,
                prevDayLow: v2PrevDayLow,
                prevDayClose: v2PrevDayClose,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: v2SuperTrend,
              });

              const v2SellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v2ActiveTradeClosed = true;
              let v2ConsecSL = 0;
              let v2DailyStop = false;

              for (const sig of v2SignalCandidates) {
                if (v2DailyStop) break;
                if (!v2ActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v2Ts,
                  reason: v2Reason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v2ActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v2CandlesUpToTime.length;
                  j++
                ) {
                  const fc = v2CandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v2ActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v2CandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v2CandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v2ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v2ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v2ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v2ActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v2TotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v2HalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v2RemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v2RemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - v2EodClose) * v2RemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v2EodClose) * v2TotalQty;
                }

                if (outcome === 'SL') {
                  v2ConsecSL++;
                  if (v2ConsecSL >= 2) v2DailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v2ConsecSL = 0;
                  v2DailyStop = true;
                }

                v2SellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v2Ts,
                  recommendation: 'SELL',
                  reason: `${v2Reason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v2Reason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v2SellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v2SellSignals,
                ltp: v2Ltp,
                lotSize: inst.lot_size,
                candles: v2CandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V2_ENHANCED STRATEGY ============
            if (strategy === 'DAY_SELLING_V2_ENHANCED') {
              this.logger.debug(
                `[DAY_SELLING_V2_ENHANCED] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V2_ENHANCED.`,
                );
                return null;
              }

              const v2eIntradayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              if (!v2eIntradayHistorical || v2eIntradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V2E (${v2eIntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const v2eDayData = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                prevWindowFrom,
                yesterdayTo,
              );

              let v2eYestHigh = 0;
              let v2ePrevDayLow = 0;
              let v2ePrevDayClose = 0;
              if (v2eDayData && v2eDayData.length > 0) {
                v2eYestHigh = v2eDayData[v2eDayData.length - 1].high;
                v2ePrevDayLow = v2eDayData[v2eDayData.length - 1].low;
                v2ePrevDayClose = v2eDayData[v2eDayData.length - 1].close;
              }

              const v2eYestIntradayData = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                prevWindowFrom,
                yesterdayTo,
              );

              const [v2eTargetHour, v2eTargetMin] = specificTime
                .split(':')
                .map(Number);
              const v2eCandlesUpToTime = v2eIntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v2eTargetHour ||
                    (d.getHours() === v2eTargetHour &&
                      d.getMinutes() <= v2eTargetMin)
                  );
                },
              );

              if (v2eCandlesUpToTime.length < 1) return null;

              // 20 EMA pre-seeding
              let v2eEma20Values: (number | null)[];
              if (v2eYestIntradayData && v2eYestIntradayData.length >= 20) {
                const seed = v2eYestIntradayData.slice(-25);
                const combined = [...seed, ...v2eCandlesUpToTime];
                v2eEma20Values = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v2eEma20Values = this.indicators.calculateEMA(
                  v2eCandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // 8 EMA pre-seeding
              let v2eEma8Values: (number | null)[];
              if (v2eYestIntradayData && v2eYestIntradayData.length > 0) {
                const seed8 = v2eYestIntradayData.slice(-15);
                const combined8 = [...seed8, ...v2eCandlesUpToTime];
                v2eEma8Values = this.indicators
                  .calculateEMA(
                    combined8.map((c) => c.close),
                    8,
                  )
                  .slice(seed8.length);
              } else {
                v2eEma8Values = this.indicators.calculateEMA(
                  v2eCandlesUpToTime.map((c) => c.close),
                  8,
                );
              }

              // RSI pre-seeding
              let v2eRsiValues: (number | null)[];
              if (v2eYestIntradayData && v2eYestIntradayData.length >= 14) {
                const seed = v2eYestIntradayData.slice(-30);
                const combined = [...seed, ...v2eCandlesUpToTime];
                v2eRsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                v2eRsiValues = this.indicators.calculateRSI(
                  v2eCandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const v2eSwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < v2eCandlesUpToTime.length - 5; i++) {
                const c = v2eCandlesUpToTime[i];
                const prev5 = v2eCandlesUpToTime.slice(i - 5, i);
                const next5 = v2eCandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  v2eSwingHighs.push({ price: c.high, index: i });
                }
              }

              const v2eSuperTrend = this.indicators.calculateSuperTrend(
                v2eCandlesUpToTime,
                10,
                2,
              );

              const v2eLastCandle =
                v2eCandlesUpToTime[v2eCandlesUpToTime.length - 1];
              const v2eLtp = v2eLastCandle.close || 0;
              const v2eEodClose = v2eLastCandle.close ?? 0;
              const v2eLotSize = inst.lot_size || 1;
              const v2eTotalQty = paperLots * v2eLotSize;
              const v2eHalfQty = Math.floor(v2eTotalQty / 2);
              const v2eRemainingQty = v2eTotalQty - v2eHalfQty;

              const v2eSignalCandidates = this.detectDaySellSignalsV2Enhanced({
                candles: v2eCandlesUpToTime,
                ema20Values: v2eEma20Values,
                ema8Values: v2eEma8Values,
                rsiValues: v2eRsiValues,
                swingHighs: v2eSwingHighs,
                yesterdayHigh: v2eYestHigh,
                prevDayLow: v2ePrevDayLow,
                prevDayClose: v2ePrevDayClose,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: v2eSuperTrend,
              });

              const v2eSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v2eActiveTradeClosed = true;
              let v2eConsecSL = 0;
              let v2eDailyStop = false;

              for (const sig of v2eSignalCandidates) {
                if (v2eDailyStop) break;
                if (!v2eActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v2eTs,
                  reason: v2eReason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v2eActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v2eCandlesUpToTime.length;
                  j++
                ) {
                  const fc = v2eCandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v2eActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v2eCandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v2eCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v2eActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v2eActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v2eActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v2eActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v2eTotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v2eHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v2eRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v2eRemainingQty;
                  } else {
                    pnl =
                      t1Profit + (entryPrice - v2eEodClose) * v2eRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v2eEodClose) * v2eTotalQty;
                }

                if (outcome === 'SL') {
                  v2eConsecSL++;
                  if (v2eConsecSL >= 2) v2eDailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v2eConsecSL = 0;
                  v2eDailyStop = true;
                }

                v2eSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v2eTs,
                  recommendation: 'SELL',
                  reason: `${v2eReason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v2eReason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v2eSellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v2eSellSignals,
                ltp: v2eLtp,
                lotSize: inst.lot_size,
                candles: v2eCandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V1V2 STRATEGY ============
            if (strategy === 'DAY_SELLING_V1V2') {
              this.logger.debug(
                `[DAY_SELLING_V1V2] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V1V2.`,
                );
                return null;
              }

              const intradayHistoricalC = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              if (!intradayHistoricalC || intradayHistoricalC.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V1V2 (${intradayHistoricalC?.length || 0})`,
                );
                return null;
              }

              const cYesterday2DayData = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                prevWindowFrom,
                yesterdayTo,
              );

              let cYestHigh = 0;
              let cPrevDayLow = 0;
              let cPrevDayClose = 0;
              if (cYesterday2DayData && cYesterday2DayData.length > 0) {
                cYestHigh =
                  cYesterday2DayData[cYesterday2DayData.length - 1].high;
                cPrevDayLow =
                  cYesterday2DayData[cYesterday2DayData.length - 1].low;
                cPrevDayClose =
                  cYesterday2DayData[cYesterday2DayData.length - 1].close;
              }

              const cYesterday2IntradayData = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                prevWindowFrom,
                yesterdayTo,
              );

              const [cTargetHour, cTargetMin] = specificTime
                .split(':')
                .map(Number);
              const cCandlesUpToTime = intradayHistoricalC.filter((candle) => {
                const d = new Date(candle.date);
                return (
                  d.getHours() < cTargetHour ||
                  (d.getHours() === cTargetHour && d.getMinutes() <= cTargetMin)
                );
              });

              if (cCandlesUpToTime.length < 1) return null;

              // EMA pre-seeding
              let cEmaValues: (number | null)[];
              if (
                cYesterday2IntradayData &&
                cYesterday2IntradayData.length >= 20
              ) {
                const seed = cYesterday2IntradayData.slice(-25);
                const combined = [...seed, ...cCandlesUpToTime];
                cEmaValues = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                cEmaValues = this.indicators.calculateEMA(
                  cCandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // RSI pre-seeding
              let cRsiValues: (number | null)[];
              if (
                cYesterday2IntradayData &&
                cYesterday2IntradayData.length >= 14
              ) {
                const seed = cYesterday2IntradayData.slice(-30);
                const combined = [...seed, ...cCandlesUpToTime];
                cRsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                cRsiValues = this.indicators.calculateRSI(
                  cCandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const cSwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < cCandlesUpToTime.length - 5; i++) {
                const c = cCandlesUpToTime[i];
                const prev5 = cCandlesUpToTime.slice(i - 5, i);
                const next5 = cCandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  cSwingHighs.push({ price: c.high, index: i });
                }
              }

              const cSuperTrend = this.indicators.calculateSuperTrend(
                cCandlesUpToTime,
                10,
                2,
              );

              const cLastCandle = cCandlesUpToTime[cCandlesUpToTime.length - 1];
              const cLtp = cLastCandle.close || 0;
              const cEodClose = cLastCandle.close ?? 0;
              const cLotSize = inst.lot_size || 1;
              const cTotalQty = paperLots * cLotSize;
              const cHalfQty = Math.floor(cTotalQty / 2);
              const cRemainingQty = cTotalQty - cHalfQty;

              const cSignalCandidates = this.detectDaySellSignalsCombined({
                candles: cCandlesUpToTime,
                emaValues: cEmaValues,
                rsiValues: cRsiValues,
                swingHighs: cSwingHighs,
                yesterdayHigh: cYestHigh,
                prevDayLow: cPrevDayLow,
                prevDayClose: cPrevDayClose,
                marginPoints,
                minSellRsi,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: cSuperTrend,
              });

              const cSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let cActiveTradeClose = true;
              let cConsecSL = 0;
              let cDailyStop = false;

              for (const sig of cSignalCandidates) {
                if (cDailyStop) break;
                if (!cActiveTradeClose) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: cTs,
                  reason: cReason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                cActiveTradeClose = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < cCandlesUpToTime.length;
                  j++
                ) {
                  const fc = cCandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    cActiveTradeClose = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (let j = t1HitIdx + 1; j < cCandlesUpToTime.length; j++) {
                    const fc = cCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      cActiveTradeClose = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      cActiveTradeClose = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      cActiveTradeClose = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    cActiveTradeClose = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * cTotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * cHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * cRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * cRemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - cEodClose) * cRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - cEodClose) * cTotalQty;
                }

                if (outcome === 'SL') {
                  cConsecSL++;
                  if (cConsecSL >= 2) cDailyStop = true;
                } else if (outcome !== 'OPEN') {
                  cConsecSL = 0;
                  cDailyStop = true;
                }

                cSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: cTs,
                  recommendation: 'SELL',
                  reason: `${cReason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: cReason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (cSellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: cSellSignals,
                ltp: cLtp,
                lotSize: inst.lot_size,
                candles: cCandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V3 STRATEGY ============
            if (strategy === 'DAY_SELLING_V3') {
              this.logger.debug(
                `[DAY_SELLING_V3] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V3.`,
                );
                return null;
              }

              const v3IntradayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              if (!v3IntradayHistorical || v3IntradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V3 (${v3IntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const v3YestDayData = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                prevWindowFrom,
                yesterdayTo,
              );

              let v3YestHigh = 0;
              let v3PrevDayLow = 0;
              let v3PrevDayClose = 0;
              if (v3YestDayData && v3YestDayData.length > 0) {
                v3YestHigh = v3YestDayData[v3YestDayData.length - 1].high;
                v3PrevDayLow = v3YestDayData[v3YestDayData.length - 1].low;
                v3PrevDayClose = v3YestDayData[v3YestDayData.length - 1].close;
              }

              const v3YestIntradayData = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                prevWindowFrom,
                yesterdayTo,
              );

              const [v3TargetHour, v3TargetMin] = specificTime
                .split(':')
                .map(Number);
              const v3CandlesUpToTime = v3IntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v3TargetHour ||
                    (d.getHours() === v3TargetHour &&
                      d.getMinutes() <= v3TargetMin)
                  );
                },
              );

              if (v3CandlesUpToTime.length < 1) return null;

              // EMA pre-seeding
              let v3EmaValues: (number | null)[];
              if (v3YestIntradayData && v3YestIntradayData.length >= 20) {
                const seed = v3YestIntradayData.slice(-25);
                const combined = [...seed, ...v3CandlesUpToTime];
                v3EmaValues = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v3EmaValues = this.indicators.calculateEMA(
                  v3CandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // RSI pre-seeding
              let v3RsiValues: (number | null)[];
              if (v3YestIntradayData && v3YestIntradayData.length >= 14) {
                const seed = v3YestIntradayData.slice(-30);
                const combined = [...seed, ...v3CandlesUpToTime];
                v3RsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                v3RsiValues = this.indicators.calculateRSI(
                  v3CandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const v3SwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < v3CandlesUpToTime.length - 5; i++) {
                const c = v3CandlesUpToTime[i];
                const prev5 = v3CandlesUpToTime.slice(i - 5, i);
                const next5 = v3CandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  v3SwingHighs.push({ price: c.high, index: i });
                }
              }

              const v3SuperTrend = this.indicators.calculateSuperTrend(
                v3CandlesUpToTime,
                10,
                2,
              );

              const v3LastCandle =
                v3CandlesUpToTime[v3CandlesUpToTime.length - 1];
              const v3Ltp = v3LastCandle.close || 0;
              const v3EodClose = v3LastCandle.close ?? 0;
              const v3LotSize = inst.lot_size || 1;
              const v3TotalQty = paperLots * v3LotSize;
              const v3HalfQty = Math.floor(v3TotalQty / 2);
              const v3RemainingQty = v3TotalQty - v3HalfQty;

              const v3SignalCandidates = this.detectDaySellSignalsV3({
                candles: v3CandlesUpToTime,
                emaValues: v3EmaValues,
                rsiValues: v3RsiValues,
                swingHighs: v3SwingHighs,
                yesterdayHigh: v3YestHigh,
                prevDayLow: v3PrevDayLow,
                prevDayClose: v3PrevDayClose,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: v3SuperTrend,
              });

              const v3SellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v3ActiveTradeClosed = true;
              let v3ConsecSL = 0;
              let v3DailyStop = false;

              for (const sig of v3SignalCandidates) {
                if (v3DailyStop) break;
                if (!v3ActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v3Ts,
                  reason: v3Reason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v3ActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v3CandlesUpToTime.length;
                  j++
                ) {
                  const fc = v3CandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v3ActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v3CandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v3CandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v3ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v3ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v3ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v3ActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v3TotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v3HalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v3RemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v3RemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - v3EodClose) * v3RemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v3EodClose) * v3TotalQty;
                }

                if (outcome === 'SL') {
                  v3ConsecSL++;
                  if (v3ConsecSL >= 2) v3DailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v3ConsecSL = 0;
                  v3DailyStop = true;
                }

                v3SellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v3Ts,
                  recommendation: 'SELL',
                  reason: `${v3Reason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v3Reason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v3SellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v3SellSignals,
                ltp: v3Ltp,
                lotSize: inst.lot_size,
                candles: v3CandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V4 STRATEGY ============
            if (strategy === 'DAY_SELLING_V4') {
              this.logger.debug(
                `[DAY_SELLING_V4] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V4.`,
                );
                return null;
              }

              const v4IntradayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              if (!v4IntradayHistorical || v4IntradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V4 (${v4IntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const v4YestIntradayData = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                prevWindowFrom,
                yesterdayTo,
              );

              const [v4TargetHour, v4TargetMin] = specificTime
                .split(':')
                .map(Number);
              const v4CandlesUpToTime = v4IntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v4TargetHour ||
                    (d.getHours() === v4TargetHour &&
                      d.getMinutes() <= v4TargetMin)
                  );
                },
              );

              if (v4CandlesUpToTime.length < 1) return null;

              // 20 EMA with pre-seeding
              let v4Ema20Values: (number | null)[];
              if (v4YestIntradayData && v4YestIntradayData.length >= 20) {
                const seed = v4YestIntradayData.slice(-25);
                const combined = [...seed, ...v4CandlesUpToTime];
                v4Ema20Values = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v4Ema20Values = this.indicators.calculateEMA(
                  v4CandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // 8 EMA with pre-seeding
              let v4Ema8Values: (number | null)[];
              if (v4YestIntradayData && v4YestIntradayData.length >= 8) {
                const seed = v4YestIntradayData.slice(-15);
                const combined = [...seed, ...v4CandlesUpToTime];
                v4Ema8Values = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    8,
                  )
                  .slice(seed.length);
              } else {
                v4Ema8Values = this.indicators.calculateEMA(
                  v4CandlesUpToTime.map((c) => c.close),
                  8,
                );
              }

              // VWAP (today's candles, no pre-seeding)
              const v4VwapValues = this.indicators.calculateVWAP(
                v4CandlesUpToTime.map((c) => ({
                  high: c.high,
                  low: c.low,
                  close: c.close,
                  volume: c.volume ?? 0,
                })),
              );

              const v4SuperTrend = this.indicators.calculateSuperTrend(
                v4CandlesUpToTime,
                10,
                2,
              );

              const v4LastCandle =
                v4CandlesUpToTime[v4CandlesUpToTime.length - 1];
              const v4Ltp = v4LastCandle.close || 0;
              const v4EodClose = v4LastCandle.close ?? 0;
              const v4LotSize = inst.lot_size || 1;
              const v4TotalQty = paperLots * v4LotSize;
              const v4HalfQty = Math.floor(v4TotalQty / 2);
              const v4RemainingQty = v4TotalQty - v4HalfQty;

              const v4SignalCandidates = this.detectDaySellSignalsV4({
                candles: v4CandlesUpToTime,
                ema8Values: v4Ema8Values,
                ema20Values: v4Ema20Values,
                vwapValues: v4VwapValues,
                superTrendData: v4SuperTrend,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
              });

              const v4SellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v4ActiveTradeClosed = true;
              let v4ConsecSL = 0;
              let v4DailyStop = false;

              for (const sig of v4SignalCandidates) {
                if (v4DailyStop) break;
                if (!v4ActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v4Ts,
                  reason: v4Reason,
                  entryPrice,
                  stopLoss,
                  risk,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v4ActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v4CandlesUpToTime.length;
                  j++
                ) {
                  const fc = v4CandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v4ActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v4CandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v4CandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v4ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v4ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v4ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v4ActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v4TotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v4HalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v4RemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v4RemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - v4EodClose) * v4RemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v4EodClose) * v4TotalQty;
                }

                if (outcome === 'SL') {
                  v4ConsecSL++;
                  if (v4ConsecSL >= 2) v4DailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v4ConsecSL = 0;
                  v4DailyStop = true;
                }

                v4SellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v4Ts,
                  recommendation: 'SELL',
                  reason: `${v4Reason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v4Reason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v4SellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v4SellSignals,
                ltp: v4Ltp,
                lotSize: inst.lot_size,
                candles: v4CandlesUpToTime,
              };
            }

            // ============ DAY_BUYING STRATEGY ============
            // Look for BUY signals using bullish patterns:
            // - RED candle closes below EMA → GREEN candle closes above EMA (recovery)
            // - Bounce at support (EMA/yesterday low/swing lows)
            // - Bullish patterns: Hammer, Bullish Engulfing, Strong Bounce
            // - Only RSI filter applied (no candle low restrictions)
            if (strategy === 'DAY_BUYING') {
              this.logger.debug(
                `[DAY_BUYING] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_BUYING. Use intraday intervals.`,
                );
                return null;
              }

              // Fetch today's intraday candles
              const intradayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              this.logger.debug(
                `[DAY_BUYING] ${inst.tradingsymbol}: Fetched ${intradayHistorical?.length || 0} candles from ${todayFrom} to ${todayTo}`,
              );

              if (!intradayHistorical || intradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}), need at least 20`,
                );
                return null;
              }

              // Fetch yesterday's day data for low level
              const yesterdayDayData = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                yesterdayFrom,
                yesterdayTo,
              );

              let yesterdayLow = 0;
              if (yesterdayDayData && yesterdayDayData.length > 0) {
                yesterdayLow = yesterdayDayData[0].low;
                this.logger.debug(
                  `${inst.tradingsymbol}: Yesterday low = ${yesterdayLow.toFixed(2)}`,
                );
              }

              // Fetch yesterday's intraday data for EMA pre-seeding
              const yesterdayIntradayData = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                yesterdayFrom,
                yesterdayTo,
              );

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((c: any) => {
                const candleDate = new Date(c.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              if (candlesUpToTime.length < 1) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime}`,
                );
                return null;
              }

              // Calculate 20 EMA with pre-seeding
              let emaValues: (number | null)[];
              if (yesterdayIntradayData && yesterdayIntradayData.length >= 20) {
                const yesterdayLast25 = yesterdayIntradayData.slice(-25);
                const combinedCandles = [
                  ...yesterdayLast25,
                  ...intradayHistorical,
                ];
                const combinedClosePrices = combinedCandles.map(
                  (c: any) => c.close,
                );
                const combinedEMA = this.indicators.calculateEMA(
                  combinedClosePrices,
                  20,
                );
                emaValues = combinedEMA.slice(yesterdayLast25.length);
                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday`,
                );
              } else {
                const closePrices = intradayHistorical.map((c) => c.close);
                emaValues = this.indicators.calculateEMA(closePrices, 20);
              }

              // Calculate RSI (for display in signal reason)
              // Pre-seed RSI with yesterday's data for better accuracy
              let rsiValues: (number | null)[];

              if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
                // Pre-seed RSI: Combine yesterday's candles + today's candles
                const yesterdayForRSI = yesterdayIntradayData.slice(-30); // Use more data for RSI smoothing
                const combinedCandles = [
                  ...yesterdayForRSI,
                  ...candlesUpToTime,
                ];
                const combinedClosePrices = combinedCandles.map(
                  (c: any) => c.close,
                );

                // Calculate RSI on combined data
                const combinedRSI = this.indicators.calculateRSI(
                  combinedClosePrices,
                  14,
                );

                // Extract only today's RSI values (skip yesterday's candles)
                rsiValues = combinedRSI.slice(yesterdayForRSI.length);

                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded RSI with ${yesterdayForRSI.length} candles from yesterday. RSI available from first candle.`,
                );
              } else {
                // Fallback: Standard RSI calculation if no yesterday data
                this.logger.debug(
                  `${inst.tradingsymbol}: No sufficient yesterday data for RSI pre-seeding, using standard calculation`,
                );
                const closePrices = candlesUpToTime.map((c: any) => c.close);
                rsiValues = this.indicators.calculateRSI(closePrices, 14);
              }

              // First candle low (9:15 AM) - entry must be ABOVE this
              const firstCandleLow =
                intradayHistorical.length > 0 ? intradayHistorical[0].low : 0;
              if (firstCandleLow > 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: First candle low (9:15 AM) = ${firstCandleLow.toFixed(2)} (BUY signals must be ABOVE this)`,
                );
              }

              const buySignals: any[] = [];

              this.logger.debug(
                `${inst.tradingsymbol}: Processing ${candlesUpToTime.length} candles up to ${specificTime}`,
              );

              // MAIN SIGNAL DETECTION LOOP
              for (let i = 3; i < candlesUpToTime.length; i++) {
                const candle = candlesUpToTime[i];
                const candleIST = new Date(candle.date);
                const candleHours = candleIST.getHours();
                const candleMinutes = candleIST.getMinutes();

                // Time filter: 9:30 AM - 2:30 PM
                if (
                  candleHours < 9 ||
                  (candleHours === 9 && candleMinutes < 30)
                ) {
                  continue;
                }
                if (
                  candleHours > 14 ||
                  (candleHours === 14 && candleMinutes >= 30)
                ) {
                  break;
                }

                const candleDate = new Date(candle.date);
                const candleTimestamp =
                  Math.floor(candleDate.getTime() / 1000) + 19800; // Unix timestamp in seconds + IST offset (to match chartData format)
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });
                const candleEMA = emaValues[i] ?? 0;
                const candleLow = candle.low;
                const candleClose = candle.close;

                // Get previous candles
                const prev3 = i >= 3 ? candlesUpToTime[i - 3] : null;
                const prev2 = i >= 2 ? candlesUpToTime[i - 2] : null;
                const prev1 = i >= 1 ? candlesUpToTime[i - 1] : null;

                // Entry candle analysis
                const actualEntryCandle = candle;
                const actualCandleOpen = actualEntryCandle.open;
                const actualCandleClose = actualEntryCandle.close;
                const actualCandleHigh = actualEntryCandle.high;
                const actualCandleLow = actualEntryCandle.low;
                const actualCandleBody = Math.abs(
                  actualCandleClose - actualCandleOpen,
                );
                const actualTotalRange = actualCandleHigh - actualCandleLow;
                const actualUpperWick =
                  actualCandleHigh -
                  Math.max(actualCandleOpen, actualCandleClose);
                const actualLowerWick =
                  Math.min(actualCandleOpen, actualCandleClose) -
                  actualCandleLow;

                // GREEN candle check
                const actualIsGreenCandle =
                  actualCandleClose > actualCandleOpen;

                let entryPrice = actualCandleClose;
                let signalDetected = false;
                let signalReason = '';

                // EMA trend filter for BUY signals
                const trendMarginPoints = 35;
                const isAboveEMA = candleClose > candleEMA;
                const isFarBelowEMA =
                  candleClose < candleEMA - trendMarginPoints;

                if (!isAboveEMA && !isFarBelowEMA && candleEMA > 0) {
                  continue; // Skip if price is flat near EMA
                }

                // Support level detection
                const marginPoints = 5;
                const nearEMA =
                  Math.abs(candleLow - candleEMA) <= marginPoints &&
                  candleEMA > 0;
                const nearYesterdayLow =
                  Math.abs(candleLow - yesterdayLow) <= marginPoints &&
                  yesterdayLow > 0;

                // Find swing lows
                const swingLows: { price: number }[] = [];
                for (let j = Math.max(0, i - 20); j < i; j++) {
                  const c = candlesUpToTime[j];
                  const before = j > 0 ? candlesUpToTime[j - 1] : null;
                  const after = j < i - 1 ? candlesUpToTime[j + 1] : null;

                  if (
                    before &&
                    after &&
                    c.low < before.low &&
                    c.low < after.low
                  ) {
                    swingLows.push({ price: c.low });
                  }
                }

                const nearSwingLow = swingLows.some(
                  (s) => Math.abs(candleLow - s.price) <= marginPoints,
                );

                // Count support tests
                let supportTests = 0;
                const supportLevel = nearEMA
                  ? candleEMA
                  : nearYesterdayLow
                    ? yesterdayLow
                    : nearSwingLow
                      ? swingLows.find(
                          (s) => Math.abs(candleLow - s.price) <= marginPoints,
                        )?.price
                      : candleEMA;

                if (supportLevel) {
                  [prev3, prev2, prev1, actualEntryCandle].forEach((c) => {
                    if (
                      c &&
                      Math.abs(c.low - supportLevel) <= marginPoints * 1.5
                    ) {
                      supportTests++;
                    }
                  });
                }

                // Get RSI value for this candle
                const candleRSI = rsiValues[i];

                // Two separate buy signal scenarios:

                // Scenario 1: Oversold Green Candle (any green candle when RSI < 40)
                if (
                  actualIsGreenCandle &&
                  candleRSI != null &&
                  candleRSI < 40
                ) {
                  signalDetected = true;
                  signalReason = `Oversold Green Candle (RSI ${candleRSI.toFixed(1)})`;
                  this.logger.debug(
                    `${inst.tradingsymbol}: 🟢 Scenario 1 - Oversold green candle at ${candleTime} | RSI: ${candleRSI.toFixed(1)} < 40`,
                  );
                }

                // Scenario 2: EMA Crossover (opens below EMA, closes above EMA, RSI < 60)
                else if (
                  actualCandleOpen < candleEMA &&
                  actualCandleClose > candleEMA &&
                  candleEMA > 0 &&
                  candleRSI != null &&
                  candleRSI < 60
                ) {
                  signalDetected = true;
                  signalReason = `EMA Crossover (RSI ${candleRSI.toFixed(1)})`;
                  this.logger.debug(
                    `${inst.tradingsymbol}: 🔄 Scenario 2 - EMA crossover at ${candleTime} | Open: ${actualCandleOpen.toFixed(2)} < EMA: ${candleEMA.toFixed(2)} < Close: ${actualCandleClose.toFixed(2)} | RSI: ${candleRSI.toFixed(1)} < 60`,
                  );
                }

                if (signalDetected) {
                  entryPrice = actualCandleClose;

                  this.logger.debug(
                    `${inst.tradingsymbol}: ✅ BUY SIGNAL: ${signalReason} at ${candleTime}`,
                  );

                  // Risk management
                  const stopLoss = actualCandleLow - 7;
                  const risk = entryPrice - stopLoss;
                  const target = entryPrice + risk * 2;

                  // Add RSI to signal reason for display
                  const rsiText =
                    candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                  this.logger.log(
                    `${inst.tradingsymbol}: ${candleTime} BUY SIGNAL (${signalReason}) | RSI: ${candleRSI != null ? candleRSI.toFixed(1) : 'N/A'} | Entry: ${entryPrice.toFixed(2)} | SL: ${stopLoss.toFixed(2)} | Target: ${target.toFixed(2)} | Risk: ${risk.toFixed(1)} pts`,
                  );

                  buySignals.push({
                    time: candleTime,
                    date: candleDate, // Full Date object from candle
                    timestamp: candleTimestamp, // Unix timestamp for matching
                    recommendation: 'BUY',
                    reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}${rsiText}`,
                    price: entryPrice,
                    stopLoss,
                    target,
                  });

                  break; // One signal per instrument
                }
              }

              // Get current LTP
              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const ltp = lastCandle.close || 0;

              this.logger.debug(
                `${inst.tradingsymbol}: Found ${buySignals.length} BUY signal(s), LTP: ${ltp.toFixed(2)}`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: buySignals,
                ltp: ltp,
                lotSize: inst.lot_size,
                candles: candlesUpToTime,
              };
            }

            // ============ SMART_SELL STRATEGY (ADVANCED DAY_SELLING)  ============
            // Improvements over DAY_SELLING:
            // 1. RSI Filter: Only sell when RSI > 60 (overbought)
            // 2. Time Filter: Only trade 10:30 AM - 2:30 PM
            // 3. Volume Confirmation: Rejection candle must have volume > average
            // 4. Multiple Confirmations: Need at least 2 pattern confirmations
            if (strategy === 'SMART_SELL') {
              this.logger.debug(
                `[SMART_SELL] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for SMART_SELL. Use intraday intervals.`,
                );
                return null;
              }

              // Fetch today's intraday candles
              const intradayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              this.logger.debug(
                `[SMART_SELL] ${inst.tradingsymbol}: Fetched ${intradayHistorical?.length || 0} candles from ${todayFrom} to ${todayTo}`,
              );

              if (!intradayHistorical || intradayHistorical.length < 30) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}), need at least 30 for RSI`,
                );
                return null;
              }

              // Fetch yesterday's data for high level
              const yesterdayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                yesterdayFrom,
                yesterdayTo,
              );

              let yesterdayHigh = 0;
              if (yesterdayHistorical && yesterdayHistorical.length > 0) {
                yesterdayHigh = yesterdayHistorical[0].high;
                this.logger.debug(
                  `${inst.tradingsymbol}: Yesterday high = ${yesterdayHigh}`,
                );
              }

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((candle) => {
                const candleDate = new Date(candle.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              if (candlesUpToTime.length < 30) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime}`,
                );
                return null;
              }

              // Calculate 20 EMA
              const closePrices = candlesUpToTime.map((c) => c.close);
              const emaValues = this.indicators.calculateEMA(closePrices, 20);

              // Calculate RSI (14 period)
              const rsiValues = this.indicators.calculateRSI(closePrices, 14);

              // Calculate average volume for comparison
              const volumes = candlesUpToTime.map((c) => c.volume || 0);
              const avgVolume5 = (totalVol: number, idx: number) => {
                if (idx < 5) return totalVol / (idx + 1);
                let sum = 0;
                for (let j = idx - 4; j <= idx; j++) {
                  sum += volumes[j];
                }
                return sum / 5;
              };

              // Find swing highs (local peaks in the session)
              const swingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < candlesUpToTime.length - 5; i++) {
                const candle = candlesUpToTime[i];
                const prevCandles = candlesUpToTime.slice(i - 5, i);
                const nextCandles = candlesUpToTime.slice(i + 1, i + 6);

                const isLocalHigh =
                  prevCandles.every((c) => c.high < candle.high) &&
                  nextCandles.every((c) => c.high < candle.high);

                if (isLocalHigh) {
                  swingHighs.push({ price: candle.high, index: i });
                }
              }

              this.logger.debug(
                `${inst.tradingsymbol}: Found ${swingHighs.length} swing highs`,
              );

              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const ltp = lastCandle.close || 0;

              // Check ALL candles for SELL signals (with advanced filters)
              const sellSignals: Array<{
                time: string;
                date: Date; // Full Date object from candle
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
              }> = [];

              let lastSignalSL = 0;
              let activeTradeClosed = true; // Track if previous trade has closed

              const smartSellStartIndex = realtimeMode
                ? Math.max(29, candlesUpToTime.length - 2)
                : 29;

              for (
                let i = smartSellStartIndex;
                i < candlesUpToTime.length;
                i++
              ) {
                // === ONE TRADE AT A TIME: Skip if previous trade is still active ===
                if (!activeTradeClosed) {
                  continue; // Previous trade hasn't closed yet, don't generate new signals
                }

                const candle = candlesUpToTime[i];
                const candleEMA = emaValues[i];
                const candleRSI = rsiValues[i];
                if (!candleEMA || !candleRSI) continue;

                const candleHigh = candle.high;
                const candleLow = candle.low;
                const candleOpen = candle.open;
                const candleClose = candle.close;
                const candleBody = Math.abs(candleClose - candleOpen);
                const upperWick =
                  candleHigh - Math.max(candleOpen, candleClose);
                const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
                const totalRange = candleHigh - candleLow;
                const isRedCandle = candleClose < candleOpen;
                const isGreenCandle = candleClose > candleOpen;
                const candleVolume = candle.volume || 0;

                const candleDate = new Date(candle.date);
                const candleTimestamp =
                  Math.floor(candleDate.getTime() / 1000) + 19800;
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });
                const candleHour = candleDate.getHours();
                const candleMinute = candleDate.getMinutes();

                // ===== FILTER 1: TIME OF DAY =====
                // Only trade between 10:30 AM - 2:30 PM
                if (
                  candleHour < 10 ||
                  (candleHour === 10 && candleMinute < 30)
                ) {
                  continue; // Before 10:30 AM
                }
                if (
                  candleHour > 14 ||
                  (candleHour === 14 && candleMinute > 30)
                ) {
                  continue; // After 2:30 PM
                }

                // ===== FILTER 2: RSI OVERBOUGHT =====
                // Only sell when RSI > 60 (overbought zone)
                if (candleRSI <= 60) {
                  continue;
                }

                // Skip if price hasn't moved above last signal's SL.
                // Only enforced in realtimeMode — same reasoning as DAY_SELLING.
                if (
                  realtimeMode &&
                  lastSignalSL > 0 &&
                  candleHigh < lastSignalSL
                ) {
                  continue;
                }

                let signalDetected = false;
                let signalReason = '';
                let entryPrice = candleClose;
                let confirmations = 0;
                const patterns: string[] = [];

                // Check if near a resistance level
                const nearEMA =
                  Math.abs(candleHigh - candleEMA) <= marginPoints;
                const nearYesterdayHigh =
                  yesterdayHigh > 0 &&
                  Math.abs(candleHigh - yesterdayHigh) <= marginPoints;

                let nearSwingHigh = false;
                for (const swing of swingHighs) {
                  if (
                    swing.index < i - 3 &&
                    Math.abs(candleHigh - swing.price) <= marginPoints
                  ) {
                    nearSwingHigh = true;
                    break;
                  }
                }

                // Only proceed if near a resistance level
                if (!nearEMA && !nearYesterdayHigh && !nearSwingHigh) {
                  continue;
                }

                // ===== REJECTION CANDLE VALIDATION =====
                // The rejection candle MUST be:
                // 1. RED candle (close < open), OR
                // 2. DOJI (small body) + NEXT candle is RED

                // Check if current candle is DOJI (body < 10% of total range)
                const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;

                // Get next candle for DOJI check
                const nextCandle =
                  i + 1 < candlesUpToTime.length
                    ? candlesUpToTime[i + 1]
                    : null;
                const nextIsRed = nextCandle
                  ? nextCandle.close < nextCandle.open
                  : false;

                // Validation: Must be RED candle OR (DOJI + next is RED)
                if (!isRedCandle && !(isDoji && nextIsRed)) {
                  continue; // Skip: Not a valid rejection candle
                }

                // If DOJI + next RED: Use NEXT candle as entry point
                let actualEntryCandle = candle;
                let actualIndex = i;
                if (isDoji && nextIsRed && nextCandle) {
                  actualEntryCandle = nextCandle;
                  actualIndex = i + 1;
                  this.logger.debug(
                    `${inst.tradingsymbol}: DOJI at ${candleTime}, using next RED candle for entry`,
                  );
                }

                // Recalculate candle properties for actual entry candle
                const actualCandleHigh = actualEntryCandle.high;
                const actualCandleLow = actualEntryCandle.low;
                const actualCandleOpen = actualEntryCandle.open;
                const actualCandleClose = actualEntryCandle.close;
                const actualCandleBody = Math.abs(
                  actualCandleClose - actualCandleOpen,
                );
                const actualUpperWick =
                  actualCandleHigh -
                  Math.max(actualCandleOpen, actualCandleClose);
                const actualLowerWick =
                  Math.min(actualCandleOpen, actualCandleClose) -
                  actualCandleLow;
                const actualTotalRange = actualCandleHigh - actualCandleLow;
                const actualIsRedCandle = actualCandleClose < actualCandleOpen;
                const actualIsGreenCandle =
                  actualCandleClose > actualCandleOpen;
                const actualCandleVolume = actualEntryCandle.volume || 0;

                // Get previous candles for context (relative to actual entry candle)
                const prev1 =
                  actualIndex >= 1 ? candlesUpToTime[actualIndex - 1] : null;
                const prev2 =
                  actualIndex >= 2 ? candlesUpToTime[actualIndex - 2] : null;
                const prev3 =
                  actualIndex >= 3 ? candlesUpToTime[actualIndex - 3] : null;

                // Calculate average volume
                const avg5Vol = avgVolume5(0, actualIndex);

                // ===== FILTER 3: VOLUME CONFIRMATION =====
                const hasVolumeConfirmation =
                  actualCandleVolume > avg5Vol * 1.2;

                // Count resistance tests
                let resistanceTests = 0;
                const resistanceLevel = nearYesterdayHigh
                  ? yesterdayHigh
                  : nearSwingHigh
                    ? swingHighs.find(
                        (s) => Math.abs(candleHigh - s.price) <= marginPoints,
                      )?.price
                    : candleEMA;

                if (resistanceLevel) {
                  [prev3, prev2, prev1, actualEntryCandle].forEach((c) => {
                    if (
                      c &&
                      Math.abs(c.high - resistanceLevel) <= marginPoints * 1.5
                    ) {
                      resistanceTests++;
                    }
                  });
                }

                // Pattern Detection (count confirmations)
                // Pattern 1: Weak close at resistance (must be on RED candle)
                if (
                  actualIsRedCandle &&
                  (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
                  actualCandleHigh >= (resistanceLevel || candleEMA) * 0.99 &&
                  actualCandleClose < actualCandleHigh * 0.995 &&
                  resistanceTests >= 2
                ) {
                  confirmations++;
                  patterns.push(`Weak Close (${resistanceTests} tests)`);
                }

                // Pattern 2: Early rejection (upper wick, must be on RED candle)
                if (
                  actualIsRedCandle &&
                  (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
                  actualUpperWick > actualCandleBody * 1.2 &&
                  actualUpperWick > actualTotalRange * 0.4 &&
                  actualCandleClose < actualCandleHigh * 0.99
                ) {
                  confirmations++;
                  patterns.push('Early Rejection');
                }

                // Pattern 3: Momentum slowing (must be on RED candle)
                if (prev2 && prev1 && actualIsRedCandle) {
                  const body2 = Math.abs(prev2.close - prev2.open);
                  const body1 = Math.abs(prev1.close - prev1.open);
                  if (
                    actualCandleBody < body1 &&
                    body1 < body2 &&
                    resistanceTests >= 2
                  ) {
                    confirmations++;
                    patterns.push('Momentum Slowing');
                  }
                }

                // Pattern 4: Shooting Star (must be RED candle for SELL signal)
                if (
                  actualIsRedCandle &&
                  actualUpperWick > actualCandleBody * 2 &&
                  actualLowerWick < actualCandleBody * 0.5 &&
                  actualUpperWick > actualTotalRange * 0.6
                ) {
                  confirmations++;
                  patterns.push('Shooting Star');
                }

                // Pattern 5: Bearish Engulfing
                if (
                  prev1 &&
                  prev1.close > prev1.open &&
                  actualCandleOpen > prev1.close &&
                  actualCandleClose < prev1.open &&
                  actualIsRedCandle
                ) {
                  confirmations++;
                  patterns.push('Bearish Engulfing');
                }

                // Pattern 6: Strong Upper Wick Rejection
                if (
                  actualIsRedCandle &&
                  actualUpperWick > actualCandleBody * 2 &&
                  actualUpperWick > actualTotalRange * 0.5 &&
                  actualCandleClose < actualCandleOpen * 0.98
                ) {
                  confirmations++;
                  patterns.push('Strong Rejection');
                }

                // ===== FILTER 4: MULTIPLE CONFIRMATIONS =====
                // Need at least 2 pattern confirmations + volume confirmation
                if (confirmations >= 2 && hasVolumeConfirmation) {
                  signalDetected = true;
                  signalReason = `${patterns.join(' + ')} | RSI:${candleRSI.toFixed(0)} | Vol:${(actualCandleVolume / avg5Vol).toFixed(1)}x`;
                }

                if (signalDetected) {
                  // Update entry price to actual entry candle close
                  entryPrice = actualCandleClose;

                  // Risk Management: SL = Entry candle high + 7 points
                  const stopLoss = actualCandleHigh + 7;
                  const risk = stopLoss - entryPrice;
                  const target1 = entryPrice - risk * 2;
                  const target2 = entryPrice - risk * 3;
                  const target3 = entryPrice - risk * 4;

                  sellSignals.push({
                    time: candleTime,
                    date: candleDate, // Full Date object from candle
                    timestamp: candleTimestamp,
                    recommendation: 'SELL',
                    reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts)`,
                    price: entryPrice,
                    stopLoss,
                    target1,
                    target2,
                    target3,
                  });

                  lastSignalSL = stopLoss;
                  activeTradeClosed = false; // Mark trade as active

                  this.logger.debug(
                    `${inst.tradingsymbol}: SMART_SELL signal at ${candleTime}, Confirmations: ${confirmations}, Reason: ${signalReason}, Entry: ${entryPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)} (Risk: ${risk.toFixed(1)}pts), T1: ${target1.toFixed(2)}`,
                  );

                  // === CHECK IF TRADE CLOSES (SL or Target hit) ===
                  // Start from actualIndex + 1 (after the actual entry candle)
                  for (
                    let j = actualIndex + 1;
                    j < candlesUpToTime.length;
                    j++
                  ) {
                    const futureCandle = candlesUpToTime[j];

                    // Check if SL hit
                    if (futureCandle.high >= stopLoss) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} SL HIT. Allowing next signal.`,
                      );
                      break;
                    }

                    // Check if any target hit
                    if (futureCandle.low <= target3) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} TARGET 1:4 HIT. Allowing next signal.`,
                      );
                      break;
                    } else if (futureCandle.low <= target2) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} TARGET 1:3 HIT. Allowing next signal.`,
                      );
                      break;
                    } else if (futureCandle.low <= target1) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} TARGET 1:2 HIT. Allowing next signal.`,
                      );
                      break;
                    }
                  }

                  if (!activeTradeClosed) {
                    this.logger.debug(
                      `${inst.tradingsymbol}: Trade ${sellSignals.length} still OPEN. No more signals.`,
                    );
                  }
                }
              }

              if (sellSignals.length === 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: No SMART_SELL signals found (strict filters applied)`,
                );
                return null;
              }

              this.logger.log(
                `${inst.tradingsymbol}: ✓ Found ${sellSignals.length} SMART_SELL signal(s)`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: sellSignals,
                ltp: ltp,
                lotSize: inst.lot_size,
                candles: candlesUpToTime, // Include candles for historical trade closure
              };
            }

            // ============ 20 EMA STRATEGY ============
            if (strategy === '20_EMA') {
              // For 20 EMA, we only need TODAY's intraday candles, no yesterday data
              this.logger.debug(
                `[20 EMA] Fetching today's intraday data for ${inst.tradingsymbol}`,
              );

              let emaValue: number | null = null;
              let emaTrend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot calculate 20 EMA with day interval. Skipping.`,
                );
                return null;
              }

              // Fetch today's intraday candles
              const intradayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
              );

              if (!intradayHistorical || intradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}) for 20 EMA calculation`,
                );
                return null;
              }

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((candle) => {
                const candleDate = new Date(candle.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              this.logger.debug(
                `${inst.tradingsymbol}: Total candles=${intradayHistorical.length}, Filtered up to ${specificTime}=${candlesUpToTime.length}`,
              );

              if (candlesUpToTime.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime} for 20 EMA (need 20, got ${candlesUpToTime.length})`,
                );
                return null;
              }

              // Calculate 20 EMA
              const closePrices = candlesUpToTime.map((c) => c.close);
              const emaValues = this.indicators.calculateEMA(closePrices, 20);
              emaValue = emaValues[emaValues.length - 1];

              // Determine EMA trend
              if (emaValues.length >= 25) {
                const currentEMA = emaValues[emaValues.length - 1];
                const pastEMA = emaValues[emaValues.length - 6];
                if (currentEMA && pastEMA) {
                  if (currentEMA > pastEMA * 1.002) {
                    emaTrend = 'UP';
                  } else if (currentEMA < pastEMA * 0.998) {
                    emaTrend = 'DOWN';
                  }
                }
              }

              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const todayHigh = Math.max(...candlesUpToTime.map((c) => c.high));
              const todayLow = Math.min(...candlesUpToTime.map((c) => c.low));
              const ltp = lastCandle.close || 0;

              this.logger.debug(
                `${inst.tradingsymbol}: Analyzing ${candlesUpToTime.length} candles up to ${specificTime}, Trend=${emaTrend}`,
              );

              // Check ALL candles for rejection patterns
              const rejectionSignals: Array<{
                time: string;
                date: Date; // Full Date object from candle
                recommendation: 'SELL' | 'BUY';
                reason: string;
                price: number;
              }> = [];
              let touchCount = 0;

              for (let i = 19; i < candlesUpToTime.length; i++) {
                const candle = candlesUpToTime[i];
                const candleEMA = emaValues[i];

                if (!candleEMA) continue;

                const candleHigh = candle.high;
                const candleLow = candle.low;
                const candleOpen = candle.open;
                const candleClose = candle.close;

                const distanceHighToEMA = Math.abs(candleHigh - candleEMA);
                const distanceLowToEMA = Math.abs(candleLow - candleEMA);
                const distanceCloseToEMA = Math.abs(candleClose - candleEMA);

                const touchedEMA =
                  distanceHighToEMA <= marginPoints ||
                  distanceLowToEMA <= marginPoints ||
                  distanceCloseToEMA <= marginPoints;

                if (touchedEMA) {
                  touchCount++;
                  const candleDate = new Date(candle.date); // Full Date object
                  const candleTime = candleDate.toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true,
                  });
                  this.logger.debug(
                    `${inst.tradingsymbol}: Candle #${i - 18} at ${candleTime} touched EMA: H=${candleHigh.toFixed(2)}, L=${candleLow.toFixed(2)}, C=${candleClose.toFixed(2)}, EMA=${candleEMA.toFixed(2)}`,
                  );

                  const candleBody = Math.abs(candleClose - candleOpen);
                  const upperWick =
                    candleHigh - Math.max(candleOpen, candleClose);
                  const lowerWick =
                    Math.min(candleOpen, candleClose) - candleLow;
                  const isRedCandle = candleClose < candleOpen;
                  const isGreenCandle = candleClose > candleOpen;

                  // BUY Signal: In uptrend, price pullback to EMA
                  if (emaTrend === 'UP') {
                    const hasLowerWickRejection =
                      lowerWick > candleBody * 1.2 &&
                      candleClose > candleEMA &&
                      candleLow <= candleEMA * 1.01;

                    const hasBullishBounce =
                      candleOpen < candleEMA &&
                      candleClose > candleEMA &&
                      isGreenCandle &&
                      candleBody > (candleHigh - candleLow) * 0.4;

                    if (hasLowerWickRejection) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Lower wick rejection at 20 EMA',
                        price: candleClose,
                      });
                    } else if (hasBullishBounce) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Bullish bounce from 20 EMA',
                        price: candleClose,
                      });
                    }
                  }

                  // SELL Signal: In downtrend, price rally to EMA
                  if (emaTrend === 'DOWN') {
                    const hasUpperWickRejection =
                      upperWick > candleBody * 1.2 &&
                      candleClose < candleEMA &&
                      candleHigh >= candleEMA * 0.99;

                    const hasBearishRejection =
                      candleOpen > candleEMA &&
                      candleClose < candleEMA &&
                      isRedCandle &&
                      candleBody > (candleHigh - candleLow) * 0.4;

                    if (hasUpperWickRejection) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Upper wick rejection at 20 EMA',
                        price: candleClose,
                      });
                    } else if (hasBearishRejection) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Bearish rejection from 20 EMA',
                        price: candleClose,
                      });
                    }
                  }
                }
              }

              if (rejectionSignals.length === 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: No rejection pattern found (Touched EMA ${touchCount} times)`,
                );
                return null;
              }

              this.logger.log(
                `${inst.tradingsymbol}: ✓ Found ${rejectionSignals.length} signal(s): ${rejectionSignals.map((s) => `${s.recommendation} at ${s.time}`).join(', ')}`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: rejectionSignals,
                ltp: ltp,
              };
            }

            // ============ PREVIOUS DAY HIGH/LOW STRATEGY ============
            if (strategy === 'PREV_DAY_HIGH_LOW') {
              this.logger.debug(
                `Fetching yesterday data for ${inst.tradingsymbol} (token: ${inst.instrument_token})`,
              );

              // Fetch yesterday's OHLC data
              const yesterdayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                yesterdayFrom,
                yesterdayTo,
              );

              this.logger.debug(
                `Yesterday data for ${inst.tradingsymbol}: ${JSON.stringify(yesterdayHistorical)}`,
              );

              if (!yesterdayHistorical || yesterdayHistorical.length === 0) {
                this.logger.warn(`No yesterday data for ${inst.tradingsymbol}`);
                return null; // Skip options with no yesterday data
              }

              const yesterdayData = yesterdayHistorical[0];
              const yesterdayHigh = yesterdayData.high;
              const yesterdayLow = yesterdayData.low;

              this.logger.debug(
                `Fetching today data for ${inst.tradingsymbol}`,
              );

              // Fetch today's OHLC data based on interval
              let todayHigh = 0;
              let todayLow = 0;
              let todayOpen = 0;
              let todayClose = 0;
              let ltp = 0;

              if (interval === 'day') {
                // Full day candle
                const todayHistorical = await kc.getHistoricalData(
                  inst.instrument_token,
                  'day',
                  todayFrom,
                  todayTo,
                );

                this.logger.debug(
                  `Today data for ${inst.tradingsymbol}: ${JSON.stringify(todayHistorical)}`,
                );

                if (!todayHistorical || todayHistorical.length === 0) {
                  this.logger.warn(`No today data for ${inst.tradingsymbol}`);
                  return null;
                }

                const todayData = todayHistorical[0];
                const candleDate = new Date(todayData.date); // Use today's candle date
                const candleHigh = todayData.high;
                const candleLow = todayData.low;
                const candleOpen = todayData.open;
                const candleClose = todayData.close;
                ltp = todayData.close || 0;

                // Check for rejection at yesterday's levels
                const candleBody = Math.abs(candleClose - candleOpen);
                const upperWick =
                  candleHigh - Math.max(candleOpen, candleClose);
                const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
                const totalCandleRange = candleHigh - candleLow;
                const isRedCandle = candleClose < candleOpen;
                const isGreenCandle = candleClose > candleOpen;

                const distanceHighToYesterdayHigh = Math.abs(
                  candleHigh - yesterdayHigh,
                );
                const distanceLowToYesterdayLow = Math.abs(
                  candleLow - yesterdayLow,
                );
                const nearYesterdayHigh =
                  distanceHighToYesterdayHigh <= marginPoints;
                const nearYesterdayLow =
                  distanceLowToYesterdayLow <= marginPoints;

                const rejectionSignals: Array<{
                  time: string;
                  date: Date; // Full Date object from candle
                  recommendation: 'SELL' | 'BUY';
                  reason: string;
                  price: number;
                }> = [];

                // Check SELL signals
                if (nearYesterdayHigh) {
                  const hasRejectionAtHigh =
                    upperWick > candleBody * 1.5 &&
                    candleClose < yesterdayHigh &&
                    candleHigh >= yesterdayHigh * 0.98;

                  const hasBreakoutFailure =
                    candleOpen > yesterdayHigh &&
                    candleClose < yesterdayHigh &&
                    isRedCandle &&
                    candleBody > totalCandleRange * 0.5;

                  if (hasRejectionAtHigh) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'SELL',
                      reason: 'Rejection at resistance (prev day high)',
                      price: candleClose,
                    });
                  } else if (hasBreakoutFailure) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'SELL',
                      reason: 'Breakout failure at resistance',
                      price: candleClose,
                    });
                  } else if (candleHigh >= yesterdayHigh * 0.98) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'SELL',
                      reason: 'Tested resistance (prev day high)',
                      price: candleClose,
                    });
                  }
                }

                // Check BUY signals
                if (nearYesterdayLow) {
                  const hasRejectionAtLow =
                    lowerWick > candleBody * 1.5 &&
                    candleClose > yesterdayLow &&
                    candleLow <= yesterdayLow * 1.02;

                  const hasBreakdownFailure =
                    candleOpen < yesterdayLow &&
                    candleClose > yesterdayLow &&
                    isGreenCandle &&
                    candleBody > totalCandleRange * 0.5;

                  if (hasRejectionAtLow) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'BUY',
                      reason: 'Rejection at support (prev day low)',
                      price: candleClose,
                    });
                  } else if (hasBreakdownFailure) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'BUY',
                      reason: 'Breakdown failure at support',
                      price: candleClose,
                    });
                  } else if (candleLow <= yesterdayLow * 1.02) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'BUY',
                      reason: 'Tested support (prev day low)',
                      price: candleClose,
                    });
                  }
                }

                if (rejectionSignals.length === 0) {
                  this.logger.debug(
                    `${inst.tradingsymbol}: No rejection signals found at prev day high/low (day candle)`,
                  );
                  return null;
                }

                this.logger.log(
                  `${inst.tradingsymbol}: ✓ Found ${rejectionSignals.length} signal(s) on day candle`,
                );

                return {
                  symbol: cleanSymbol,
                  strike: inst.strike,
                  optionType: inst.instrument_type as 'CE' | 'PE',
                  tradingsymbol: inst.tradingsymbol,
                  instrumentToken: inst.instrument_token,
                  signals: rejectionSignals,
                  ltp: ltp,
                  lotSize: inst.lot_size,
                };
              } else {
                // Intraday candle logic - check ALL candles for rejection patterns
                const intradayHistorical = await kc.getHistoricalData(
                  inst.instrument_token,
                  interval,
                  todayFrom,
                  todayTo,
                );

                this.logger.debug(
                  `Intraday data for ${inst.tradingsymbol}: ${intradayHistorical?.length || 0} candles`,
                );

                if (!intradayHistorical || intradayHistorical.length === 0) {
                  this.logger.warn(
                    `No intraday data for ${inst.tradingsymbol}`,
                  );
                  return null;
                }

                // Filter candles up to specific time
                const [targetHour, targetMin] = specificTime
                  .split(':')
                  .map(Number);

                const candlesUpToTime = intradayHistorical.filter((candle) => {
                  const candleDate = new Date(candle.date);
                  const candleHour = candleDate.getHours();
                  const candleMin = candleDate.getMinutes();
                  return (
                    candleHour < targetHour ||
                    (candleHour === targetHour && candleMin <= targetMin)
                  );
                });

                if (candlesUpToTime.length === 0) {
                  this.logger.warn(
                    `No candles found at or before ${specificTime} for ${inst.tradingsymbol}`,
                  );
                  return null;
                }

                this.logger.debug(
                  `${inst.tradingsymbol}: Checking ${candlesUpToTime.length} candles for prev day high/low rejections`,
                );

                // Loop through all candles and collect rejection signals
                const rejectionSignals: Array<{
                  time: string;
                  date: Date; // Full Date object from candle
                  recommendation: 'SELL' | 'BUY';
                  reason: string;
                  price: number;
                }> = [];

                for (let i = 0; i < candlesUpToTime.length; i++) {
                  const candle = candlesUpToTime[i];
                  const candleHigh = candle.high;
                  const candleLow = candle.low;
                  const candleOpen = candle.open;
                  const candleClose = candle.close;
                  const candleBody = Math.abs(candleClose - candleOpen);
                  const upperWick =
                    candleHigh - Math.max(candleOpen, candleClose);
                  const lowerWick =
                    Math.min(candleOpen, candleClose) - candleLow;
                  const totalCandleRange = candleHigh - candleLow;
                  const isRedCandle = candleClose < candleOpen;
                  const isGreenCandle = candleClose > candleOpen;

                  // Check distance to yesterday's levels
                  const distanceHighToYesterdayHigh = Math.abs(
                    candleHigh - yesterdayHigh,
                  );
                  const distanceLowToYesterdayLow = Math.abs(
                    candleLow - yesterdayLow,
                  );

                  const nearYesterdayHigh =
                    distanceHighToYesterdayHigh <= marginPoints;
                  const nearYesterdayLow =
                    distanceLowToYesterdayLow <= marginPoints;

                  const candleDate = new Date(candle.date); // Full Date object
                  const candleTime = candleDate.toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true,
                  });

                  // SELL Signal at yesterday's high
                  if (nearYesterdayHigh) {
                    const hasRejectionAtHigh =
                      upperWick > candleBody * 1.5 &&
                      candleClose < yesterdayHigh &&
                      candleHigh >= yesterdayHigh * 0.98;

                    const hasBreakoutFailure =
                      candleOpen > yesterdayHigh &&
                      candleClose < yesterdayHigh &&
                      isRedCandle &&
                      candleBody > totalCandleRange * 0.5;

                    if (hasRejectionAtHigh) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Rejection at resistance (prev day high)',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: SELL signal at ${candleTime}, YH=${yesterdayHigh.toFixed(2)}, High=${candleHigh.toFixed(2)}`,
                      );
                    } else if (hasBreakoutFailure) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Breakout failure at resistance',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: SELL signal (breakout failure) at ${candleTime}`,
                      );
                    } else if (candleHigh >= yesterdayHigh * 0.98) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Tested resistance (prev day high)',
                        price: candleClose,
                      });
                    }
                  }

                  // BUY Signal at yesterday's low
                  if (nearYesterdayLow) {
                    const hasRejectionAtLow =
                      lowerWick > candleBody * 1.5 &&
                      candleClose > yesterdayLow &&
                      candleLow <= yesterdayLow * 1.02;

                    const hasBreakdownFailure =
                      candleOpen < yesterdayLow &&
                      candleClose > yesterdayLow &&
                      isGreenCandle &&
                      candleBody > totalCandleRange * 0.5;

                    if (hasRejectionAtLow) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Rejection at support (prev day low)',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: BUY signal at ${candleTime}, YL=${yesterdayLow.toFixed(2)}, Low=${candleLow.toFixed(2)}`,
                      );
                    } else if (hasBreakdownFailure) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Breakdown failure at support',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: BUY signal (breakdown failure) at ${candleTime}`,
                      );
                    } else if (candleLow <= yesterdayLow * 1.02) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Tested support (prev day low)',
                        price: candleClose,
                      });
                    }
                  }
                }

                if (rejectionSignals.length === 0) {
                  this.logger.debug(
                    `${inst.tradingsymbol}: No rejection signals found at prev day high/low`,
                  );
                  return null;
                }

                this.logger.log(
                  `${inst.tradingsymbol}: ✓ Found ${rejectionSignals.length} signal(s): ${rejectionSignals.map((s) => `${s.recommendation} at ${s.time}`).join(', ')}`,
                );

                const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
                ltp = lastCandle.close || 0;

                return {
                  symbol: cleanSymbol,
                  strike: inst.strike,
                  optionType: inst.instrument_type as 'CE' | 'PE',
                  tradingsymbol: inst.tradingsymbol,
                  instrumentToken: inst.instrument_token,
                  signals: rejectionSignals,
                  ltp: ltp,
                  lotSize: inst.lot_size,
                  candles: candlesUpToTime, // Include candles for historical trade closure
                };
              }
            } // end PREV_DAY_HIGH_LOW

            // Both strategies return earlier, this should not be reached
            return null;
          } catch (err) {
            this.logger.error(
              `Error fetching data for ${inst.tradingsymbol}: ${err.message}`,
            );
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        const validResults = batchResults.filter((r) => r !== null);
        results.push(...validResults);

        this.logger.log(
          `Batch ${Math.floor(i / batchSize) + 1}: Processed ${batchResults.length} options, ${validResults.length} with signals, ${results.length} total`,
        );

        // Small delay between batches to avoid rate limiting
        if (i + batchSize < resolvedInstruments.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Count total signals
      const totalSignals = results.reduce(
        (sum, r) => sum + (r.signals?.length || 0),
        0,
      );
      const sellCount = results.reduce(
        (sum, r) =>
          sum +
          (r.signals?.filter((s: any) => s.recommendation === 'SELL').length ||
            0),
        0,
      );
      const buyCount = results.reduce(
        (sum, r) =>
          sum +
          (r.signals?.filter((s: any) => s.recommendation === 'BUY').length ||
            0),
        0,
      );

      this.logger.log(
        `Found ${results.length} options with ${totalSignals} total signals: ${sellCount} SELL, ${buyCount} BUY`,
      );

      // === FILTER TO ATM STRIKES FOR DAY_BUYING ===
      if (strategy === 'DAY_BUYING' && results.length > 0 && spotPrice > 0) {
        // Only keep options that have signals
        const optionsWithSignals = results.filter(
          (r) => r.signals && r.signals.length > 0,
        );

        this.logger.log(
          `[DAY_BUYING] Filtering to ATM strikes. ${optionsWithSignals.length} options with signals, Spot: ${spotPrice}`,
        );

        if (optionsWithSignals.length > 0) {
          // Find ATM CE (strike closest to spot price, below or at spot)
          const ceOptions = optionsWithSignals.filter(
            (r) => r.optionType === 'CE',
          );
          const peOptions = optionsWithSignals.filter(
            (r) => r.optionType === 'PE',
          );

          // For CE: ATM is strike <= spot, closest to spot
          const atmCE = ceOptions
            .filter((r) => r.strike <= spotPrice)
            .sort(
              (a, b) =>
                Math.abs(spotPrice - a.strike) - Math.abs(spotPrice - b.strike),
            )[0];

          // For PE: ATM is strike >= spot, closest to spot
          const atmPE = peOptions
            .filter((r) => r.strike >= spotPrice)
            .sort(
              (a, b) =>
                Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice),
            )[0];

          // Keep only ATM CE and ATM PE
          const filteredResults = [];
          if (atmCE) {
            filteredResults.push(atmCE);
            this.logger.log(
              `[DAY_BUYING] Selected ATM CE: ${atmCE.tradingsymbol} (Strike: ${atmCE.strike}, Signals: ${atmCE.signals.length})`,
            );
          } else {
            this.logger.warn(`[DAY_BUYING] No ATM CE found with signals`);
          }

          if (atmPE) {
            filteredResults.push(atmPE);
            this.logger.log(
              `[DAY_BUYING] Selected ATM PE: ${atmPE.tradingsymbol} (Strike: ${atmPE.strike}, Signals: ${atmPE.signals.length})`,
            );
          } else {
            this.logger.warn(`[DAY_BUYING] No ATM PE found with signals`);
          }

          // Replace results with filtered results
          results.splice(0, results.length, ...filteredResults);

          this.logger.log(
            `[DAY_BUYING] Filtered to ${results.length} ATM options (1 CE + 1 PE)`,
          );
        }
      }

      // === AUTO-CREATE PAPER TRADES ===
      // Only run auto-trade creation in realtimeMode (live scheduler).
      // Manual calls from Trade Finder or other endpoints must NOT create
      // paper trades — that path only scans/displays signals.
      if (!realtimeMode) {
        return { options: results, selectedInstruments: limitedInstruments };
      }

      // Check trading limits before creating paper trades
      const canTrade = await this.paperTradingService.canPlaceNewTrade(
        broker.userId,
        35, // Max daily loss: 35 points
        targetDate, // Check limits for the specific target date
      );

      if (canTrade.canTrade && results.length > 0) {
        this.logger.log(
          `Auto-trading enabled. Checking for new signals to create paper trades...`,
        );

        // Collect ALL signals from ALL options with their option data
        const allSignalsWithOptions: Array<{
          option: any;
          signal: any;
          timeValue: number; // For sorting
        }> = [];

        for (const option of results) {
          if (!option.signals || option.signals.length === 0) continue;

          for (const signal of option.signals) {
            // Parse time string to comparable value
            // Time format: "09:40 am" or "10:05 am"
            const timeValue = parseTimeToMinutes(signal.time);

            allSignalsWithOptions.push({
              option,
              signal,
              timeValue,
            });
          }
        }

        if (allSignalsWithOptions.length === 0) {
          this.logger.log('No signals found to create paper trades');
        } else {
          // Sort by time (earliest first)
          allSignalsWithOptions.sort((a, b) => a.timeValue - b.timeValue);

          // Take the EARLIEST signal
          const earliest = allSignalsWithOptions[0];
          const option = earliest.option;
          const signal = earliest.signal;

          this.logger.log(
            `📊 Found ${allSignalsWithOptions.length} total signals. Earliest: ${option.tradingsymbol} - ${signal.recommendation} @ ${signal.time} (${signal.price})`,
          );

          this.logger.log(
            `Attempting to auto-create paper trade for ${option.tradingsymbol} - ${signal.recommendation} @ ${signal.price}`,
          );

          try {
            const entryPrice = signal.price;

            // Use swing-high-aware SL/targets from signal analysis (computed in detectDaySellSignals).
            // SL = nearest recent swing high + 2 (if one exists 8–30 pts above entry), else entry + 30.
            // Targets = 2×/3×/4× risk below entry — always honest 1:2+ RRR.
            // Round to nearest integer so paper trade SL/targets match the
            // values shown in Trade Finder (which also rounds for display).
            const stopLoss = Math.round(signal.stopLoss);
            const target1 = Math.round(signal.target1);
            const target2 = Math.round(signal.target2);
            const target3 = Math.round(signal.target3);

            // Use signal's actual date+time from candle data
            // signal.date contains the full timestamp from the candle
            const signalTimestamp =
              signal.date || parseSignalTimeToDate(targetDate, signal.time);

            const createdTrade =
              await this.paperTradingService.createPaperTrade({
                userId: broker.userId,
                brokerId: broker.id,
                symbol: option.symbol,
                optionSymbol: option.tradingsymbol,
                instrumentToken: option.instrumentToken,
                strike: option.strike,
                optionType: option.optionType,
                expiryDate: expiry,
                signalType: signal.recommendation,
                strategy: strategy,
                signalReason: signal.reason,
                entryPrice: entryPrice,
                entryTime: signalTimestamp, // Use signal's actual timestamp
                stopLoss: stopLoss,
                target1: target1,
                target2: target2,
                target3: target3,
                quantity: 1,
                marginPoints: marginPoints,
                interval: interval,
              });

            this.logger.log(
              `✅ Auto-created paper trade: ${option.tradingsymbol} ${signal.recommendation} @ ${entryPrice} (Signal time: ${signal.time})`,
            );

            // Attach the paper trade ID to the signal object so the SCHEDULER
            // can mark it as traded AFTER saveSignal() persists it to the DB.
            // (Calling markSignalAsTradedByDetails here runs before the signal
            //  row exists, so the update finds nothing and tradeCreated stays false.)
            signal.paperTradeId = createdTrade.id;

            // Check if analyzing historical data (past date)
            const targetDateObj = new Date(targetDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const isHistoricalData = targetDateObj < today;

            if (
              isHistoricalData &&
              option.candles &&
              option.candles.length > 0
            ) {
              this.logger.log(
                `📊 Historical data detected. Scanning ${option.candles.length} candles for SL/Target hits...`,
              );

              // Find the signal index in the option's candle data
              const signalIndex = option.candles.findIndex((c: any) => {
                const candleTime = new Date(c.date).toLocaleTimeString(
                  'en-IN',
                  {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true,
                  },
                );
                return candleTime === signal.time;
              });

              if (signalIndex >= 0 && signalIndex < option.candles.length - 1) {
                // Scan subsequent candles
                for (let i = signalIndex + 1; i < option.candles.length; i++) {
                  const candle = option.candles[i];
                  const candleHigh = candle.high;
                  const candleLow = candle.low;
                  const candleClose = candle.close;
                  const candleDate = new Date(candle.date);

                  let shouldClose = false;
                  let exitPrice = candleClose;
                  let newStatus: any;

                  if (signal.recommendation === 'SELL') {
                    // For SELL: SL uses candle.high (stop orders trigger on wick touch).
                    // Targets use candle.close to avoid false triggers from wick spikes.
                    if (candleHigh >= stopLoss) {
                      shouldClose = true;
                      exitPrice = stopLoss;
                      newStatus = 'CLOSED_SL';
                      this.logger.log(
                        `🛑 SL HIT: ${option.tradingsymbol} at ${exitPrice} (candle high: ${candleHigh})`,
                      );
                    } else if (candleClose <= target3) {
                      shouldClose = true;
                      exitPrice = target3;
                      newStatus = 'CLOSED_TARGET3';
                      this.logger.log(
                        `🎯 TARGET3 HIT: ${option.tradingsymbol} at ${exitPrice} (candle close: ${candleClose})`,
                      );
                    } else if (candleClose <= target2) {
                      shouldClose = true;
                      exitPrice = target2;
                      newStatus = 'CLOSED_TARGET2';
                      this.logger.log(
                        `🎯 TARGET2 HIT: ${option.tradingsymbol} at ${exitPrice} (candle close: ${candleClose})`,
                      );
                    } else if (candleClose <= target1) {
                      shouldClose = true;
                      exitPrice = target1;
                      newStatus = 'CLOSED_TARGET1';
                      this.logger.log(
                        `🎯 TARGET1 HIT: ${option.tradingsymbol} at ${exitPrice} (candle close: ${candleClose})`,
                      );
                    }
                  } else {
                    // For BUY: SL uses candle.low (stop orders trigger on wick touch).
                    // Targets use candle.close to avoid false triggers from wick spikes.
                    if (candleLow <= stopLoss) {
                      shouldClose = true;
                      exitPrice = stopLoss;
                      newStatus = 'CLOSED_SL';
                      this.logger.log(
                        `🛑 SL HIT: ${option.tradingsymbol} at ${exitPrice} (candle low: ${candleLow})`,
                      );
                    } else if (candleClose >= target3) {
                      shouldClose = true;
                      exitPrice = target3;
                      newStatus = 'CLOSED_TARGET3';
                      this.logger.log(
                        `🎯 TARGET3 HIT: ${option.tradingsymbol} at ${exitPrice} (candle close: ${candleClose})`,
                      );
                    } else if (candleClose >= target2) {
                      shouldClose = true;
                      exitPrice = target2;
                      newStatus = 'CLOSED_TARGET2';
                      this.logger.log(
                        `🎯 TARGET2 HIT: ${option.tradingsymbol} at ${exitPrice} (candle close: ${candleClose})`,
                      );
                    } else if (candleClose >= target1) {
                      shouldClose = true;
                      exitPrice = target1;
                      newStatus = 'CLOSED_TARGET1';
                      this.logger.log(
                        `🎯 TARGET1 HIT: ${option.tradingsymbol} at ${exitPrice} (candle close: ${candleClose})`,
                      );
                    }
                  }

                  if (shouldClose) {
                    // Close the trade with the candle's price and timestamp
                    await this.paperTradingService.closeTrade(
                      createdTrade.id,
                      exitPrice,
                      newStatus,
                      candleDate, // Pass the candle's timestamp
                    );
                    break; // Stop scanning after closure
                  }
                }
              }
            }
          } catch (err: any) {
            this.logger.error(
              `Failed to auto-create paper trade for ${option.tradingsymbol}: ${err.message}`,
            );
          }
        }
      } else if (!canTrade.canTrade) {
        this.logger.log(`Auto-trading blocked: ${canTrade.reason}`);
      }

      // Return results even if empty - frontend will show appropriate message
      return { options: results, selectedInstruments: limitedInstruments };
    } catch (err: any) {
      this.logger.error('Failed to fetch option monitor data', err);

      // Provide user-friendly error messages
      if (
        err.message?.includes('api_key') ||
        err.message?.includes('access_token')
      ) {
        throw new Error(
          'Authentication failed. Please reconnect your broker account.',
        );
      } else if (err.message?.includes('Broker not found')) {
        throw err;
      } else if (err.message?.includes('API key not configured')) {
        throw err;
      } else if (err.message?.includes('Access token missing')) {
        throw err;
      } else if (err.message?.includes('No data')) {
        throw new Error('No market data available for the selected date/time.');
      }

      throw new Error(err?.message || 'Failed to fetch option monitor data');
    }
  }

  /**
   * Strategy Backtesting: Test strategy over a date range and generate performance report
   */
  async strategyBacktest(
    brokerId: string,
    symbol: string,
    expiry: string,
    strategy:
      | 'PREV_DAY_HIGH_LOW'
      | '20_EMA'
      | 'DAY_SELLING'
      | 'DAY_SELLING_V2'
      | 'DAY_SELLING_V2_ENHANCED'
      | 'DAY_SELLING_V1V2'
      | 'DAY_SELLING_V3'
      | 'DAY_BUYING'
      | 'SMART_SELL'
      | 'TREND_NIFTY',
    startDate: string,
    endDate: string,
    interval: 'minute' | '5minute' | '15minute' | '30minute' | '60minute',
    marginPoints: number,
  ) {
    this.logger.log(
      `Starting backtest: ${strategy} for ${symbol} from ${startDate} to ${endDate}`,
    );

    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not found or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    // Generate date range (trading days only - Mon-Fri)
    const tradingDays: string[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) {
        // Skip weekends
        tradingDays.push(d.toISOString().split('T')[0]);
      }
    }

    this.logger.log(`Testing ${tradingDays.length} trading days`);

    // Collect all trades across all days
    const allTrades: Array<{
      date: string;
      time: string;
      optionType: 'CE' | 'PE';
      strike: number;
      entry: number;
      stopLoss: number;
      target: number;
      risk: number;
      outcome: 'SL_HIT' | 'TARGET_HIT' | 'OPEN';
      pnl: number;
    }> = [];

    // Run strategy for each trading day
    for (const date of tradingDays) {
      try {
        this.logger.log(`Testing ${date}...`);

        // Run option monitor for this date
        const result = await this.optionMonitor(
          brokerId,
          symbol,
          expiry,
          marginPoints,
          date,
          interval,
          '15:30', // Full day
          strategy,
        );

        this.logger.log(
          `Date ${date}: Found ${result.options?.length || 0} options`,
        );

        if (!result.options || result.options.length === 0) {
          this.logger.debug(`No options returned for ${date}`);
          continue;
        }

        const totalSignals = result.options.reduce(
          (sum, opt) => sum + (opt.signals?.length || 0),
          0,
        );
        this.logger.log(
          `Date ${date}: Total signals across all options: ${totalSignals}`,
        );

        if (totalSignals === 0) {
          this.logger.debug(`No signals found in options for ${date}`);
          continue;
        }

        // Process each option's signals
        for (const option of result.options) {
          if (!option.signals || option.signals.length === 0) continue;

          // Get full day candles for this option to check outcomes
          const chartData = await this.getOptionChartData(
            brokerId,
            option.instrumentToken.toString(),
            date,
            interval,
            strategy,
            marginPoints,
          );

          // Check each signal's outcome
          for (const signal of option.signals) {
            const entry = signal.price;
            const stopLoss = signal.stopLoss;
            const target = signal.target1 || signal.target;
            const risk = stopLoss - entry;

            let outcome: 'SL_HIT' | 'TARGET_HIT' | 'OPEN' = 'OPEN';
            let pnl = 0;

            this.logger.debug(
              `Checking outcome for signal: Entry=${entry}, SL=${stopLoss}, Target=${target}, SignalTime=${signal.time}, Timestamp=${signal.timestamp}`,
            );

            // Find the signal candle in chartData by matching timestamp
            const signalIndex = chartData.candles.findIndex((c: any) => {
              // c.time is already a Unix timestamp in seconds (with IST offset)
              const candleTime = c.time;
              const signalTimeInSeconds = signal.timestamp || 0; // Use numeric timestamp (already has IST offset)
              return Math.abs(candleTime - signalTimeInSeconds) < 300; // Within 5 min
            });

            this.logger.debug(
              `Found signal in chartData at index ${signalIndex}`,
            );

            if (signalIndex >= 0 && signalIndex < chartData.candles.length) {
              // Check subsequent candles for SL or Target hit
              for (let i = signalIndex + 1; i < chartData.candles.length; i++) {
                const candle = chartData.candles[i];

                // For SELL trades
                if (candle.high >= stopLoss) {
                  outcome = 'SL_HIT';
                  pnl = -(stopLoss - entry); // Loss
                  this.logger.debug(
                    `SL HIT at candle ${i}: High=${candle.high} >= SL=${stopLoss}, Loss=${pnl}`,
                  );
                  break;
                } else if (candle.low <= target) {
                  outcome = 'TARGET_HIT';
                  pnl = entry - target; // Profit
                  this.logger.debug(
                    `TARGET HIT at candle ${i}: Low=${candle.low} <= Target=${target}, Profit=${pnl}`,
                  );
                  break;
                }
              }
            } else {
              this.logger.warn(
                `Signal not found in candles. SignalTime=${signal.time}, Timestamp=${signal.timestamp}, First candle time=${chartData.candles[0]?.time}`,
              );
            }

            allTrades.push({
              date,
              time: signal.time || '',
              optionType: option.optionType,
              strike: option.strike,
              entry,
              stopLoss,
              target,
              risk,
              outcome,
              pnl,
            });
          }
        }

        // Small delay to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        this.logger.warn(`Error testing ${date}: ${err.message}`);
      }
    }

    // Generate report
    const totalTrades = allTrades.length;
    const slHits = allTrades.filter((t) => t.outcome === 'SL_HIT').length;
    const targetHits = allTrades.filter(
      (t) => t.outcome === 'TARGET_HIT',
    ).length;
    const openTrades = allTrades.filter((t) => t.outcome === 'OPEN').length;
    const winRate = totalTrades > 0 ? (targetHits / totalTrades) * 100 : 0;
    const totalProfit = allTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgProfitPerTrade = totalTrades > 0 ? totalProfit / totalTrades : 0;

    // Weekly breakdown
    const weeklyData: Record<
      string,
      { trades: number; profit: number; wins: number; losses: number }
    > = {};
    allTrades.forEach((trade) => {
      const date = new Date(trade.date);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay() + 1); // Monday
      const weekKey = weekStart.toISOString().split('T')[0];

      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = { trades: 0, profit: 0, wins: 0, losses: 0 };
      }

      weeklyData[weekKey].trades++;
      weeklyData[weekKey].profit += trade.pnl;
      if (trade.outcome === 'TARGET_HIT') weeklyData[weekKey].wins++;
      if (trade.outcome === 'SL_HIT') weeklyData[weekKey].losses++;
    });

    // Monthly breakdown
    const monthlyData: Record<
      string,
      { trades: number; profit: number; wins: number; losses: number }
    > = {};
    allTrades.forEach((trade) => {
      const monthKey = trade.date.substring(0, 7); // YYYY-MM

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { trades: 0, profit: 0, wins: 0, losses: 0 };
      }

      monthlyData[monthKey].trades++;
      monthlyData[monthKey].profit += trade.pnl;
      if (trade.outcome === 'TARGET_HIT') monthlyData[monthKey].wins++;
      if (trade.outcome === 'SL_HIT') monthlyData[monthKey].losses++;
    });

    this.logger.log(
      `Backtest complete: ${totalTrades} trades, ${targetHits} wins, ${slHits} losses, Win Rate: ${winRate.toFixed(2)}%, Total P&L: ${totalProfit.toFixed(2)}`,
    );

    return {
      strategy,
      symbol,
      dateRange: { startDate, endDate },
      tradingDays: tradingDays.length,
      summary: {
        totalTrades,
        targetHits,
        slHits,
        openTrades,
        winRate: Math.round(winRate * 100) / 100,
        totalProfit: Math.round(totalProfit * 100) / 100,
        avgProfitPerTrade: Math.round(avgProfitPerTrade * 100) / 100,
      },
      weeklyBreakdown: Object.entries(weeklyData).map(([week, data]) => ({
        week,
        ...data,
        profit: Math.round(data.profit * 100) / 100,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
      })),
      monthlyBreakdown: Object.entries(monthlyData).map(([month, data]) => ({
        month,
        ...data,
        profit: Math.round(data.profit * 100) / 100,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
      })),
      allTrades: allTrades.map((t) => ({
        ...t,
        pnl: Math.round(t.pnl * 100) / 100,
        risk: Math.round(t.risk * 100) / 100,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SIMULATE AUTO TRADE DAY
  // Paper-trade simulation: runs DAY_SELLING full-day scan, applies 2-trade
  // logic with configurable SL pts (default 30) / Target = SL*2 (1:2 RRR), returns P&L.
  // ─────────────────────────────────────────────────────────────────────────────

  async simulateAutoTradeDay(
    brokerId: string,
    targetDate?: string,
    interval:
      | 'minute'
      | '3minute'
      | '5minute'
      | '10minute'
      | '15minute'
      | '30minute'
      | '60minute' = 'minute',
    slPts: number = 30,
    mode: 'live' | 'historical' = 'historical',
  ): Promise<any> {
    const date = targetDate || new Date().toISOString().split('T')[0];
    const cap = 2; // max 2 trades per day
    const LOT_SIZE = 75;
    const FIXED_SL_PTS = slPts;
    const FIXED_TARGET_PTS = slPts * 2;

    // ── Broker / KiteConnect ────────────────────────────────────────────────
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });
    if (!broker?.accessToken) {
      throw new Error('Broker not found or access token missing.');
    }
    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    // ── Nearest expiry for the SIMULATED date from the Instrument DB ────────
    // We query our own DB (updated daily) for the nearest NIFTY expiry that
    // is on or after the simulation date.  This automatically handles weekly
    // Tuesday expiries AND monthly expiries without any hard-coded weekday.
    const nextExpiry = await this.getSimulationExpiry(date);
    this.logger.log(
      `[SIM] Resolved expiry for ${date} → ${nextExpiry} (from DB)`,
    );

    // ── Full-day DAY_SELLING scan (NOT realtime — scan all candles) ──────────
    this.logger.log(
      `[SIM] Running full-day DAY_SELLING scan for ${date} expiry=${nextExpiry}`,
    );
    const monitor = await this.optionMonitor(
      brokerId,
      'NIFTY',
      nextExpiry,
      20,
      date,
      interval,
      '15:30',
      'DAY_SELLING',
      false, // realtimeMode
      mode === 'historical' ? 'db' : 'live', // instrumentSource
    );

    // ── Collect & sort all signals across all options ────────────────────────
    const allSignals: Array<{ option: any; signal: any }> = [];
    for (const option of monitor.options || []) {
      for (const signal of option.signals || []) {
        allSignals.push({ option, signal });
      }
    }
    allSignals.sort(
      (a, b) => (a.signal.timestamp || 0) - (b.signal.timestamp || 0),
    );

    this.logger.log(
      `[SIM] Total signals found: ${allSignals.length} across ${monitor.options?.length || 0} options`,
    );

    // ── Pick max N trades (unique option symbol, in chronological order) ─────
    const pickedTrades: Array<{ option: any; signal: any }> = [];
    const usedSymbols = new Set<string>();
    for (const item of allSignals) {
      if (pickedTrades.length >= cap) break;
      if (usedSymbols.has(item.option.tradingsymbol)) continue;
      usedSymbols.add(item.option.tradingsymbol);
      pickedTrades.push(item);
    }

    if (pickedTrades.length === 0) {
      return {
        date,
        expiry: nextExpiry,
        message: 'No signals found for today.',
        trades: [],
        summary: { totalTrades: 0, totalPnl: 0, totalPnlFormatted: '₹0' },
      };
    }

    // ── Simulate each trade ──────────────────────────────────────────────────
    const results: any[] = [];

    for (let tradeIdx = 0; tradeIdx < pickedTrades.length; tradeIdx++) {
      const { option, signal } = pickedTrades[tradeIdx];
      const entry = signal.price as number;
      const sl = Math.round(entry + FIXED_SL_PTS);
      const target = Math.max(Math.round(entry - FIXED_TARGET_PTS), 1);
      const lotSize = option.lotSize || LOT_SIZE;

      // Parse signal time string e.g. "09:35 am" into a JS Date in IST
      const signalDateIST = parseSignalTimeToDate(date, signal.time as string);

      const tradeBase = {
        tradeNo: tradeIdx + 1,
        optionSymbol: option.tradingsymbol,
        strike: option.strike,
        optionType: option.optionType,
        signalTime: signal.time,
        signalReason: signal.reason,
        entry,
        sl,
        target,
        lotSize,
      };

      // ── Fetch 1-min candles from signal time to 15:30 ───────────────────────
      const fromDate = signalDateIST;
      const toDateIST = new Date(date + 'T10:00:00.000Z'); // 15:30 IST = 10:00 UTC
      let exitReason = 'OPEN';
      let exitPrice = entry;
      let exitTime = '15:30 pm';
      // BE state: after T1 hit, SL moves to entry
      let t1HitSim = false;
      let activeSL = sl; // may change to entry after T1

      // If there is a next trade, record its signal arrival time so we close
      // the current trade at ITS OWN candle price at that moment.
      let nextTradeSignalDate: Date | null = null;
      if (tradeIdx < pickedTrades.length - 1) {
        nextTradeSignalDate = parseSignalTimeToDate(
          date,
          pickedTrades[tradeIdx + 1].signal.time as string,
        );
      }

      try {
        const candles: any[] = await kc.getHistoricalData(
          option.instrumentToken,
          interval,
          fromDate,
          toDateIST,
          false,
        );

        this.logger.log(
          `[SIM] Trade ${tradeIdx + 1}: ${option.tradingsymbol} — ${candles.length} candles after signal`,
        );

        // ── Walk candles: SL / Target / BE / Trade-2-replacement ─────────────
        for (const candle of candles) {
          const candleDate = new Date(candle.date);

          // Next trade signal arrives → close this trade at THIS candle's close price
          if (
            nextTradeSignalDate &&
            candleDate >= nextTradeSignalDate &&
            exitReason === 'OPEN'
          ) {
            exitReason = `REPLACED_BY_TRADE_${tradeIdx + 2}`;
            exitPrice = candle.close;
            exitTime = new Date(candle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            break;
          }

          // SL hit (or BE hit after T1): option price rises to activeSL
          if (candle.high >= activeSL) {
            exitReason = t1HitSim ? 'BE_HIT' : 'SL_HIT';
            exitPrice = activeSL; // SL price or entry price (for BE)
            exitTime = new Date(candle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            break;
          }

          // Target hit: option price closes at or below target (profit for short seller).
          // Use candle.close not candle.low to avoid false triggers from wick spikes.
          if (candle.close <= target) {
            if (!t1HitSim) {
              // T1 hit — activate BE: move SL to entry, keep trade open
              t1HitSim = true;
              activeSL = entry;
              this.logger.log(
                `[SIM] T1 hit for ${option.tradingsymbol} — BE active, SL moved to entry ${entry}`,
              );
            } else {
              // Already past T1, target hit again means T2 or full target
              exitReason = 'TARGET_HIT';
              exitPrice = target;
              exitTime = new Date(candle.date).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              });
              break;
            }
          }
        }

        // If still open after full scan:
        // - If last candle is before 15:25 IST AND date is today → market still open, trade is OPEN/RUNNING
        // - Otherwise → market closed, it's a genuine EOD square-off
        if (exitReason === 'OPEN' && candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          const lastCandleDate = new Date(lastCandle.date);
          const lastCandleIST = new Date(
            lastCandleDate.getTime() + 5.5 * 60 * 60 * 1000,
          );
          const lastCandleHour = lastCandleIST.getUTCHours();
          const lastCandleMin = lastCandleIST.getUTCMinutes();
          const isMarketClosed =
            lastCandleHour > 15 ||
            (lastCandleHour === 15 && lastCandleMin >= 25);

          const today = new Date().toISOString().split('T')[0];
          const isToday = date === today;

          if (!isMarketClosed && isToday) {
            // Market still open — trade is running, don't fake an EOD exit
            exitReason = 'OPEN';
            exitPrice = lastCandle.close;
            exitTime = new Date(lastCandle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
          } else {
            // T1 was hit but price never reached BE or T2 → partial profit at T1 + EOD remaining
            exitReason = t1HitSim ? 'T1_EOD' : 'EOD_CLOSE';
            exitPrice = lastCandle.close;
            exitTime = new Date(lastCandle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `[SIM] Failed to fetch candles for ${option.tradingsymbol}: ${err.message}`,
        );
        exitReason = 'DATA_ERROR';
      }

      // ── Compute P&L ─────────────────────────────────────────────────────────
      // If T1 was hit, 50% of qty was exited at T1 price; remainder at exitPrice.
      let pnl: number;
      let pnlPerUnit: number;
      if (t1HitSim) {
        const halfQty = Math.floor(lotSize / 2);
        const remainQty = lotSize - halfQty;
        // Half qty locked at T1 profit; remaining qty exits at current exitPrice
        const t1Profit = (entry - target) * halfQty;
        const remainProfit =
          exitReason === 'BE_HIT'
            ? 0 // exited at entry — zero profit on remainder
            : (entry - exitPrice) * remainQty;
        pnl = Math.round((t1Profit + remainProfit) * 100) / 100;
        // Effective per-unit (for display)
        pnlPerUnit = Math.round((pnl / lotSize) * 100) / 100;
      } else {
        pnlPerUnit = entry - exitPrice; // SELL: profit when option price falls
        pnl = Math.round(pnlPerUnit * lotSize * 100) / 100;
        pnlPerUnit = Math.round(pnlPerUnit * 100) / 100;
      }

      results.push({
        ...tradeBase,
        exitReason,
        exitTime,
        exitPrice,
        pnlPerUnit,
        pnl,
        pnlFormatted: `${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`,
      });
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    const totalPnl =
      Math.round(results.reduce((sum, t) => sum + (t.pnl || 0), 0) * 100) / 100;

    return {
      date,
      expiry: nextExpiry,
      totalSignalsFound: allSignals.length,
      trades: results,
      summary: {
        totalTrades: results.length,
        wins: results.filter((t) => t.pnl > 0).length,
        losses: results.filter((t) => t.pnl < 0).length,
        totalPnl,
        totalPnlFormatted: `${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(2)}`,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SIMULATE AUTO TRADE RANGE
  // Runs simulateAutoTradeDay for every weekday in [startDate, endDate] and
  // aggregates results into daily / weekly / monthly breakdowns.
  // ─────────────────────────────────────────────────────────────────────────────

  async simulateAutoTradeRange(
    brokerId: string,
    startDate: string,
    endDate: string,
    interval:
      | 'minute'
      | '3minute'
      | '5minute'
      | '10minute'
      | '15minute'
      | '30minute'
      | '60minute' = 'minute',
    slPts: number = 30,
    mode: 'live' | 'historical' = 'historical',
  ): Promise<any> {
    // ── Build list of weekday dates in range ─────────────────────────────────
    const days: string[] = [];
    const cursor = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    while (cursor <= end) {
      const dow = cursor.getUTCDay(); // 0=Sun 6=Sat
      if (dow !== 0 && dow !== 6) {
        days.push(cursor.toISOString().split('T')[0]);
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    if (days.length === 0) {
      return {
        startDate,
        endDate,
        days: [],
        weeklyBreakdown: [],
        monthlyBreakdown: [],
        summary: {
          totalDays: 0,
          tradingDays: 0,
          totalTrades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalPnl: 0,
          totalPnlFormatted: '₹0',
        },
      };
    }

    this.logger.log(
      `[SIM RANGE] Running ${days.length} days from ${startDate} to ${endDate} (interval=${interval}, slPts=${slPts})`,
    );

    // ── Run each day sequentially ─────────────────────────────────────────────
    const dayResults: any[] = [];
    for (const day of days) {
      try {
        const result = await this.simulateAutoTradeDay(
          brokerId,
          day,
          interval,
          slPts,
          mode,
        );
        dayResults.push(result);
        this.logger.log(
          `[SIM RANGE] ${day}: ${result.summary.totalTrades} trades, P&L=${result.summary.totalPnlFormatted}`,
        );
      } catch (err: any) {
        this.logger.warn(`[SIM RANGE] ${day}: failed — ${err.message}`);
        dayResults.push({
          date: day,
          trades: [],
          totalSignalsFound: 0,
          summary: {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            totalPnl: 0,
            totalPnlFormatted: '₹0',
          },
          error: err.message,
        });
      }
    }

    // ── Weekly aggregation ────────────────────────────────────────────────────
    const weekMap = new Map<
      string,
      { trades: number; wins: number; losses: number; pnl: number }
    >();
    for (const d of dayResults) {
      const dateObj = new Date(d.date + 'T00:00:00Z');
      // ISO week: Mon=1..Sun=7
      const day1 = new Date(Date.UTC(dateObj.getUTCFullYear(), 0, 4));
      const weekNo = Math.ceil(
        ((dateObj.getTime() - day1.getTime()) / 86400000 +
          day1.getUTCDay() +
          1) /
          7,
      );
      const weekKey = `${dateObj.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
      const existing = weekMap.get(weekKey) || {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
      };
      weekMap.set(weekKey, {
        trades: existing.trades + (d.summary.totalTrades || 0),
        wins: existing.wins + (d.summary.wins || 0),
        losses: existing.losses + (d.summary.losses || 0),
        pnl: Math.round((existing.pnl + (d.summary.totalPnl || 0)) * 100) / 100,
      });
    }
    const weeklyBreakdown = Array.from(weekMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, data]) => ({
        week,
        ...data,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
        pnlFormatted: `${data.pnl >= 0 ? '+' : ''}₹${data.pnl.toFixed(2)}`,
      }));

    // ── Monthly aggregation ───────────────────────────────────────────────────
    const monthMap = new Map<
      string,
      {
        days: number;
        trades: number;
        wins: number;
        losses: number;
        pnl: number;
      }
    >();
    for (const d of dayResults) {
      const monthKey = d.date.slice(0, 7); // YYYY-MM
      const existing = monthMap.get(monthKey) || {
        days: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
      };
      monthMap.set(monthKey, {
        days: existing.days + 1,
        trades: existing.trades + (d.summary.totalTrades || 0),
        wins: existing.wins + (d.summary.wins || 0),
        losses: existing.losses + (d.summary.losses || 0),
        pnl: Math.round((existing.pnl + (d.summary.totalPnl || 0)) * 100) / 100,
      });
    }
    const monthlyBreakdown = Array.from(monthMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, data]) => ({
        month,
        monthLabel: new Date(month + '-01').toLocaleDateString('en-IN', {
          month: 'long',
          year: 'numeric',
        }),
        ...data,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
        pnlFormatted: `${data.pnl >= 0 ? '+' : ''}₹${data.pnl.toFixed(2)}`,
      }));

    // ── Overall summary ───────────────────────────────────────────────────────
    const totalTrades = dayResults.reduce(
      (s, d) => s + (d.summary.totalTrades || 0),
      0,
    );
    const totalWins = dayResults.reduce((s, d) => s + (d.summary.wins || 0), 0);
    const totalLosses = dayResults.reduce(
      (s, d) => s + (d.summary.losses || 0),
      0,
    );
    const totalPnl =
      Math.round(
        dayResults.reduce((s, d) => s + (d.summary.totalPnl || 0), 0) * 100,
      ) / 100;
    const tradingDays = dayResults.filter(
      (d) => d.summary.totalTrades > 0,
    ).length;

    // Max single-day drawdown
    const maxDayLoss = Math.min(
      ...dayResults.map((d) => d.summary.totalPnl || 0),
      0,
    );

    return {
      startDate,
      endDate,
      days: dayResults,
      weeklyBreakdown,
      monthlyBreakdown,
      summary: {
        totalDays: days.length,
        tradingDays,
        totalTrades,
        wins: totalWins,
        losses: totalLosses,
        winRate:
          totalTrades > 0
            ? Math.round((totalWins / totalTrades) * 10000) / 100
            : 0,
        totalPnl,
        totalPnlFormatted: `${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(2)}`,
        maxDayLoss: Math.round(maxDayLoss * 100) / 100,
        avgPnlPerTradingDay:
          tradingDays > 0
            ? Math.round((totalPnl / tradingDays) * 100) / 100
            : 0,
      },
    };
  }
}

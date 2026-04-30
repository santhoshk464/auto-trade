import {
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  Req,
  Logger,
  Header,
} from '@nestjs/common';
import {
  AuthGuard,
  type AuthenticatedRequest,
} from '../../auth/guards/auth.guard';
import { KiteService } from '../services/kite.service';
import { TradingService } from '../services/trading.service';
import { SignalsService } from '../services/signals.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KiteScheduler } from '../schedulers/kite.scheduler';

@Controller('kite')
@UseGuards(AuthGuard)
export class KiteController {
  private readonly logger = new Logger(KiteController.name);

  constructor(
    private kiteService: KiteService,
    private tradingService: TradingService,
    private signalsService: SignalsService,
    private prisma: PrismaService,
    private kiteScheduler: KiteScheduler,
  ) {}

  /**
   * GET /kite/expiry-dates?exchange=NSE&symbol=NIFTY&segment=Options
   * Returns list of available expiry dates for options or futures.
   */
  @Get('expiry-dates')
  async getExpiryDates(
    @Query('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('segment') segment?: string,
  ) {
    this.logger.log(
      `GET /kite/expiry-dates exchange=${exchange} symbol=${symbol} segment=${segment}`,
    );
    if (!exchange || !symbol) {
      return { expiries: [] };
    }
    const result = await this.kiteService.getExpiryDates(
      exchange,
      symbol,
      segment,
    );
    this.logger.log(`Returning ${result.expiries.length} expiries`);
    return result;
  }

  /**
   * GET /kite/strikes?exchange=NSE&symbol=NIFTY&expiry=2025-12-26
   * Returns list of available strike prices.
   */
  @Get('strikes')
  async getStrikes(
    @Query('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('expiry') expiry: string,
  ) {
    if (!exchange || !symbol || !expiry) {
      return { strikes: [] };
    }
    return this.kiteService.getStrikes(exchange, symbol, expiry);
  }

  /**
   * GET /kite/lot-size?exchange=NSE&symbol=NIFTY&segment=Options&expiry=2025-12-26&strike=24500
   * Returns lot size for a symbol.
   */
  @Get('lot-size')
  async getLotSize(
    @Query('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('segment') segment?: string,
    @Query('expiry') expiry?: string,
    @Query('strike') strike?: string,
  ) {
    if (!exchange || !symbol) {
      return { lotSize: 1 };
    }
    return this.kiteService.getLotSize(
      exchange,
      symbol,
      segment,
      expiry,
      strike ? parseFloat(strike) : undefined,
    );
  }

  /**
   * GET /kite/quote?brokerId=...&exchange=NSE&tradingsymbol=NIFTY25DEC24500CE
   * Returns quote (LTP, etc.) for a specific instrument.
   */
  @Get('quote')
  async getQuote(
    @Query('brokerId') brokerId: string,
    @Query('exchange') exchange: string,
    @Query('tradingsymbol') tradingsymbol: string,
  ) {
    if (!brokerId || !exchange || !tradingsymbol) {
      return { error: 'Missing parameters' };
    }
    const quote = await this.kiteService.getQuote(
      brokerId,
      exchange,
      tradingsymbol,
    );
    return quote || { error: 'Quote not found' };
  }

  /**
   * POST /kite/quotes
   * Body: { brokerId, instruments: [{ exchange, tradingsymbol }] }
   * Returns batch quotes.
   */
  @Post('quotes')
  async getQuotes(
    @Body()
    body: {
      brokerId: string;
      instruments: Array<{ exchange: string; tradingsymbol: string }>;
    },
  ) {
    if (!body.brokerId || !body.instruments || body.instruments.length === 0) {
      return { quotes: [] };
    }
    const quotes = await this.kiteService.getQuotes(
      body.brokerId,
      body.instruments,
    );
    return { quotes };
  }

  /**
   * POST /kite/quotes-by-tokens
   * Body: { brokerId, instrumentTokens: [123, 456] }
   * Returns batch quotes by instrument tokens (more efficient for paper trading).
   */
  @Post('quotes-by-tokens')
  async getQuotesByTokens(
    @Body()
    body: {
      brokerId: string;
      instrumentTokens: number[];
    },
  ) {
    if (
      !body.brokerId ||
      !body.instrumentTokens ||
      body.instrumentTokens.length === 0
    ) {
      return { quotes: [] };
    }
    const quotes = await this.kiteService.getQuotesByTokens(
      body.brokerId,
      body.instrumentTokens,
    );
    return { quotes };
  }

  /**
   * POST /kite/option-quotes
   * Body: { brokerId, symbol, exchange, expiry, callStrike, putStrike }
   * Returns quotes for call, put, and underlying.
   */
  @Post('option-quotes')
  async getOptionQuotes(
    @Body()
    body: {
      brokerId: string;
      symbol: string;
      exchange: string;
      expiry: string;
      callStrike: number;
      putStrike: number;
    },
  ) {
    if (
      !body.brokerId ||
      !body.symbol ||
      !body.exchange ||
      !body.expiry ||
      !body.callStrike ||
      !body.putStrike
    ) {
      return { quotes: [] };
    }
    const quotes = await this.kiteService.getOptionQuotes(
      body.brokerId,
      body.symbol,
      body.exchange,
      body.expiry,
      body.callStrike,
      body.putStrike,
    );
    return { quotes };
  }

  /**
   * POST /kite/ws-credentials
   * Returns WebSocket credentials (API key and access token) for the broker.
   */
  @Post('ws-credentials')
  async getWebSocketCredentials(@Body() body: { brokerId: string }) {
    if (!body.brokerId) {
      return { apiKey: null, accessToken: null };
    }
    const credentials = await this.kiteService.getWebSocketCredentials(
      body.brokerId,
    );
    return credentials;
  }

  /**
   * POST /kite/options-analysis
   * Body: { brokerId, exchange, symbol, expiry, strategy, date }
   * Returns underlying + option chain OHLC/LTP used by Options Analysis page.
   */
  @Post('options-analysis')
  async getOptionsAnalysis(
    @Body()
    body: {
      brokerId: string;
      exchange: string;
      symbol: string;
      expiry: string;
      strategy?: 'OPEN_HIGH' | 'OPEN_LOW';
      date?: string; // YYYY-MM-DD (reserved for future historical support)
    },
  ) {
    const { brokerId, exchange, symbol, expiry } = body;
    if (!brokerId || !exchange || !symbol || !expiry) {
      return { underlying: null, rows: [] };
    }

    return this.kiteService.getOptionsAnalysis({
      brokerId,
      exchange,
      symbol,
      expiry,
      strategy: body.strategy,
      date: body.date,
    });
  }

  /**
   * GET /kite/positions?brokerId=...
   * Returns positions from broker.
   */
  @Get('positions')
  async getPositions(@Query('brokerId') brokerId: string) {
    if (!brokerId) {
      return { net: [], day: [] };
    }
    return this.kiteService.getPositions(brokerId);
  }

  /**
   * GET /kite/orders?brokerId=...
   * Returns order book from broker.
   */
  @Get('orders')
  async getOrders(@Query('brokerId') brokerId: string) {
    if (!brokerId) {
      return { orders: [] };
    }
    return this.kiteService.getOrders(brokerId);
  }

  /**
   * GET /kite/trades?brokerId=...
   * Returns trade book from broker.
   */
  @Get('trades')
  async getTrades(@Query('brokerId') brokerId: string) {
    if (!brokerId) {
      return { trades: [] };
    }
    return this.kiteService.getTrades(brokerId);
  }

  /**
   * GET /kite/holdings?brokerId=...
   * Returns holdings from broker.
   */
  @Get('holdings')
  async getHoldings(@Query('brokerId') brokerId: string) {
    if (!brokerId) {
      return { holdings: [] };
    }
    return this.kiteService.getHoldings(brokerId);
  }

  /**
   * GET /kite/margins?brokerId=...
   * Returns margin/funds data from broker.
   */
  @Get('margins')
  async getMargins(@Query('brokerId') brokerId: string) {
    if (!brokerId) {
      return { equity: null, commodity: null };
    }
    return this.kiteService.getMargins(brokerId);
  }

  /**
   * POST /kite/place-order
   * Place an order through broker.
   */
  @Post('place-order')
  async placeOrder(
    @Body()
    body: {
      brokerId: string;
      tradingsymbol: string;
      exchange: string;
      transactionType: 'BUY' | 'SELL';
      quantity: number;
      product: string;
      orderType: string;
      price?: number;
      triggerPrice?: number;
    },
  ) {
    return this.kiteService.placeOrder(body);
  }

  /**
   * GET /kite/option-monitor?brokerId=...&symbol=NIFTY&expiry=2025-12-26&marginPoints=20&interval=5minute&time=09:15&strategy=PREV_DAY_HIGH_LOW
   * Returns options near yesterday's high or low within margin points at specific time.
   */
  @Get('option-monitor')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async optionMonitor(
    @Query('brokerId') brokerId: string,
    @Query('symbol') symbol: string,
    @Query('expiry') expiry: string,
    @Query('marginPoints') marginPoints?: string,
    @Query('targetDate') targetDate?: string,
    @Query('interval') interval?: string,
    @Query('time') time?: string,
    @Query('strategy') strategy?: string,
    @Query('instrumentSource') instrumentSource?: string,
  ) {
    // Spot mode (symbol ends with _SPOT) requires no expiry — it runs on the index directly
    if (!brokerId || !symbol || (!expiry && !symbol.endsWith('_SPOT'))) {
      return { options: [] };
    }
    const margin = marginPoints ? parseInt(marginPoints, 10) : 20;
    const date = targetDate || new Date().toISOString().split('T')[0];
    const candleInterval = (interval || 'day') as
      | 'day'
      | 'minute'
      | '3minute'
      | '5minute'
      | '10minute'
      | '15minute'
      | '30minute'
      | '60minute';
    const specificTime = time || '15:30'; // Default to market close
    const tradingStrategy = (strategy || 'PREV_DAY_HIGH_LOW') as
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
      | 'DAY_HIGH_REJECTION'
      | 'DAY_LOW_BREAK'
      | 'EMA_REJECTION'
      | 'SUPER_POWER_PACK'
      | 'TRIPLE_SYNC'
      | 'PREV_DAY_HIGH_REJECTION';
    // For today's date: use live instruments (same as the scheduler) so that
    // fresh ATM strikes and valid tokens are used — DB tokens may be stale for
    // today's ATM options.
    // For past dates: use DB instruments (expired contracts are still in DB but
    // no longer served by Kite's live CSV feed).
    // Caller can override with ?instrumentSource=live|db.
    const today = new Date().toISOString().split('T')[0];
    const defaultSource = date === today ? 'live' : 'db';
    const instSource = (
      instrumentSource === 'live' || instrumentSource === 'db'
        ? instrumentSource
        : defaultSource
    ) as 'live' | 'db';

    // Spot mode: skip option instrument resolution
    if (symbol.endsWith('_SPOT')) {
      return this.tradingService.optionMonitor(
        brokerId,
        symbol,
        '',
        margin,
        date,
        candleInterval,
        specificTime,
        tradingStrategy,
        false,
        instSource,
      );
    }

    return this.tradingService.optionMonitor(
      brokerId,
      symbol,
      expiry,
      margin,
      date,
      candleInterval,
      specificTime,
      tradingStrategy,
      false, // realtimeMode = false → scan all candles (full backtest / display mode)
      instSource,
    );
  }

  /**
   * DELETE /kite/signals/today?brokerId=...&strategy=DAY_HIGH_REJECTION
   * Clears today's saved signal tokens for the given broker + strategy so that
   * Trade Finder performs fresh ATM selection on the next query.
   */
  @Delete('signals/today')
  async clearTodaySignals(
    @Query('brokerId') brokerId: string,
    @Query('strategy') strategy?: string,
  ) {
    if (!brokerId) return { deleted: 0 };
    return this.signalsService.clearTodaySignalsForBroker(brokerId, strategy);
  }

  /**
   * GET /kite/locked-strikes?brokerId=...&strategy=DAY_SELLING
   * Returns the currently selected instruments from the StrikeSelection DB.
   * Trade Finder uses this to display which strike is being auto-traded.
   */
  @Get('locked-strikes')
  async getLockedStrikes(
    @Query('brokerId') brokerId: string,
    @Query('strategy') strategy: string,
  ) {
    if (!brokerId) return { locked: false, instruments: [] };
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const symbols = strategy === 'BANKNIFTY' ? ['BANKNIFTY'] : ['NIFTY'];

    const rows = await Promise.all(
      symbols.map((sym) =>
        this.prisma.strikeSelection
          .findUnique({
            where: {
              brokerId_symbol_date: { brokerId, symbol: sym, date: today },
            },
          })
          .catch(() => null),
      ),
    );

    const found = rows.filter(Boolean);
    if (found.length === 0) return { locked: false, instruments: [] };

    const instruments = found.flatMap((row: any) => [
      {
        tradingsymbol: row.ceTradingSymbol,
        strike: row.ceStrike,
        instrument_type: 'CE',
        instrument_token: row.ceInstrumentToken,
      },
      {
        tradingsymbol: row.peTradingSymbol,
        strike: row.peStrike,
        instrument_type: 'PE',
        instrument_token: row.peInstrumentToken,
      },
    ]);

    return {
      locked: true,
      instruments,
      niftySpotAtOpen: found[0]?.niftySpotAtOpen,
      selectedAt: found[0]?.selectedAt,
    };
  }

  /**
   * GET /kite/option-chart-data
   * Returns candle data with EMA and signals for charting
   */
  @Get('option-chart-data')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getOptionChartData(
    @Query('brokerId') brokerId: string,
    @Query('instrumentToken') instrumentToken: string,
    @Query('targetDate') targetDate: string,
    @Query('interval') interval: string,
    @Query('strategy') strategy: string,
    @Query('marginPoints') marginPoints?: string,
  ) {
    if (
      !brokerId ||
      !instrumentToken ||
      !targetDate ||
      !interval ||
      !strategy
    ) {
      throw new Error('Missing required parameters');
    }
    const margin = marginPoints ? parseInt(marginPoints, 10) : 20;
    const candleInterval = interval as
      | 'minute'
      | '5minute'
      | '15minute'
      | '30minute'
      | '60minute';
    const tradingStrategy = strategy as
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
      | 'DAY_HIGH_REJECTION'
      | 'DAY_LOW_BREAK';

    return this.tradingService.getOptionChartData(
      brokerId,
      instrumentToken,
      targetDate,
      candleInterval,
      tradingStrategy,
      margin,
    );
  }

  /**
   * GET /kite/available-expiries?symbol=NIFTY
   * Returns currently available (non-expired) expiry dates for backtesting
   */
  @Get('available-expiries')
  async getAvailableExpiries(@Query('symbol') symbol: string) {
    if (!symbol) {
      return { expiries: [] };
    }
    return this.kiteService.getAvailableExpiries(symbol);
  }

  /**
   * GET /kite/strategy-backtest
   * Returns backtesting report for strategy over a date range
   */
  @Get('strategy-backtest')
  async strategyBacktest(
    @Query('brokerId') brokerId: string,
    @Query('symbol') symbol: string,
    @Query('expiry') expiry: string,
    @Query('strategy') strategy: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('interval') interval?: string,
    @Query('marginPoints') marginPoints?: string,
  ) {
    if (
      !brokerId ||
      !symbol ||
      !expiry ||
      !strategy ||
      !startDate ||
      !endDate
    ) {
      throw new Error('Missing required parameters');
    }

    const margin = marginPoints ? parseInt(marginPoints, 10) : 20;
    const candleInterval = (interval || '5minute') as
      | 'minute'
      | '5minute'
      | '15minute'
      | '30minute'
      | '60minute';
    const tradingStrategy = strategy as
      | 'PREV_DAY_HIGH_LOW'
      | '20_EMA'
      | 'DAY_SELLING'
      | 'DAY_SELLING_V2'
      | 'DAY_SELLING_V2_ENHANCED'
      | 'DAY_SELLING_V1V2'
      | 'DAY_SELLING_V3'
      | 'DAY_BUYING'
      | 'SMART_SELL'
      | 'TREND_NIFTY';

    return this.tradingService.strategyBacktest(
      brokerId,
      symbol,
      expiry,
      tradingStrategy,
      startDate,
      endDate,
      candleInterval,
      margin,
    );
  }

  /**
   * GET /kite/simulate-auto-trade?brokerId=...&date=2026-03-02
   * Simulates the auto-trade day logic (DAY_SELLING, 1min, SL=30, Target=60, 2 trades max)
   * and returns a P&L report. No live orders placed.
   */
  @Get('simulate-auto-trade')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async simulateAutoTradeDay(
    @Query('brokerId') brokerId: string,
    @Query('date') date?: string,
    @Query('interval') interval?: string,
    @Query('slPts') slPts?: string,
    @Query('mode') mode?: string,
  ) {
    if (!brokerId) {
      return { error: 'brokerId is required' };
    }
    return this.tradingService.simulateAutoTradeDay(
      brokerId,
      date,
      (interval as any) || 'minute',
      slPts ? Math.max(1, parseInt(slPts, 10)) : 30,
      (mode === 'live' ? 'live' : 'historical') as 'live' | 'historical',
    );
  }

  /**
   * GET /kite/simulate-auto-trade-range?brokerId=...&startDate=2026-02-01&endDate=2026-03-02
   * Runs the auto-trade simulation for every weekday in the date range and
   * returns daily / weekly / monthly P&L breakdown.
   */
  @Get('simulate-auto-trade-range')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async simulateAutoTradeRange(
    @Query('brokerId') brokerId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('interval') interval?: string,
    @Query('slPts') slPts?: string,
    @Query('mode') mode?: string,
  ) {
    if (!brokerId || !startDate || !endDate) {
      return { error: 'brokerId, startDate, endDate are required' };
    }
    return this.tradingService.simulateAutoTradeRange(
      brokerId,
      startDate,
      endDate,
      (interval as any) || 'minute',
      slPts ? Math.max(1, parseInt(slPts, 10)) : 30,
      (mode === 'live' ? 'live' : 'historical') as 'live' | 'historical',
    );
  }

  /**
   * GET /kite/candle-cache?token=12345&date=2026-04-07&interval=minute
   * Returns cached candles for a given instrument token + date.
   * Also accepts tradingsymbol= instead of token= for convenience.
   */
  @Get('candle-cache')
  async getCandleCache(
    @Query('token') token?: string,
    @Query('tradingsymbol') tradingsymbol?: string,
    @Query('date') date?: string,
    @Query('interval') interval?: string,
  ) {
    if (!date) return { error: 'date is required (YYYY-MM-DD)' };
    if (!token && !tradingsymbol)
      return { error: 'token or tradingsymbol is required' };

    let row: {
      candlesJson: string;
      tradingsymbol: string;
      savedAt: Date;
    } | null = null;

    if (token) {
      row = await this.prisma.candleCache.findUnique({
        where: {
          instrumentToken_dateStr_interval: {
            instrumentToken: parseInt(token, 10),
            dateStr: date,
            interval: interval ?? 'minute',
          },
        },
        select: { candlesJson: true, tradingsymbol: true, savedAt: true },
      });
    } else {
      row = await this.prisma.candleCache.findFirst({
        where: {
          tradingsymbol: tradingsymbol!,
          dateStr: date,
          interval: interval ?? 'minute',
        },
        select: { candlesJson: true, tradingsymbol: true, savedAt: true },
      });
    }

    if (!row) {
      return {
        cached: false,
        candles: [],
        message: `No cached candles for ${tradingsymbol ?? token} on ${date} (${interval ?? 'minute'})`,
      };
    }

    return {
      cached: true,
      tradingsymbol: row.tradingsymbol,
      date,
      interval: interval ?? 'minute',
      savedAt: row.savedAt,
      candles: JSON.parse(row.candlesJson),
    };
  }

  /**
   * GET /kite/candle-cache-summary?date=YYYY-MM-DD
   * Returns all cached instruments for a given date (for the Candle History page).
   */
  @Get('candle-cache-summary')
  async getCandleCacheSummary(@Query('date') date?: string) {
    const targetDate =
      date ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const rows = await this.prisma.candleCache.findMany({
      where: { dateStr: targetDate },
      select: {
        id: true,
        tradingsymbol: true,
        instrumentToken: true,
        interval: true,
        savedAt: true,
        candlesJson: true,
      },
      orderBy: [{ tradingsymbol: 'asc' }, { interval: 'asc' }],
    });

    const summary = rows.map((r) => ({
      id: r.id,
      tradingsymbol: r.tradingsymbol,
      instrumentToken: r.instrumentToken,
      interval: r.interval,
      savedAt: r.savedAt,
      candleCount: (() => {
        try {
          return JSON.parse(r.candlesJson).length;
        } catch {
          return 0;
        }
      })(),
    }));

    // Collect distinct dates that have any data (for the date picker)
    const allDates = await this.prisma.candleCache.findMany({
      distinct: ['dateStr'],
      select: { dateStr: true },
      orderBy: { dateStr: 'desc' },
    });

    return {
      date: targetDate,
      count: summary.length,
      instruments: summary,
      availableDates: allDates.map((d) => d.dateStr),
    };
  }

  /**
   * GET /kite/candle-cache-dates?tradingsymbol=NIFTY2640722700CE
   * Returns available cached dates for an instrument (for the history picker UI).
   */
  @Get('candle-cache-dates')
  async getCandleCacheDates(
    @Query('tradingsymbol') tradingsymbol?: string,
    @Query('token') token?: string,
  ) {
    if (!tradingsymbol && !token)
      return { error: 'tradingsymbol or token is required' };

    const where = token
      ? { instrumentToken: parseInt(token, 10) }
      : { tradingsymbol: tradingsymbol! };

    const rows = await this.prisma.candleCache.findMany({
      where,
      select: {
        dateStr: true,
        interval: true,
        savedAt: true,
        tradingsymbol: true,
      },
      orderBy: { dateStr: 'desc' },
    });

    return {
      tradingsymbol: tradingsymbol ?? rows[0]?.tradingsymbol ?? '',
      dates: rows,
    };
  }

  /**
   * POST /kite/save-candle-cache
   * Manually triggers the EOD candle save for a specific date (or today).
   * Body: { date?: 'YYYY-MM-DD' }
   */
  @Post('save-candle-cache')
  async saveCandleCache(@Body() body: { date?: string }) {
    const date =
      body?.date ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const result = await this.kiteScheduler.saveEodCandleCacheForDate(date);
    return {
      date,
      ...result,
      message: `Saved ${result.saved} candle sets for ${result.instruments} instruments (${result.failed} failed)`,
    };
  }
}

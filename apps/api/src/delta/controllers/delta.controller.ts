import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../auth/guards/auth.guard';
import type { AuthenticatedRequest } from '../../auth/guards/auth.guard';
import { DeltaService } from '../services/delta.service';
import { Isv200LiveService } from '../services/isv200-live.service';
import { TripleSyncLiveService } from '../services/triple-sync-live.service';
import type { TripleSyncConfig } from '../../kite/strategies/triple-sync.strategy';

@Controller('delta')
@UseGuards(AuthGuard)
export class DeltaController {
  constructor(
    private readonly deltaService: DeltaService,
    private readonly isv200LiveService: Isv200LiveService,
    private readonly tripleSyncLiveService: TripleSyncLiveService,
  ) {}

  /** GET /delta/wallet?brokerId=xxx */
  @Get('wallet')
  getWallet(
    @Req() req: AuthenticatedRequest,
    @Query('brokerId') brokerId: string,
  ) {
    return this.deltaService.getWallet(req.userId!, brokerId);
  }

  /** GET /delta/positions?brokerId=xxx */
  @Get('positions')
  getPositions(
    @Req() req: AuthenticatedRequest,
    @Query('brokerId') brokerId: string,
  ) {
    return this.deltaService.getPositions(req.userId!, brokerId);
  }

  /** GET /delta/orders?brokerId=xxx&state=all&page=1 */
  @Get('orders')
  getOrders(
    @Req() req: AuthenticatedRequest,
    @Query('brokerId') brokerId: string,
    @Query('state') state?: string,
    @Query('page') page?: string,
  ) {
    return this.deltaService.getOrders(
      req.userId!,
      brokerId,
      state || 'all',
      page ? parseInt(page, 10) : 1,
    );
  }

  /** GET /delta/open-orders?brokerId=xxx */
  @Get('open-orders')
  getOpenOrders(
    @Req() req: AuthenticatedRequest,
    @Query('brokerId') brokerId: string,
  ) {
    return this.deltaService.getOpenOrders(req.userId!, brokerId);
  }

  /** POST /delta/orders */
  @Post('orders')
  placeOrder(
    @Req() req: AuthenticatedRequest,
    @Query('brokerId') brokerId: string,
    @Body()
    body: {
      product_id: number;
      side: 'buy' | 'sell';
      order_type: 'market_order' | 'limit_order';
      size: number;
      limit_price?: string;
      time_in_force?: string;
      reduce_only?: boolean;
    },
  ) {
    return this.deltaService.placeOrder(req.userId!, brokerId, body);
  }

  /** DELETE /delta/orders/:orderId?brokerId=xxx&productId=xxx */
  @Delete('orders/:orderId')
  cancelOrder(
    @Req() req: AuthenticatedRequest,
    @Param('orderId') orderId: string,
    @Query('brokerId') brokerId: string,
    @Query('productId') productId: string,
  ) {
    return this.deltaService.cancelOrder(
      req.userId!,
      brokerId,
      parseInt(orderId, 10),
      parseInt(productId, 10),
    );
  }

  /** GET /delta/products?contractTypes=perpetual_futures  (public, no auth needed) */
  @Get('products')
  getProducts(@Query('contractTypes') contractTypes?: string) {
    return this.deltaService.getProducts(contractTypes || 'perpetual_futures');
  }

  /** GET /delta/ticker/:symbol  (public) */
  @Get('ticker/:symbol')
  getTicker(@Param('symbol') symbol: string) {
    return this.deltaService.getTicker(symbol);
  }

  /**
   * GET /delta/trade-finder
   * Scan historical candles and return buy/sell signals.
   * Query params: symbol, interval, fromDate, toDate, strategy
   */
  @Get('trade-finder')
  tradeFinder(
    @Query('symbol') symbol: string,
    @Query('interval') interval: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('strategy') strategy: string,
  ) {
    return this.deltaService.findTradeSignals(
      symbol || 'BTCUSD',
      interval || '5m',
      fromDate,
      toDate,
      strategy || 'EMA_CROSS',
    );
  }

  // ── ISV-200 Live Trading Engine ────────────────────────────────────────────

  /**
   * POST /delta/isv200/start
   * Start the ISV-200 live engine for a symbol.
   *
   * Body: { brokerId, symbol, productId, quantity }
   *
   * productId: Delta Exchange product ID for the perpetual future.
   *   SOLUSD = 3136, BTCUSD = 27, ETHUSD = 3, XRPUSD = 66786
   *
   * The engine will:
   *   1. Load 80 historical 5m candles for indicator warm-up.
   *   2. Subscribe to the live candlestick_5m WebSocket feed.
   *   3. On each candle close, detect left-side pivot lows/highs.
   *   4. Place a GTC limit order at the pivot price.
   *   5. Cancel the order if price breaks through the pivot OR 12 bars pass.
   *   6. On fill, place a reduce-only SL limit order at pivot ± 0.5×ATR.
   */
  @Post('isv200/start')
  startIsv200Live(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      brokerId: string;
      symbol: string;
      productId: number;
      quantity: number;
    },
  ) {
    return this.isv200LiveService.start(
      req.userId!,
      body.brokerId,
      body.symbol,
      body.productId,
      body.quantity,
    );
  }

  /**
   * DELETE /delta/isv200/stop?brokerId=xxx&symbol=SOLUSD
   * Stop the ISV-200 live engine. Cancels all pending limit orders.
   * Active positions (already filled) are NOT automatically closed — manage via /delta/orders.
   */
  @Delete('isv200/stop')
  stopIsv200Live(
    @Req() req: AuthenticatedRequest,
    @Query('brokerId') brokerId: string,
    @Query('symbol') symbol: string,
  ) {
    return this.isv200LiveService.stop(req.userId!, brokerId, symbol);
  }

  /**
   * GET /delta/isv200/status
   * Returns all running ISV-200 sessions for the authenticated user,
   * including pending limit orders and active positions.
   */
  @Get('isv200/status')
  getIsv200LiveStatus(@Req() req: AuthenticatedRequest) {
    return this.isv200LiveService.getStatus(req.userId!);
  }

  // ── Triple Sync Live Trading Engine ───────────────────────────────────────

  /**
   * POST /delta/triple-sync/start
   * Start the Triple Sync live engine for a symbol.
   *
   * Body: { brokerId, symbol, productId, quantity, config? }
   *
   * productId: Delta Exchange product ID for the perpetual future.
   *   SOLUSD = 3136, BTCUSD = 27, ETHUSD = 3, XRPUSD = 66786
   *
   * config: Optional TripleSyncConfig overrides (adxThreshold, minRRR, etc.)
   *
   * The engine will:
   *   1. Load 300 historical 5m candles for 200-EMA warm-up.
   *   2. Subscribe to the live candlestick_5m WebSocket feed.
   *   3. On each candle close, run TRIPLE_SYNC detection.
   *   4. If signal fires on the latest candle and no position is open,
   *      place a market order immediately.
   *   5. On fill, place a reduce-only SL limit order at strategy-computed SL.
   */
  @Post('triple-sync/start')
  startTripleSyncLive(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      brokerId: string;
      symbol: string;
      productId: number;
      quantity: number;
      config?: TripleSyncConfig;
    },
  ) {
    return this.tripleSyncLiveService.start(
      req.userId!,
      body.brokerId,
      body.symbol,
      body.productId,
      body.quantity,
      body.config,
    );
  }

  /**
   * DELETE /delta/triple-sync/stop?brokerId=xxx&symbol=SOLUSD
   * Stop the Triple Sync live engine.
   * Active positions are NOT automatically closed — manage via /delta/orders.
   */
  @Delete('triple-sync/stop')
  stopTripleSyncLive(
    @Req() req: AuthenticatedRequest,
    @Query('brokerId') brokerId: string,
    @Query('symbol') symbol: string,
  ) {
    return this.tripleSyncLiveService.stop(req.userId!, brokerId, symbol);
  }

  /**
   * GET /delta/triple-sync/status
   * Returns all running Triple Sync sessions for the authenticated user,
   * including active positions and last signal time.
   */
  @Get('triple-sync/status')
  getTripleSyncLiveStatus(@Req() req: AuthenticatedRequest) {
    return this.tripleSyncLiveService.getStatus(req.userId!);
  }
}

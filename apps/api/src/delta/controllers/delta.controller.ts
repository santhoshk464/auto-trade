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

@Controller('delta')
@UseGuards(AuthGuard)
export class DeltaController {
  constructor(private readonly deltaService: DeltaService) {}

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
}

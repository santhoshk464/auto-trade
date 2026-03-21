import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import WebSocket, { type RawData } from 'ws';
import { DeltaService } from '../services/delta.service';

const DELTA_WS_URL = 'wss://socket.india.delta.exchange';

// All symbols we stream prices for (Delta India names)
const ALL_GLOBAL_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD'];

// No remapping needed — India symbol names match frontend names
const REVERSE_SYMBOL_MAP: Record<string, string> = {
  BTCUSD: 'BTCUSD',
  ETHUSD: 'ETHUSD',
  SOLUSD: 'SOLUSD',
  XRPUSD: 'XRPUSD',
  BNBUSD: 'BNBUSD',
};

interface ChartConnection {
  ws: WebSocket;
  symbol: string; // e.g. BTCUSD
  globalSymbol: string; // same on India — e.g. BTCUSD
  interval: string;
}

@WebSocketGateway({
  cors: {
    origin: process.env.WEB_APP_URL || 'http://localhost:3000',
    credentials: true,
  },
})
export class DeltaGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(DeltaGateway.name);

  // --- Ticker (price) state -------------------------------------------------
  private tickerWs: WebSocket | null = null;
  private priceSubscribers = new Set<string>(); // socket client IDs

  // --- Chart (candle) state --------------------------------------------------
  // clientId → live WS connection to Delta for candlestick updates
  private chartConnections = new Map<string, ChartConnection>();

  constructor(private readonly deltaService: DeltaService) {}

  handleConnection(client: Socket) {
    this.logger.log(`[DeltaGW] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`[DeltaGW] Client disconnected: ${client.id}`);
    this.removePriceSubscriber(client.id);
    this.closeChartWs(client.id);
  }

  // ── Price feed ────────────────────────────────────────────────────────────

  @SubscribeMessage('subscribe-delta-prices')
  handleSubscribePrices(client: Socket): void {
    this.logger.log(`[DeltaGW] ${client.id} subscribed to prices`);
    this.priceSubscribers.add(client.id);
    this.ensureTickerWs();
  }

  @SubscribeMessage('unsubscribe-delta-prices')
  handleUnsubscribePrices(client: Socket): void {
    this.removePriceSubscriber(client.id);
  }

  private removePriceSubscriber(clientId: string) {
    this.priceSubscribers.delete(clientId);
    if (this.priceSubscribers.size === 0) {
      this.closeTickerWs();
    }
  }

  private ensureTickerWs(): void {
    if (this.tickerWs && this.tickerWs.readyState === WebSocket.OPEN) return;
    if (this.tickerWs) {
      this.tickerWs.removeAllListeners();
      this.tickerWs.terminate();
    }

    this.logger.log('[DeltaGW] Connecting ticker WS to Delta Exchange...');
    const ws = new WebSocket(DELTA_WS_URL);
    this.tickerWs = ws;

    ws.on('open', () => {
      this.logger.log('[DeltaGW] Ticker WS open — subscribing to v2/ticker');
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: {
            channels: [{ name: 'v2/ticker', symbols: ALL_GLOBAL_SYMBOLS }],
          },
        }),
      );
    });

    ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'v2/ticker' && msg.symbol) {
          const frontendSymbol = REVERSE_SYMBOL_MAP[msg.symbol] ?? msg.symbol;
          const close = parseFloat(msg.close ?? msg.mark_price ?? 0);
          const open = parseFloat(msg.open ?? close);
          const update = {
            symbol: frontendSymbol,
            price: close,
            open24h: open,
            high24h: parseFloat(msg.high ?? close),
            low24h: parseFloat(msg.low ?? close),
            change24h: open > 0 ? ((close - open) / open) * 100 : 0,
          };
          for (const clientId of this.priceSubscribers) {
            this.server.to(clientId).emit('delta-price-update', update);
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.logger.warn('[DeltaGW] Ticker WS closed');
      this.tickerWs = null;
      if (this.priceSubscribers.size > 0) {
        this.logger.log('[DeltaGW] Reconnecting ticker WS in 3s...');
        setTimeout(() => this.ensureTickerWs(), 3000);
      }
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(`[DeltaGW] Ticker WS error: ${err.message}`);
    });
  }

  private closeTickerWs(): void {
    if (this.tickerWs) {
      this.tickerWs.removeAllListeners();
      this.tickerWs.terminate();
      this.tickerWs = null;
      this.logger.log('[DeltaGW] Ticker WS closed (no more subscribers)');
    }
  }

  // ── Chart (candlestick) feed ───────────────────────────────────────────────

  /**
   * subscribe-delta-chart payload: { symbol: 'BTCUSD', interval: '5m' }
   * Emits:
   *   delta-chart-full  : { symbol, interval, candles: [{time,open,high,low,close},...] }
   *   delta-chart-candle: { symbol, candle: {time,open,high,low,close} }
   *   delta-chart-error : { message }
   */
  @SubscribeMessage('subscribe-delta-chart')
  async handleSubscribeChart(
    client: Socket,
    payload: { symbol: string; interval: string },
  ): Promise<void> {
    const { symbol, interval = '5m' } = payload;
    const globalSymbol = this.deltaService.SYMBOL_MAP[symbol] ?? symbol;

    this.logger.log(
      `[DeltaGW] ${client.id} subscribing chart ${symbol} @ ${interval}`,
    );

    // Close any previous chart WS for this client
    this.closeChartWs(client.id);

    // ── Load historical candles (up to 4000 — API max) ──
    try {
      const now = Math.floor(Date.now() / 1000);
      const intervalSec = this.deltaService.intervalToSeconds(interval);
      const fetchStart = now - 4000 * intervalSec;

      const raw = await this.deltaService.getCandles(
        globalSymbol,
        interval,
        fetchStart,
        now,
      );
      const candles = raw.map((c) => ({
        time: Math.floor(c.date.getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      client.emit('delta-chart-full', { symbol, interval, candles });
    } catch (err: any) {
      this.logger.error(
        `[DeltaGW] Failed to load initial candles: ${err?.message}`,
      );
      client.emit('delta-chart-error', {
        message: err?.message || 'Failed to load candles',
      });
      return;
    }

    // ── Open live candlestick WS ──
    const ws = new WebSocket(DELTA_WS_URL);
    const channelName = `candlestick_${interval}`;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: {
            channels: [{ name: channelName, symbols: [globalSymbol] }],
          },
        }),
      );
      this.logger.log(
        `[DeltaGW] Chart WS open — subscribed to ${channelName}:${globalSymbol}`,
      );
    });

    ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type?.startsWith('candlestick_')) {
          // candle_start_time is in microseconds — divide by 1_000_000 for Unix seconds
          client.emit('delta-chart-candle', {
            symbol,
            candle: {
              time: Math.floor(msg.candle_start_time / 1_000_000),
              open: parseFloat(msg.open),
              high: parseFloat(msg.high),
              low: parseFloat(msg.low),
              close: parseFloat(msg.close),
            },
          });
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      this.logger.log(`[DeltaGW] Chart WS closed for ${symbol}`);
    });

    ws.on('error', (err: Error) => {
      this.logger.warn(
        `[DeltaGW] Chart WS error for ${symbol}: ${err.message}`,
      );
    });

    this.chartConnections.set(client.id, {
      ws,
      symbol,
      globalSymbol,
      interval,
    });
  }

  @SubscribeMessage('unsubscribe-delta-chart')
  handleUnsubscribeChart(client: Socket): void {
    this.closeChartWs(client.id);
  }

  private closeChartWs(clientId: string): void {
    const conn = this.chartConnections.get(clientId);
    if (conn) {
      conn.ws.removeAllListeners();
      conn.ws.terminate();
      this.chartConnections.delete(clientId);
    }
  }
}

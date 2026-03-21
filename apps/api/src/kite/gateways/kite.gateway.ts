import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { KiteService } from '../services/kite.service';
import { TradingService } from '../services/trading.service';
import { KiteTicker } from 'kiteconnect';
import { PrismaService } from '../../prisma/prisma.service';

interface ChartSubscription {
  brokerId: string;
  instrumentToken: number;
  targetDate: string;
  interval: 'minute' | '5minute' | '15minute' | '30minute' | '60minute';
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
    | 'TREND_NIFTY';
  marginPoints: number;
}

interface LtpSubscription {
  brokerId: string;
  instrumentTokens: number[];
}

@WebSocketGateway({
  cors: {
    origin: process.env.WEB_APP_URL || 'http://localhost:3000',
    credentials: true,
  },
})
export class KiteGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(KiteGateway.name);
  private subscriptions = new Map<string, NodeJS.Timeout>();
  private clientData = new Map<string, { lastCandleCount: number }>();

  // LTP ticker management
  private tickers = new Map<string, any>(); // brokerId -> KiteTicker instance
  private tickerSubscriptions = new Map<string, Set<string>>(); // brokerId -> Set<clientId>
  private clientLtpSubscriptions = new Map<string, LtpSubscription>(); // clientId -> subscription

  constructor(
    private readonly kiteService: KiteService,
    private readonly tradingService: TradingService,
    private readonly prisma: PrismaService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Clear all subscriptions for this client
    const subscriptionKey = `${client.id}`;
    if (this.subscriptions.has(subscriptionKey)) {
      clearInterval(this.subscriptions.get(subscriptionKey));
      this.subscriptions.delete(subscriptionKey);
    }

    // Clean up client data
    this.clientData.delete(subscriptionKey);

    // Clean up LTP subscriptions
    this.handleUnsubscribeLtp(client);
  }

  @SubscribeMessage('subscribe-chart')
  async handleSubscribeChart(
    client: Socket,
    payload: ChartSubscription,
  ): Promise<void> {
    this.logger.log(`Client ${client.id} subscribing to chart data:`, payload);

    const subscriptionKey = `${client.id}`;

    // Clear existing subscription if any
    if (this.subscriptions.has(subscriptionKey)) {
      clearInterval(this.subscriptions.get(subscriptionKey));
    }

    // Initialize client data
    this.clientData.set(subscriptionKey, { lastCandleCount: 0 });

    // Send initial full data immediately
    await this.sendChartData(client, payload, true);
  }

  @SubscribeMessage('unsubscribe-chart')
  handleUnsubscribeChart(client: Socket): void {
    this.logger.log(`Client ${client.id} unsubscribing from chart data`);

    const subscriptionKey = `${client.id}`;
    if (this.subscriptions.has(subscriptionKey)) {
      clearInterval(this.subscriptions.get(subscriptionKey));
      this.subscriptions.delete(subscriptionKey);
    }
  }

  private async sendChartData(
    client: Socket,
    payload: ChartSubscription,
    isInitialLoad: boolean = false,
  ): Promise<void> {
    try {
      // Check if client is still connected
      if (!client.connected) {
        this.logger.debug(
          `Client ${client.id} disconnected, skipping chart data`,
        );
        return;
      }

      const chartData = await this.tradingService.getOptionChartData(
        payload.brokerId,
        payload.instrumentToken.toString(),
        payload.targetDate,
        payload.interval,
        payload.strategy,
        payload.marginPoints,
      );

      // Check again after async operation
      if (!client.connected) {
        this.logger.debug(
          `Client ${client.id} disconnected during fetch, skipping emit`,
        );
        return;
      }

      const clientKey = client.id;
      const clientInfo = this.clientData.get(clientKey);

      if (isInitialLoad || !clientInfo) {
        // Send full data on initial load
        client.emit('chart-data', { type: 'full', data: chartData });
        this.clientData.set(clientKey, {
          lastCandleCount: chartData.candles.length,
        });
        this.logger.debug(`Sent full chart data to client ${client.id}`);
      } else {
        // Send only the last candle for smooth updates
        const lastCandle = chartData.candles[chartData.candles.length - 1];
        const lastEma = chartData.ema?.[chartData.ema.length - 1];

        client.emit('chart-update', {
          candle: lastCandle,
          ema: lastEma,
          statistics: chartData.statistics,
        });
        this.logger.debug(`Sent chart update to client ${client.id}`);
      }
    } catch (error) {
      this.logger.error(
        `Error fetching chart data for client ${client.id}:`,
        error,
      );

      // Only emit error if client is still connected
      if (client.connected) {
        try {
          client.emit('chart-error', {
            message: error.message || 'Failed to fetch chart data',
          });
        } catch (emitError) {
          this.logger.error(
            `Failed to emit error to disconnected client:`,
            emitError,
          );
        }
      }
    }
  }

  @SubscribeMessage('subscribe-ltp')
  async handleSubscribeLtp(
    client: Socket,
    payload: LtpSubscription,
  ): Promise<void> {
    this.logger.log(
      `Client ${client.id} subscribing to LTP for broker ${payload.brokerId} with ${payload.instrumentTokens.length} instruments`,
    );
    this.logger.debug(
      `Instrument tokens: ${JSON.stringify(payload.instrumentTokens)}`,
    );

    try {
      const { brokerId, instrumentTokens } = payload;

      if (!instrumentTokens || instrumentTokens.length === 0) {
        this.logger.warn('No instruments to subscribe');
        client.emit('ltp-error', { message: 'No instruments to subscribe' });
        return;
      }

      // Get broker info
      const broker = await this.prisma.broker.findUnique({
        where: { id: brokerId },
      });

      if (!broker || !broker.accessToken) {
        this.logger.error(`Broker ${brokerId} not found or no access token`);
        client.emit('ltp-error', { message: 'Broker not connected' });
        return;
      }

      this.logger.log(
        `Broker ${brokerId} found: ${broker.name}, API Key: ${broker.apiKey ? 'exists' : 'missing'}`,
      );

      // Diff old vs new tokens for this client (handles re-subscribe after trade delete)
      const existingSubscription = this.clientLtpSubscriptions.get(client.id);
      const oldTokens: number[] =
        existingSubscription?.brokerId === brokerId
          ? existingSubscription.instrumentTokens
          : [];
      const tokensToRemove = oldTokens.filter(
        (t) => !instrumentTokens.includes(t),
      );
      const tokensToAdd = instrumentTokens.filter(
        (t) => !oldTokens.includes(t),
      );

      // Store updated client subscription
      this.clientLtpSubscriptions.set(client.id, payload);

      // Check if ticker already exists for this broker
      let ticker = this.tickers.get(brokerId);

      if (!ticker) {
        this.logger.log(`Creating new ticker for broker ${brokerId}`);
        // Create new ticker instance
        ticker = new KiteTicker({
          api_key: broker.apiKey,
          access_token: broker.accessToken,
        });

        // Set up ticker event handlers
        ticker.on('connect', () => {
          this.logger.log(
            `✅ Ticker connected for broker ${brokerId}, subscribing to ${instrumentTokens.length} instruments`,
          );
          this.logger.log(
            `Instrument tokens: ${JSON.stringify(instrumentTokens)}`,
          );
          ticker.subscribe(instrumentTokens);
          ticker.setMode(ticker.modeLTP, instrumentTokens);
          this.logger.log(
            `Mode set to LTP for ${instrumentTokens.length} instruments`,
          );
        });

        ticker.on('ticks', (ticks: any[]) => {
          try {
            this.logger.log(
              `📊 Received ${ticks.length} ticks for broker ${brokerId}`,
            );

            // Broadcast LTP updates to all subscribed clients
            const clients = this.tickerSubscriptions.get(brokerId) || new Set();

            if (clients.size === 0) return;

            const ltpUpdates = ticks.map((tick: any) => ({
              instrument_token: tick.instrument_token,
              last_price: tick.last_price || tick.ltp || 0,
            }));

            clients.forEach((clientId) => {
              try {
                const socket = this.server.sockets.sockets.get(clientId);
                if (socket && socket.connected) {
                  socket.emit('ltp-update', { updates: ltpUpdates });
                } else {
                  this.logger.warn(
                    `Client ${clientId} not found or disconnected`,
                  );
                }
              } catch (emitErr) {
                this.logger.error(
                  `Failed to emit to client ${clientId}:`,
                  emitErr,
                );
              }
            });
          } catch (err) {
            this.logger.error(
              `Unhandled error in ticks handler for broker ${brokerId}:`,
              err,
            );
          }
        });

        ticker.on('error', (error: any) => {
          try {
            this.logger.error(`❌ Ticker error for broker ${brokerId}:`, error);
            const clients = this.tickerSubscriptions.get(brokerId) || new Set();
            clients.forEach((clientId) => {
              try {
                const socket = this.server?.sockets?.sockets?.get(clientId);
                if (socket && socket.connected) {
                  socket.emit('ltp-error', {
                    message: error.message || 'Ticker error',
                  });
                }
              } catch (emitErr) {
                this.logger.error(
                  `Failed to emit error to client ${clientId}:`,
                  emitErr,
                );
              }
            });
          } catch (err) {
            this.logger.error(
              `Unhandled error in error handler for broker ${brokerId}:`,
              err,
            );
          }
        });

        ticker.on('close', () => {
          try {
            this.logger.log(`🔴 Ticker closed for broker ${brokerId}`);
            this.tickers.delete(brokerId);
            // Clean up subscriptions for all clients on unexpected close
            const orphanClients = this.tickerSubscriptions.get(brokerId);
            if (orphanClients) {
              orphanClients.forEach((cid) =>
                this.clientLtpSubscriptions.delete(cid),
              );
              this.tickerSubscriptions.delete(brokerId);
              this.logger.warn(
                `Cleaned up ${orphanClients.size} orphaned LTP subscription(s) for broker ${brokerId}`,
              );
            }
          } catch (err) {
            this.logger.error(
              `Unhandled error in close handler for broker ${brokerId}:`,
              err,
            );
          }
        });

        ticker.on('reconnect', (reconnect_attempt: any, delay: any) => {
          try {
            this.logger.log(
              `🔄 Ticker reconnecting for broker ${brokerId}, attempt: ${reconnect_attempt}, delay: ${delay}`,
            );
          } catch (err) {
            this.logger.error(
              `Unhandled error in reconnect handler for broker ${brokerId}:`,
              err,
            );
          }
        });

        ticker.on('noreconnect', () => {
          try {
            this.logger.error(
              `❌ Ticker failed to reconnect for broker ${brokerId}`,
            );
            const clients = this.tickerSubscriptions.get(brokerId) || new Set();
            clients.forEach((clientId) => {
              try {
                const socket = this.server?.sockets?.sockets?.get(clientId);
                if (socket && socket.connected) {
                  socket.emit('ltp-error', {
                    message: 'Failed to connect to market data feed',
                  });
                }
              } catch (emitErr) {
                this.logger.error(
                  `Failed to emit noreconnect error to client ${clientId}:`,
                  emitErr,
                );
              }
            });
            // Clean up ticker state since it won't reconnect
            this.tickers.delete(brokerId);
            this.tickerSubscriptions.delete(brokerId);
          } catch (err) {
            this.logger.error(
              `Unhandled error in noreconnect handler for broker ${brokerId}:`,
              err,
            );
          }
        });

        ticker.on('order_update', (order: any) => {
          this.logger.debug(`Order update for broker ${brokerId}:`, order);
        });

        // Connect ticker
        this.logger.log(`Connecting ticker for broker ${brokerId}...`);
        ticker.connect();
        this.tickers.set(brokerId, ticker);
      } else {
        this.logger.log(
          `Using existing ticker for broker ${brokerId}: +${tokensToAdd.length} new, -${tokensToRemove.length} removed`,
        );
        try {
          // Unsubscribe tokens that are no longer needed
          if (tokensToRemove.length > 0) {
            ticker.unsubscribe(tokensToRemove);
            this.logger.log(
              `Unsubscribed stale tokens: ${JSON.stringify(tokensToRemove)}`,
            );
          }
          // Subscribe only truly new tokens
          if (tokensToAdd.length > 0) {
            ticker.subscribe(tokensToAdd);
            ticker.setMode(ticker.modeLTP, tokensToAdd);
          }
        } catch (subErr) {
          this.logger.error(
            `Error updating subscriptions for broker ${brokerId}:`,
            subErr,
          );
        }
      }

      // Track this client for this broker
      if (!this.tickerSubscriptions.has(brokerId)) {
        this.tickerSubscriptions.set(brokerId, new Set());
      }
      this.tickerSubscriptions.get(brokerId)!.add(client.id);

      // Send confirmation
      client.emit('ltp-subscribed', {
        brokerId,
        instrumentTokens,
        status: 'connected',
      });
    } catch (error) {
      this.logger.error(
        `Error subscribing to LTP for client ${client.id}:`,
        error,
      );
      client.emit('ltp-error', {
        message: error.message || 'Failed to subscribe to LTP',
      });
    }
  }

  @SubscribeMessage('unsubscribe-ltp')
  handleUnsubscribeLtp(client: Socket): void {
    this.logger.log(`Client ${client.id} unsubscribing from LTP`);

    const subscription = this.clientLtpSubscriptions.get(client.id);
    if (!subscription) {
      return;
    }

    const { brokerId, instrumentTokens } = subscription;

    // Remove client from broker's subscription list
    const clients = this.tickerSubscriptions.get(brokerId);
    if (clients) {
      clients.delete(client.id);

      // If no more clients for this broker, close the ticker
      if (clients.size === 0) {
        const ticker = this.tickers.get(brokerId);
        if (ticker) {
          // Disable auto-reconnect BEFORE disconnecting to prevent kiteconnect
          // from calling process.exit(1) inside attemptReconnection()
          try {
            ticker.autoReconnect(false);
          } catch (_) {}
          this.tickers.delete(brokerId);
          this.tickerSubscriptions.delete(brokerId);
          try {
            ticker.disconnect();
          } catch (_) {}
          this.logger.log(
            `Closed ticker for broker ${brokerId} (no more clients)`,
          );
        }
      } else {
        // Still have other clients, just unsubscribe these instruments
        if (instrumentTokens && instrumentTokens.length > 0) {
          const ticker = this.tickers.get(brokerId);
          if (ticker) {
            ticker.unsubscribe(instrumentTokens);
            this.logger.log(
              `Unsubscribed ${instrumentTokens.length} instruments for client ${client.id}`,
            );
          }
        }
      }
    }

    // Clean up client subscription
    this.clientLtpSubscriptions.delete(client.id);
  }
}

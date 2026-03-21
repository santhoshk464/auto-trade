import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Query,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { KiteConnect } from 'kiteconnect';
import {
  AuthGuard,
  type AuthenticatedRequest,
} from '../../auth/guards/auth.guard';
import { BrokersService } from '../services/brokers.service';
import { BrokerTypeDto, CreateBrokerDto } from '../dto/create-broker.dto';

const KITE_BROKER_COOKIE = 'kite_broker_id';
const KITE_BROKER_COOKIE_PATH = '/brokers/kite';

@Controller('brokers')
@UseGuards(AuthGuard)
export class BrokersController {
  private readonly logger = new Logger(BrokersController.name);

  constructor(private readonly brokers: BrokersService) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    return { brokers: await this.brokers.listForUser(req.userId!) };
  }

  @Get('status')
  async status(@Req() req: AuthenticatedRequest) {
    const brokers = await this.brokers.listForUser(req.userId!);
    const hasExpiredTokens = brokers.some(
      (b) => b.status === 'INACTIVE' && b.lastTokenGeneratedAt,
    );
    const hasNoBrokers = brokers.length === 0;
    const allActive = brokers.every((b) => b.status === 'ACTIVE');

    return {
      brokers,
      hasExpiredTokens,
      hasNoBrokers,
      allActive,
      message: hasExpiredTokens
        ? 'Some broker access tokens have expired. Please reconnect your brokers.'
        : hasNoBrokers
          ? 'No brokers configured. Please add a broker to start trading.'
          : allActive
            ? 'All brokers are connected and active.'
            : 'Please connect your brokers to start trading.',
    };
  }

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateBrokerDto) {
    const broker = await this.brokers.createForUser(req.userId!, dto);
    return { broker };
  }

  @Delete(':brokerId')
  async delete(
    @Req() req: AuthenticatedRequest,
    @Param('brokerId') brokerId: string,
  ) {
    return await this.brokers.deleteForUser(req.userId!, brokerId);
  }

  @Get('kite/login-url')
  async kiteLoginUrl(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('brokerId') brokerId: string,
  ) {
    const broker = await this.brokers.getOwnedBroker(req.userId!, brokerId);
    if (broker.type !== BrokerTypeDto.KITE) {
      return { loginUrl: null, message: 'Broker is not KITE' };
    }

    const kite = new KiteConnect({ api_key: broker.apiKey.trim() });
    const baseLoginUrl = kite.getLoginURL();
    const url = new URL(baseLoginUrl);
    url.searchParams.set('state', broker.id);

    // Some clients observe that `state` isn't reliably echoed back by Zerodha.
    // Store brokerId in a short-lived cookie so the callback can still resolve it.
    res.cookie(KITE_BROKER_COOKIE, broker.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: KITE_BROKER_COOKIE_PATH,
      maxAge: 10 * 60 * 1000,
    });

    return { loginUrl: url.toString() };
  }

  @Get('kite/callback')
  async kiteCallback(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('request_token') requestToken?: string,
    @Query('state') brokerId?: string,
  ) {
    if (!requestToken) {
      return res.status(400).send('Missing request_token');
    }

    const brokerIdFromCookie = (req as any).cookies?.[KITE_BROKER_COOKIE] as
      | string
      | undefined;
    const effectiveBrokerId = brokerId || brokerIdFromCookie;
    if (!effectiveBrokerId) {
      return res.status(400).send('Missing state (brokerId)');
    }

    const userId = req.userId!;
    const broker = await this.brokers.getOwnedBroker(userId, effectiveBrokerId);
    if (broker.type !== BrokerTypeDto.KITE) {
      return res.status(400).send('Broker is not KITE');
    }

    const kite = new KiteConnect({ api_key: broker.apiKey.trim() });

    let session: Awaited<ReturnType<typeof kite.generateSession>>;
    try {
      session = await kite.generateSession(
        requestToken,
        broker.apiSecret.trim(),
      );
    } catch (err: any) {
      this.logger.error(
        `Kite generateSession failed for broker ${effectiveBrokerId}: ${err?.message}`,
      );
      res.clearCookie(KITE_BROKER_COOKIE, { path: KITE_BROKER_COOKIE_PATH });
      const webUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
      const msg = encodeURIComponent(
        err?.message || 'Failed to generate Kite session. Please try again.',
      );
      return res.redirect(`${webUrl}/dashboard?kite=error&reason=${msg}`);
    }

    // Zerodha access tokens are typically valid for the trading day; we store a conservative expiry.
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

    await this.brokers.setKiteAccessToken({
      userId,
      brokerId: broker.id,
      accessToken: session.access_token,
      expiresAt,
    });

    // Prevent stale broker selection on subsequent login attempts.
    res.clearCookie(KITE_BROKER_COOKIE, { path: KITE_BROKER_COOKIE_PATH });

    const webUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
    return res.redirect(`${webUrl}/dashboard?kite=success`);
  }
}

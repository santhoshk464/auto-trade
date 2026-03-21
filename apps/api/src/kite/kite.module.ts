import { Module } from '@nestjs/common';
import { KiteService } from './services/kite.service';
import { TradingService } from './services/trading.service';
import { KiteController } from './controllers/kite.controller';
import { KiteGateway } from './gateways/kite.gateway';
import { KiteScheduler } from './schedulers/kite.scheduler';
import { SignalsController } from './controllers/signals.controller';
import { SignalsService } from './services/signals.service';
import { InstrumentsController } from './controllers/instruments.controller';
import { LiveTradingService } from './services/live-trading.service';
import { LiveTradingController } from './controllers/live-trading.controller';
import { IndicatorsService } from './services/indicators.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';

@Module({
  imports: [PrismaModule, AuthModule, PaperTradingModule],
  controllers: [
    KiteController,
    SignalsController,
    InstrumentsController,
    LiveTradingController,
  ],
  providers: [
    KiteService,
    TradingService,
    KiteGateway,
    KiteScheduler,
    SignalsService,
    LiveTradingService,
    IndicatorsService,
  ],
  exports: [
    KiteService,
    TradingService,
    SignalsService,
    LiveTradingService,
    KiteScheduler,
    IndicatorsService,
  ],
})
export class KiteModule {}

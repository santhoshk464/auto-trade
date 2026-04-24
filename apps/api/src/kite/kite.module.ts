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
import { WhatsAppService } from './services/whatsapp.service';
import { KiteTickerService } from './services/kite-ticker.service';
import { TickStorageService } from './services/tick-storage.service';
import { OiPollingService } from './services/oi-polling.service';
import { TradeAdvisorService } from './services/trade-advisor.service';
import { AdvisorScheduler } from './schedulers/advisor.scheduler';
import { AdvisorController } from './controllers/advisor.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { StrategyConfigModule } from '../strategy-config/strategy-config.module';

@Module({
  imports: [PrismaModule, AuthModule, PaperTradingModule, StrategyConfigModule],
  controllers: [
    KiteController,
    SignalsController,
    InstrumentsController,
    LiveTradingController,
    AdvisorController,
  ],
  providers: [
    KiteService,
    TradingService,
    KiteGateway,
    KiteScheduler,
    SignalsService,
    LiveTradingService,
    IndicatorsService,
    WhatsAppService,
    KiteTickerService,
    // ── AI Advisor layer ──────────────────────────────────────────────────
    TickStorageService,
    OiPollingService,
    TradeAdvisorService,
    AdvisorScheduler,
  ],
  exports: [
    KiteService,
    TradingService,
    SignalsService,
    LiveTradingService,
    KiteScheduler,
    IndicatorsService,
    WhatsAppService,
    KiteTickerService,
    TickStorageService,
    OiPollingService,
    TradeAdvisorService,
  ],
})
export class KiteModule {}

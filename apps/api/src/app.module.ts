import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { join } from 'path';
import { AuthModule } from './auth/auth.module';
import { BrokersModule } from './brokers/brokers.module';
import { KiteModule } from './kite/kite.module';
import { PaperTradingModule } from './paper-trading/paper-trading.module';
import { SettingsModule } from './settings/settings.module';
import { DeltaModule } from './delta/delta.module';
import { StrategyConfigModule } from './strategy-config/strategy-config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Supports running via repo root (`npm run dev`) or from `apps/api` directly.
      envFilePath: [
        join(process.cwd(), 'apps/api/.env'),
        join(process.cwd(), '.env'),
      ],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    BrokersModule,
    KiteModule,
    PaperTradingModule,
    SettingsModule,
    DeltaModule,
    StrategyConfigModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

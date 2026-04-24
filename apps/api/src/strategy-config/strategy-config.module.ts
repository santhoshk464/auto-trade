import { Module } from '@nestjs/common';
import { StrategyConfigController } from './strategy-config.controller';
import { StrategyConfigService } from './strategy-config.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [StrategyConfigController],
  providers: [StrategyConfigService],
  exports: [StrategyConfigService],
})
export class StrategyConfigModule {}

import { Module } from '@nestjs/common';
import { PaperTradingController } from './controllers/paper-trading.controller';
import { PaperTradingService } from './services/paper-trading.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PaperTradingController],
  providers: [PaperTradingService],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DeltaController } from './controllers/delta.controller';
import { DeltaService } from './services/delta.service';
import { DeltaGateway } from './gateways/delta.gateway';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [DeltaController],
  providers: [DeltaService, DeltaGateway],
  exports: [DeltaService],
})
export class DeltaModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DeltaController } from './controllers/delta.controller';
import { DeltaService } from './services/delta.service';
import { DeltaGateway } from './gateways/delta.gateway';
import { Isv200LiveService } from './services/isv200-live.service';
import { TripleSyncLiveService } from './services/triple-sync-live.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [DeltaController],
  providers: [
    DeltaService,
    DeltaGateway,
    Isv200LiveService,
    TripleSyncLiveService,
  ],
  exports: [DeltaService],
})
export class DeltaModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrokersController } from './controllers/brokers.controller';
import { BrokersService } from './services/brokers.service';

@Module({
  imports: [AuthModule],
  controllers: [BrokersController],
  providers: [BrokersService],
})
export class BrokersModule {}

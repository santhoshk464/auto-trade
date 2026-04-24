import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { StrategyConfigService, DHR_DEFAULTS } from './strategy-config.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { IsObject } from 'class-validator';

class UpsertStrategyConfigDto {
  @IsObject()
  config: Record<string, unknown>;
}

@Controller('strategy-config')
@UseGuards(AuthGuard)
export class StrategyConfigController {
  constructor(private readonly service: StrategyConfigService) {}

  /**
   * GET /strategy-config/:name
   * Returns the saved config merged over defaults, plus the defaults object
   * so the frontend can display which values are customised vs default.
   */
  @Get(':name')
  async getConfig(@Param('name') name: string) {
    const saved = await this.service.getConfig(name);
    const defaults = name === 'DAY_HIGH_REJECTION' ? DHR_DEFAULTS : {};
    return {
      strategyName: name,
      defaults,
      saved,
      effective: { ...defaults, ...saved },
    };
  }

  /**
   * PUT /strategy-config/:name
   * Body: { config: { ...DhrConfig } }
   * Stores the full config blob for the strategy.
   */
  @Put(':name')
  @HttpCode(HttpStatus.OK)
  async upsertConfig(
    @Param('name') name: string,
    @Body() dto: UpsertStrategyConfigDto,
  ) {
    await this.service.upsertConfig(name, dto.config);
    const saved = await this.service.getConfig(name);
    const defaults = name === 'DAY_HIGH_REJECTION' ? DHR_DEFAULTS : {};
    return {
      strategyName: name,
      defaults,
      saved,
      effective: { ...defaults, ...saved },
    };
  }
}

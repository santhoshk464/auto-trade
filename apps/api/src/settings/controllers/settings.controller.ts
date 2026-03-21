import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { SettingsService } from '../services/settings.service';
import { AuthGuard, type AuthenticatedRequest } from '../../auth/guards/auth.guard';
import {
  IsString,
  IsNumber,
  Min,
  IsOptional,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

class UpsertSettingsDto {
  @IsString()
  symbol: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  hedgeLots: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  sellLots: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  paperLots?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  bufferPoints?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  liveEnabled?: boolean;
}

@Controller('settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Get all trading settings for current user
   */
  @Get('trading')
  async getAllSettings(@Req() req: AuthenticatedRequest) {
    return this.settingsService.getAllSettings(req.userId!);
  }

  /**
   * Get trading settings for a specific symbol
   */
  @Get('trading/:symbol')
  async getSettingsBySymbol(
    @Req() req: AuthenticatedRequest,
    @Param('symbol') symbol: string,
  ) {
    const settings = await this.settingsService.getSettingsBySymbol(
      req.userId!,
      symbol.toUpperCase(),
    );
    return (
      settings || {
        symbol: symbol.toUpperCase(),
        hedgeLots: 1,
        sellLots: 1,
        bufferPoints: 5,
      }
    );
  }

  /**
   * Create or update trading settings for a symbol
   */
  @Post('trading')
  async upsertSettings(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpsertSettingsDto,
  ) {
    return this.settingsService.upsertSettings(req.userId!, {
      symbol: dto.symbol.toUpperCase(),
      hedgeLots: dto.hedgeLots,
      sellLots: dto.sellLots,
      paperLots: dto.paperLots,
      bufferPoints: dto.bufferPoints,
      liveEnabled: dto.liveEnabled,
    });
  }

  /**
   * Delete trading settings for a symbol
   */
  @Delete('trading/:symbol')
  async deleteSettings(
    @Req() req: AuthenticatedRequest,
    @Param('symbol') symbol: string,
  ) {
    await this.settingsService.deleteSettings(
      req.userId!,
      symbol.toUpperCase(),
    );
    return { success: true };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TradingSettings } from '@prisma/client';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get all trading settings for a user
   */
  async getAllSettings(userId: string): Promise<TradingSettings[]> {
    return this.prisma.tradingSettings.findMany({
      where: { userId },
      orderBy: { symbol: 'asc' },
    });
  }

  /**
   * Get trading settings for a specific symbol
   */
  async getSettingsBySymbol(
    userId: string,
    symbol: string,
  ): Promise<TradingSettings | null> {
    return this.prisma.tradingSettings.findUnique({
      where: {
        userId_symbol: { userId, symbol },
      },
    });
  }

  /**
   * Create or update trading settings for a symbol
   */
  async upsertSettings(
    userId: string,
    data: {
      symbol: string;
      hedgeLots: number;
      sellLots: number;
      paperLots?: number;
      bufferPoints?: number;
      liveEnabled?: boolean;
      placeQtyBasedOnSL?: boolean;
      perTradeLoss?: number;
      perDayLoss?: number;
      enableNiftyTrendFilter?: boolean;
      enableConfluenceChecker?: boolean;
      deduplicateSignals?: boolean;
    },
  ): Promise<TradingSettings> {
    const settings = await this.prisma.tradingSettings.upsert({
      where: {
        userId_symbol: { userId, symbol: data.symbol },
      },
      update: {
        hedgeLots: data.hedgeLots,
        sellLots: data.sellLots,
        paperLots: data.paperLots ?? 1,
        bufferPoints: data.bufferPoints ?? 5,
        liveEnabled: data.liveEnabled ?? false,
        placeQtyBasedOnSL: data.placeQtyBasedOnSL ?? false,
        perTradeLoss: data.perTradeLoss ?? 20000,
        perDayLoss: data.perDayLoss ?? 40000,
        enableNiftyTrendFilter: data.enableNiftyTrendFilter ?? false,
        enableConfluenceChecker: data.enableConfluenceChecker ?? false,
        deduplicateSignals: data.deduplicateSignals ?? true,
      },
      create: {
        userId,
        symbol: data.symbol,
        hedgeLots: data.hedgeLots,
        sellLots: data.sellLots,
        paperLots: data.paperLots ?? 1,
        bufferPoints: data.bufferPoints ?? 5,
        liveEnabled: data.liveEnabled ?? false,
        placeQtyBasedOnSL: data.placeQtyBasedOnSL ?? false,
        perTradeLoss: data.perTradeLoss ?? 20000,
        perDayLoss: data.perDayLoss ?? 40000,
        enableNiftyTrendFilter: data.enableNiftyTrendFilter ?? false,
        enableConfluenceChecker: data.enableConfluenceChecker ?? false,
        deduplicateSignals: data.deduplicateSignals ?? true,
      },
    });

    this.logger.log(
      `Settings updated for ${data.symbol}: Hedge ${data.hedgeLots} lots, Sell ${data.sellLots} lots, Paper ${data.paperLots ?? 1} lots, Live: ${data.liveEnabled ?? false}`,
    );

    return settings;
  }

  /**
   * Delete trading settings for a symbol
   */
  async deleteSettings(userId: string, symbol: string): Promise<void> {
    await this.prisma.tradingSettings.delete({
      where: {
        userId_symbol: { userId, symbol },
      },
    });
    this.logger.log(`Settings deleted for ${symbol}`);
  }

  /**
   * Get default settings if none exist for a symbol
   */
  async getOrCreateDefaultSettings(
    userId: string,
    symbol: string,
  ): Promise<TradingSettings> {
    const existing = await this.getSettingsBySymbol(userId, symbol);
    if (existing) return existing;

    return this.upsertSettings(userId, {
      symbol,
      hedgeLots: 1,
      sellLots: 1,
      bufferPoints: 5,
    });
  }
}

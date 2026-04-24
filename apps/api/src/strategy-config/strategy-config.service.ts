import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { DhrConfig } from '../kite/strategies/day-high-rejection.strategy';

/** Canonical strategy names stored in DB. */
export const STRATEGY_NAMES = {
  DAY_HIGH_REJECTION: 'DAY_HIGH_REJECTION',
} as const;

export type StrategyName = (typeof STRATEGY_NAMES)[keyof typeof STRATEGY_NAMES];

/** Hardcoded fallback defaults for DHR — mirrors the defaults in detectDayHighRejectionOnly(). */
export const DHR_DEFAULTS: Required<
  Omit<DhrConfig, 'ema20' | 'debug' | 'requireNextCandleConfirmation'>
> = {
  touchTolerance: 5,
  minUpperWickRatio: 0.45,
  minBearishBodyRatio: 0.45,
  stopLossBuffer: 5,
  sweepBuffer: 10,
  zoneCooldownCandles: 12,
  zoneRearmMoveAwayPts: 25,
  minRearmCandles: 3,
  ema20SessionTolerance: 0.005,
  useOneMinuteEntryConfirmation: false,
  oneMinuteConfirmationWindow: 10,
  enableTwoCandleConfirm: false,
  enableLowBreakConfirm: false,
  enableLowerHighBreakConfirm: false,
  enableFiveMinuteSignalLowBreakConfirm: true,
  oneMinuteStopBuffer: 3,
  fiveMinuteSignalStopBuffer: 3,
  minDirectEntryBodyRatio: 0.6,
  minDirectEntryWickRatio: 0.5,
  maxLowerWickRatio: 0.5,
  preferWickRejection: false,
  enableRoomToMoveFilter: true,
  minRoomToMovePts: 20,
  minRoomToMoveRiskRatio: 1.5,
  enableSessionCompressionFilter: true,
  compressionFirstHourCandles: 12,
  compressionFirstHourAtrRatio: 0.8,
  compressionRecentWindow: 8,
  compressionOverlapThreshold: 0.7,
  blockRepeatedSignalsWhenCompressed: true,
  tradeStartMins: 9 * 60 + 30,
  tradeEndMins: 14 * 60 + 30,
};

@Injectable()
export class StrategyConfigService {
  private readonly logger = new Logger(StrategyConfigService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get the raw config JSON for a strategy.
   * Returns an empty object if no row is found (use hardcoded defaults).
   */
  async getConfig(strategyName: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.strategyConfig.findUnique({
      where: { strategyName },
    });
    if (!row) return {};
    try {
      return JSON.parse(row.configJson) as Record<string, unknown>;
    } catch {
      this.logger.warn(`Invalid JSON in strategyConfig for ${strategyName}`);
      return {};
    }
  }

  /**
   * Get DHR config merged with defaults.
   * DB values take precedence over hardcoded defaults.
   */
  async getDhrConfig(): Promise<DhrConfig> {
    const saved = await this.getConfig(STRATEGY_NAMES.DAY_HIGH_REJECTION);
    return { ...DHR_DEFAULTS, ...saved } as DhrConfig;
  }

  /**
   * Upsert the full config for a strategy.
   */
  async upsertConfig(
    strategyName: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.strategyConfig.upsert({
      where: { strategyName },
      update: { configJson: JSON.stringify(config) },
      create: { strategyName, configJson: JSON.stringify(config) },
    });
    this.logger.log(`Strategy config updated: ${strategyName}`);
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BrokerTypeDto } from '../dto/create-broker.dto';

@Injectable()
export class BrokersService {
  constructor(private readonly prisma: PrismaService) {}

  private mask(value: string, opts?: { left?: number; right?: number }) {
    const left = opts?.left ?? 3;
    const right = opts?.right ?? 3;
    if (!value) return '';
    if (value.length <= left + right)
      return '*'.repeat(Math.max(4, value.length));
    return `${value.slice(0, left)}${'*'.repeat(Math.max(4, value.length - (left + right)))}${value.slice(-right)}`;
  }

  async listForUser(userId: string) {
    const brokers = await this.prisma.broker.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        name: true,
        apiKey: true,
        apiSecret: true,
        accessTokenExpiresAt: true,
        lastConnectedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return brokers.map((b) => {
      const connected =
        !!b.accessTokenExpiresAt &&
        b.accessTokenExpiresAt.getTime() > Date.now();
      return {
        id: b.id,
        type: b.type,
        name: b.name,
        brokerIdMasked: this.mask(b.id, { left: 2, right: 2 }),
        appIdMasked: this.mask(b.apiKey, { left: 3, right: 3 }),
        appSecretMasked: this.mask(b.apiSecret, { left: 3, right: 3 }),
        status: connected ? 'ACTIVE' : 'INACTIVE',
        lastTokenGeneratedAt: b.lastConnectedAt,
        addedAt: b.createdAt,
        connectionStatus: connected ? 'Connected' : 'Not Connected',
      };
    });
  }

  async createForUser(
    userId: string,
    dto: {
      type: BrokerTypeDto;
      name: string;
      apiKey: string;
      apiSecret: string;
    },
  ) {
    if (
      dto.type !== BrokerTypeDto.KITE &&
      dto.type !== BrokerTypeDto.ANGEL &&
      dto.type !== BrokerTypeDto.DELTA
    ) {
      throw new BadRequestException('Unsupported broker type');
    }

    const broker = await this.prisma.broker.create({
      data: {
        userId,
        type: dto.type,
        name: dto.name,
        apiKey: dto.apiKey.trim(),
        apiSecret: dto.apiSecret.trim(),
      },
      select: {
        id: true,
        type: true,
        name: true,
        createdAt: true,
      },
    });

    return broker;
  }

  async deleteForUser(userId: string, brokerId: string) {
    await this.getOwnedBroker(userId, brokerId);
    await this.prisma.broker.delete({ where: { id: brokerId } });
    return { ok: true };
  }

  async getOwnedBroker(userId: string, brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });
    if (!broker) throw new BadRequestException('Broker not found');
    if (broker.userId !== userId) throw new ForbiddenException('Forbidden');
    return broker;
  }

  async setKiteAccessToken(params: {
    userId: string;
    brokerId: string;
    accessToken: string;
    expiresAt?: Date;
  }) {
    await this.getOwnedBroker(params.userId, params.brokerId);

    return await this.prisma.broker.update({
      where: { id: params.brokerId },
      data: {
        accessToken: params.accessToken,
        accessTokenExpiresAt: params.expiresAt,
        lastConnectedAt: new Date(),
      },
      select: {
        id: true,
        type: true,
        name: true,
        accessTokenExpiresAt: true,
        lastConnectedAt: true,
      },
    });
  }
}

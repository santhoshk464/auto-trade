import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const RESET_TOKEN_TTL_MINUTES = 15;

function hashResetToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(params: {
    name: string;
    email: string;
    phone?: string;
    password: string;
  }) {
    const existing = await this.prisma.user.findUnique({
      where: { email: params.email },
    });
    if (existing) throw new BadRequestException('Email already registered');

    const passwordHash = await argon2.hash(params.password);

    const user = await this.prisma.user.create({
      data: {
        name: params.name,
        email: params.email,
        phone: params.phone,
        passwordHash,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      },
    });

    return user;
  }

  async login(params: { email: string; password: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: params.email },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const ok = await argon2.verify(user.passwordHash, params.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const token = await this.jwt.signAsync(
      { sub: user.id, email: user.email },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
      },
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async getUserFromAccessToken(token?: string) {
    if (!token) throw new UnauthorizedException('Not authenticated');

    let payload: { sub: string };
    try {
      payload = (await this.jwt.verifyAsync(token)) as { sub: string };
    } catch {
      throw new UnauthorizedException('Not authenticated');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!user) throw new UnauthorizedException('Not authenticated');
    return user;
  }

  async forgotPassword(params: { email: string }) {
    const user = await this.prisma.user.findUnique({
      where: { email: params.email },
    });
    // Always return success (avoid account enumeration)
    if (!user) {
      return {
        resetToken: null as string | null,
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
      };
    }

    // Since you said "no email", we return the token once. In production, email this token.
    const resetToken = randomBytes(32).toString('hex');
    const resetTokenHash = hashResetToken(resetToken);
    const resetTokenExpiresAt = new Date(
      Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000,
    );

    await this.prisma.passwordResetToken.upsert({
      where: { userId: user.id },
      update: { tokenHash: resetTokenHash, expiresAt: resetTokenExpiresAt },
      create: {
        userId: user.id,
        tokenHash: resetTokenHash,
        expiresAt: resetTokenExpiresAt,
      },
    });

    return { resetToken, expiresInMinutes: RESET_TOKEN_TTL_MINUTES };
  }

  async resetPassword(params: { token: string; newPassword: string }) {
    const tokenHash = hashResetToken(params.token);

    const resetRecord = await this.prisma.passwordResetToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });

    if (!resetRecord)
      throw new BadRequestException('Invalid or expired reset token');
    if (resetRecord.expiresAt.getTime() < Date.now())
      throw new BadRequestException('Invalid or expired reset token');

    const newHash = await argon2.hash(params.newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: resetRecord.userId },
        data: { passwordHash: newHash },
      }),
      this.prisma.passwordResetToken.delete({ where: { id: resetRecord.id } }),
    ]);

    return { ok: true };
  }
}

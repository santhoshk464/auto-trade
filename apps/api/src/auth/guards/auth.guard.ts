import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export type AuthenticatedRequest = Request & { userId?: string };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = (req as any).cookies?.at as string | undefined;

    if (!token) throw new UnauthorizedException('Not authenticated');

    try {
      const payload = (await this.jwt.verifyAsync(token)) as { sub: string };
      req.userId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Not authenticated');
    }
  }
}

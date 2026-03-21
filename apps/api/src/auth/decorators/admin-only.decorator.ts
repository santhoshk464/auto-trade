import { applyDecorators, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../guards/admin.guard';
import { AuthGuard } from '../guards/auth.guard';

export function AdminOnly() {
  return applyDecorators(UseGuards(AuthGuard, AdminGuard));
}

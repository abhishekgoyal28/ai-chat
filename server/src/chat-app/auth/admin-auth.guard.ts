import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AdminRole } from '../../shared/domain/enums';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors/app-errors';
import { ADMIN_COOKIE, AdminAuthService, AdminPrincipal } from './admin-auth.service';

export interface AdminRequest extends Request {
  admin: AdminPrincipal;
}

const ROLES_KEY = 'aic:admin-roles';

/** Restricts a route (or controller) to these roles. Without it any signed-in member may call. */
export const RequireRole = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = (request.cookies as Record<string, string> | undefined)?.[ADMIN_COOKIE];
    const principal = await this.auth.authenticate(token);
    if (!principal) {
      throw new UnauthorizedError('sign in to the dashboard');
    }
    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (roles && !roles.includes(principal.role)) {
      throw new ForbiddenError('your role does not allow this');
    }
    request.admin = principal;
    return true;
  }
}

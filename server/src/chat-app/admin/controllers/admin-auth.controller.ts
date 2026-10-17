import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { zodBody } from '../../../shared/http/zod-validation.pipe';
import { AdminAuthGuard, AdminRequest } from '../../auth/admin-auth.guard';
import { ADMIN_COOKIE, AdminAuthService, AdminPrincipal } from '../../auth/admin-auth.service';
import { changePasswordSchema, loginSchema } from '../admin.schemas';
import { AccessAdminService } from '../services/access-admin.service';

@Controller('admin/api/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly access: AccessAdminService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(zodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminPrincipal> {
    const { principal, token } = await this.auth.login(body.email, body.password, request.ip ?? 'unknown');
    response.cookie(ADMIN_COOKIE, token, this.auth.cookieOptions());
    return principal;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) response: Response): { signedOut: true } {
    response.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { signedOut: true };
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@Req() request: AdminRequest): AdminPrincipal {
    return request.admin;
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminAuthGuard)
  async changePassword(@Req() request: AdminRequest, @Body(zodBody(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>): Promise<{ changed: true }> {
    await this.access.changeOwnPassword(request.admin, body.currentPassword, body.newPassword);
    return { changed: true };
  }
}

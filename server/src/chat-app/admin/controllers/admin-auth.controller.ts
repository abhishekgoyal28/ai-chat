import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError, NotFoundError } from '../../../shared/errors/app-errors';
import { zodBody } from '../../../shared/http/zod-validation.pipe';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { AdminAuthGuard, AdminRequest } from '../../auth/admin-auth.guard';
import { ADMIN_COOKIE, AdminAuthService, AdminPrincipal } from '../../auth/admin-auth.service';
import { DASHBOARD_PATH } from '../../dashboard-static';
import { changePasswordSchema, googleCallbackQuerySchema, loginSchema } from '../admin.schemas';
import { AccessAdminService } from '../services/access-admin.service';

const OAUTH_NONCE_COOKIE = 'aic_oauth_nonce';
const OAUTH_NONCE_COOKIE_PATH = '/admin/api/auth';
const OAUTH_NONCE_TTL_MS = 10 * 60 * 1000;
const SIGN_IN_ERROR_PARAM = 'signInError';
const GENERIC_SIGN_IN_ERROR = 'Google sign-in failed — please try again';

@Controller('admin/api/auth')
export class AdminAuthController {
  private readonly log = getLogger(AdminAuthController.name);

  constructor(
    private readonly auth: AdminAuthService,
    private readonly access: AccessAdminService,
  ) {}

  /** Public: the sign-in page asks which methods to offer. */
  @Get('providers')
  providers(): { google: boolean } {
    return { google: this.auth.isGoogleSignInEnabled() };
  }

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

  @Get('google')
  startGoogleSignIn(@Res() response: Response): void {
    if (!this.auth.isGoogleSignInEnabled()) {
      throw new NotFoundError('Google sign-in');
    }
    const { url, nonce } = this.auth.beginGoogleSignIn();
    // Lax, not Strict: the cookie must come back on Google's top-level redirect to the callback.
    response.cookie(OAUTH_NONCE_COOKIE, nonce, { ...this.auth.cookieOptions(), sameSite: 'lax', path: OAUTH_NONCE_COOKIE_PATH, maxAge: OAUTH_NONCE_TTL_MS });
    response.redirect(url);
  }

  /** Always ends on the dashboard: signed in, or with a message the sign-in page shows. */
  @Get('google/callback')
  async finishGoogleSignIn(
    @Query(zodBody(googleCallbackQuerySchema)) query: z.infer<typeof googleCallbackQuerySchema>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const nonce = (request.cookies as Record<string, string> | undefined)?.[OAUTH_NONCE_COOKIE];
    response.clearCookie(OAUTH_NONCE_COOKIE, { path: OAUTH_NONCE_COOKIE_PATH });
    if (query.error || !query.code || !query.state) {
      this.redirectToDashboard(response, 'Google sign-in was cancelled');
      return;
    }
    try {
      const { token } = await this.auth.completeGoogleSignIn(query.code, query.state, nonce);
      response.cookie(ADMIN_COOKIE, token, this.auth.cookieOptions());
      this.redirectToDashboard(response);
    } catch (error) {
      if (!(error instanceof AppError)) {
        this.log.error({ error: describeError(error) }, 'Google sign-in failed unexpectedly');
      }
      this.redirectToDashboard(response, error instanceof AppError ? error.message : GENERIC_SIGN_IN_ERROR);
    }
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

  private redirectToDashboard(response: Response, errorMessage?: string): void {
    const query = errorMessage ? `?${new URLSearchParams({ [SIGN_IN_ERROR_PARAM]: errorMessage }).toString()}` : '';
    response.redirect(`${DASHBOARD_PATH}/${query}`);
  }
}

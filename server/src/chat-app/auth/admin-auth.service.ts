import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { config, dashboardPublicUrl } from '../../shared/config/config';
import { isDuplicateKeyError } from '../../shared/database/db-errors';
import { AdminUser } from '../../shared/database/entities';
import { AdminRole, RecordStatus } from '../../shared/domain/enums';
import { RateLimitedError, UnauthorizedError } from '../../shared/errors/app-errors';
import { getLogger } from '../../shared/logger/logger';
import { deriveKey, hashPassword, randomToken, safeEqual, verifyPassword } from '../../shared/security/crypto';
import { signToken, TokenClaims, verifyToken } from '../../shared/security/signed-token';
import { WindowRateLimiter } from '../../shared/utils/rate-limiter';
import { TtlCache } from '../../shared/utils/ttl-cache';
import { AdminUserRepository } from './admin-user.repository';
import { GoogleOAuthClient, GoogleProfile } from './google-oauth.client';

export const ADMIN_COOKIE = 'aic_admin';
const ADMIN_TOKEN_TYPE = 'aic.admin';
const LOGIN_ATTEMPTS_PER_MINUTE = 10;
/** A disabled or demoted member loses access within this long. */
const ADMIN_CACHE_TTL_MS = 10_000;
export const MIN_PASSWORD_LENGTH = 10;
export const GOOGLE_CALLBACK_PATH = '/admin/api/auth/google/callback';
const OAUTH_STATE_TYPE = 'aic.oauth-state';
const OAUTH_STATE_TTL_SEC = 600;
const MAX_NAME_LENGTH = 120;

interface AdminTokenClaims extends TokenClaims {
  sub: string;
}

interface OAuthStateClaims extends TokenClaims {
  nonce: string;
}

export interface AdminPrincipal {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

const toPrincipal = (user: AdminUser): AdminPrincipal => ({ id: user.id, email: user.email, name: user.name, role: user.role });

/**
 * Dashboard sign-in. Built-in accounts with scrypt-hashed passwords; the first
 * admin is created from ADMIN_EMAIL / ADMIN_PASSWORD on first boot. With
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET set, anyone may also sign in with
 * Google and gets a GUEST account. The
 * session is an HS256 token in an httpOnly, SameSite=Strict cookie, so page
 * scripts cannot read it and other sites cannot send it.
 */
@Injectable()
export class AdminAuthService implements OnApplicationBootstrap {
  private readonly log = getLogger(AdminAuthService.name);
  private readonly loginLimiter = new WindowRateLimiter(LOGIN_ATTEMPTS_PER_MINUTE);
  private readonly principals = new TtlCache<AdminUser>(ADMIN_CACHE_TTL_MS);
  /** A real hash to verify against for unknown emails, so both paths cost the same. */
  private readonly dummyHash = hashPassword(randomToken());

  constructor(
    private readonly users: AdminUserRepository,
    private readonly google: GoogleOAuthClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBootstrapAdmin();
  }

  async login(email: string, password: string, clientIp: string): Promise<{ principal: AdminPrincipal; token: string }> {
    if (!this.loginLimiter.tryAcquire(`${clientIp}:${email.toLowerCase()}`)) {
      throw new RateLimitedError();
    }
    const user = await this.users.findByEmail(email);
    // Verify a hash even for unknown emails, so timing does not reveal which emails exist.
    const valid = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !valid || user.status !== RecordStatus.ACTIVE) {
      throw new UnauthorizedError('incorrect email or password');
    }
    await this.users.update(user.id, { lastLoginAt: new Date() });
    this.log.info({ adminId: user.id }, 'dashboard sign-in');
    return { principal: toPrincipal(user), token: this.issueToken(user.id) };
  }

  isGoogleSignInEnabled(): boolean {
    return this.google.isConfigured();
  }

  /** The nonce goes into a browser cookie and the signed state, binding the callback to the browser that started it. */
  beginGoogleSignIn(): { url: string; nonce: string } {
    const nonce = randomToken(16);
    const state = signToken({ typ: OAUTH_STATE_TYPE, nonce }, this.oauthStateKey(), OAUTH_STATE_TTL_SEC);
    return { url: this.google.authorizationUrl(state, this.googleRedirectUri()), nonce };
  }

  /**
   * Signs in the dashboard member with this verified Google email, creating a
   * GUEST account on first visit. Checking the nonce stops login CSRF: nobody
   * can complete a sign-in they started into someone else's browser.
   */
  async completeGoogleSignIn(code: string, state: string, nonce: string | undefined): Promise<{ principal: AdminPrincipal; token: string }> {
    const claims = verifyToken<OAuthStateClaims>(state, this.oauthStateKey(), OAUTH_STATE_TYPE);
    if (!claims || typeof claims.nonce !== 'string' || !nonce || !safeEqual(claims.nonce, nonce)) {
      throw new UnauthorizedError('sign-in expired — please try again');
    }
    const profile = await this.google.fetchProfile(code, this.googleRedirectUri());
    if (!profile.emailVerified) {
      throw new UnauthorizedError('your Google email address is not verified');
    }
    const user = await this.findOrCreateGuest(profile);
    if (user.status !== RecordStatus.ACTIVE) {
      throw new UnauthorizedError('this account is disabled');
    }
    await this.users.update(user.id, { lastLoginAt: new Date() });
    this.log.info({ adminId: user.id, role: user.role }, 'dashboard sign-in with Google');
    return { principal: toPrincipal(user), token: this.issueToken(user.id) };
  }

  async authenticate(token: string | undefined): Promise<AdminPrincipal | null> {
    if (!token) {
      return null;
    }
    const claims = verifyToken<AdminTokenClaims>(token, this.key(), ADMIN_TOKEN_TYPE);
    if (!claims) {
      return null;
    }
    const user = await this.principals.get(claims.sub, () => this.users.findById(claims.sub));
    return user && user.status === RecordStatus.ACTIVE ? toPrincipal(user) : null;
  }

  invalidate(adminId: string): void {
    this.principals.invalidate(adminId);
  }

  cookieOptions(): { httpOnly: boolean; sameSite: 'strict'; secure: boolean; path: string; maxAge: number } {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.PUBLIC_APP_URL.startsWith('https://'),
      path: '/',
      maxAge: config.ADMIN_SESSION_TTL_SEC * 1000,
    };
  }

  private issueToken(adminId: string): string {
    return signToken({ typ: ADMIN_TOKEN_TYPE, sub: adminId }, this.key(), config.ADMIN_SESSION_TTL_SEC);
  }

  private key(): Buffer {
    return deriveKey(config.AUTH_SECRET ?? '', 'admin-session');
  }

  private oauthStateKey(): Buffer {
    return deriveKey(config.AUTH_SECRET ?? '', 'google-oauth-state');
  }

  private googleRedirectUri(): string {
    return `${dashboardPublicUrl()}${GOOGLE_CALLBACK_PATH}`;
  }

  /** The password is random and never shown, so a Google-created account can only sign in through Google. */
  private async findOrCreateGuest(profile: GoogleProfile): Promise<AdminUser> {
    const existing = await this.users.findByEmail(profile.email);
    if (existing) {
      return existing;
    }
    try {
      const created = await this.users.create({
        email: profile.email,
        name: (profile.name ?? profile.email).slice(0, MAX_NAME_LENGTH),
        passwordHash: await hashPassword(randomToken()),
        role: AdminRole.GUEST,
      });
      this.log.info({ adminId: created.id }, 'guest dashboard account created');
      return created;
    } catch (error) {
      // Two first sign-ins racing on one email: the loser reads the winner's row.
      const raced = isDuplicateKeyError(error) ? await this.users.findByEmail(profile.email) : null;
      if (!raced) {
        throw error;
      }
      return raced;
    }
  }

  /** Creates the first admin from env, once. Changing the env later does not change the password. */
  private async ensureBootstrapAdmin(): Promise<void> {
    if ((await this.users.count()) > 0) {
      return;
    }
    if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
      this.log.warn('no dashboard users exist — set ADMIN_EMAIL and ADMIN_PASSWORD and restart to create the first admin');
      return;
    }
    if (config.ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
      this.log.error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters — first admin not created`);
      return;
    }
    await this.users.create({
      email: config.ADMIN_EMAIL,
      name: 'Administrator',
      passwordHash: await hashPassword(config.ADMIN_PASSWORD),
      role: AdminRole.ADMIN,
    });
    this.log.info('first dashboard admin created from ADMIN_EMAIL');
  }
}

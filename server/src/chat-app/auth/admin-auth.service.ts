import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { config } from '../../shared/config/config';
import { AdminUser } from '../../shared/database/entities';
import { AdminRole, RecordStatus } from '../../shared/domain/enums';
import { RateLimitedError, UnauthorizedError } from '../../shared/errors/app-errors';
import { getLogger } from '../../shared/logger/logger';
import { deriveKey, hashPassword, randomToken, verifyPassword } from '../../shared/security/crypto';
import { signToken, TokenClaims, verifyToken } from '../../shared/security/signed-token';
import { WindowRateLimiter } from '../../shared/utils/rate-limiter';
import { TtlCache } from '../../shared/utils/ttl-cache';
import { AdminUserRepository } from './admin-user.repository';

export const ADMIN_COOKIE = 'aic_admin';
const ADMIN_TOKEN_TYPE = 'aic.admin';
const LOGIN_ATTEMPTS_PER_MINUTE = 10;
/** A disabled or demoted member loses access within this long. */
const ADMIN_CACHE_TTL_MS = 10_000;
export const MIN_PASSWORD_LENGTH = 10;

interface AdminTokenClaims extends TokenClaims {
  sub: string;
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
 * admin is created from ADMIN_EMAIL / ADMIN_PASSWORD on first boot. The
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

  constructor(private readonly users: AdminUserRepository) {}

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

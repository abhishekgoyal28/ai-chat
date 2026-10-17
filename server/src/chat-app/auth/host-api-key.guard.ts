import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { config } from '../../shared/config/config';
import { ApiKey } from '../../shared/database/entities';
import { RateLimitedError, UnauthorizedError } from '../../shared/errors/app-errors';
import { sha256Hex } from '../../shared/security/crypto';
import { extractBearerToken } from '../../shared/security/session-token';
import { WindowRateLimiter } from '../../shared/utils/rate-limiter';
import { TtlCache } from '../../shared/utils/ttl-cache';
import { ApiKeyRepository } from './api-key.repository';

export const API_KEY_PREFIX = 'aic_';

/** A revoked key stops working within this long on every pod. */
const KEY_CACHE_TTL_MS = 30_000;
/** lastUsedAt is a hint for operators, not an audit log — written at most this often per key. */
const TOUCH_INTERVAL_MS = 60_000;

export interface HostRequest extends Request {
  apiKey: Pick<ApiKey, 'id' | 'name'>;
}

/**
 * Host API authentication: `Authorization: Bearer aic_…`. Keys are created in
 * the dashboard and only their SHA-256 is stored, so a database leak does not
 * leak usable keys. These are server-to-server credentials — never ship one
 * to a browser or app; clients get a session token instead.
 */
@Injectable()
export class HostApiKeyGuard implements CanActivate {
  private readonly cache = new TtlCache<ApiKey>(KEY_CACHE_TTL_MS);
  private readonly limiter = new WindowRateLimiter(config.HOST_API_RATE_LIMIT_PER_MINUTE);
  private readonly lastTouched = new Map<string, number>();

  constructor(private readonly apiKeys: ApiKeyRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HostRequest>();
    const presented = extractBearerToken(request.headers.authorization);
    if (!presented?.startsWith(API_KEY_PREFIX)) {
      throw new UnauthorizedError('a host API key is required: Authorization: Bearer aic_…');
    }
    const keyHash = sha256Hex(presented);
    const apiKey = await this.cache.get(keyHash, () => this.apiKeys.findActiveByHash(keyHash));
    if (!apiKey) {
      throw new UnauthorizedError('invalid or revoked API key');
    }
    if (!this.limiter.tryAcquire(apiKey.id)) {
      throw new RateLimitedError();
    }
    this.touch(apiKey.id);
    request.apiKey = { id: apiKey.id, name: apiKey.name };
    return true;
  }

  private touch(id: string): void {
    const now = Date.now();
    if (now - (this.lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) {
      return;
    }
    this.lastTouched.set(id, now);
    void this.apiKeys.touch(id, new Date(now)).catch(() => undefined);
  }
}

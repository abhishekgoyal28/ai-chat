import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { config } from '../../shared/config/config';
import { RateLimitedError, UnauthorizedError } from '../../shared/errors/app-errors';
import { extractBearerToken, SessionTokenClaims, verifySessionToken } from '../../shared/security/session-token';
import { WindowRateLimiter } from '../../shared/utils/rate-limiter';

export interface ClientRequest extends Request {
  session: SessionTokenClaims;
}

/**
 * Client API authentication: the session token minted for ONE conversation.
 * Every client route reads the conversation id from the token, never from the
 * path, so a client can only ever touch its own conversation.
 */
@Injectable()
export class ClientSessionGuard implements CanActivate {
  private readonly limiter = new WindowRateLimiter(config.CLIENT_API_RATE_LIMIT_PER_MINUTE);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ClientRequest>();
    const token = extractBearerToken(request.headers.authorization);
    const claims = token ? verifySessionToken(token) : null;
    if (!claims) {
      throw new UnauthorizedError('a valid session token is required');
    }
    if (!this.limiter.tryAcquire(claims.cid)) {
      throw new RateLimitedError();
    }
    request.session = claims;
    return true;
  }
}

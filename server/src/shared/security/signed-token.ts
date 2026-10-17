import { hmacSha256Hex, safeEqual } from './crypto';

/**
 * Compact HS256 JSON Web Tokens. Standard format — any JWT library can read
 * them — implemented on node:crypto so all three services verify tokens the
 * same way without a framework dependency.
 *
 * The algorithm is fixed: the header is never trusted to choose it, which
 * rules out the classic `alg: none` and algorithm-confusion attacks.
 */

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export interface TokenClaims {
  /** Issued-at and expiry, seconds since epoch. */
  iat: number;
  exp: number;
  /** Token purpose. Verification fails when it does not match. */
  typ: string;
  [claim: string]: unknown;
}

export const signToken = (claims: Omit<TokenClaims, 'iat' | 'exp'>, key: Buffer, ttlSeconds: number): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds })).toString('base64url');
  const signingInput = `${HEADER}.${payload}`;
  const signature = Buffer.from(hmacSha256Hex(key, signingInput), 'hex').toString('base64url');
  return `${signingInput}.${signature}`;
};

/** Returns the claims, or null for anything malformed, forged, expired or of another type. */
export const verifyToken = <T extends TokenClaims>(token: string, key: Buffer, expectedType: string): T | null => {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }
  const [header, payload, signature] = segments;
  if (header !== HEADER) {
    return null;
  }
  const expected = Buffer.from(hmacSha256Hex(key, `${header}.${payload}`), 'hex').toString('base64url');
  if (!safeEqual(signature, expected)) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
    if (claims.typ !== expectedType || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};

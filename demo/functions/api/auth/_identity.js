/**
 * The demo's own "remember me": a signed, httpOnly cookie holding the Google
 * user id and display name — never the chat token — so a returning visitor
 * resumes their conversation without signing in again.
 */
import { signPayload, verifyPayload } from './_crypto.js';

const COOKIE = 'aic_demo';
const PURPOSE = 'demo-identity';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_ATTRIBUTES = 'Path=/api; HttpOnly; Secure; SameSite=Lax';

export async function identityCookie(secret, identity) {
  const token = await signPayload(secret, PURPOSE, { userId: identity.userId, userName: identity.userName }, TTL_SECONDS);
  return `${COOKIE}=${token}; Max-Age=${TTL_SECONDS}; ${COOKIE_ATTRIBUTES}`;
}

export function clearedIdentityCookie() {
  return `${COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/** Returns { userId, userName } or null. */
export async function readIdentity(secret, request) {
  const cookies = request.headers.get('cookie') ?? '';
  const match = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const payload = await verifyPayload(secret, PURPOSE, match.slice(COOKIE.length + 1));
  return payload ? { userId: payload.userId, userName: payload.userName } : null;
}

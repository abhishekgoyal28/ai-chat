/** POST /api/auth/logout — forgets the visitor; their next visit shows the sign-in page. */
import { clearedIdentityCookie } from './_identity.js';

export function onRequestPost() {
  return new Response(null, { status: 204, headers: { 'Set-Cookie': clearedIdentityCookie() } });
}

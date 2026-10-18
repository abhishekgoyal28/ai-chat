/**
 * GET /api/session — for a visitor who signed in before: resumes their
 * conversation and returns a fresh chat token. Also how the page renews an
 * expired token. 401 means "show the sign-in page".
 */
import { startChatSession } from './auth/_chat-session.js';
import { readIdentity } from './auth/_identity.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function onRequestGet({ env, request }) {
  const identity = await readIdentity(env.OAUTH_SECRET, request);
  if (!identity) {
    return new Response(JSON.stringify({ error: 'not signed in' }), { status: 401, headers: NO_STORE });
  }
  const session = await startChatSession(env, identity);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Failed to start chat session. The platform may be unavailable.' }), { status: 502, headers: NO_STORE });
  }
  return new Response(JSON.stringify(session), { status: 200, headers: NO_STORE });
}

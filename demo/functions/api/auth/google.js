/**
 * GET /api/auth/google — redirect the user to Google's OAuth consent screen.
 */
import { buildState } from './_state.js';

export async function onRequest({ env, request }) {
  const callbackUrl = new URL('/api/auth/callback', new URL(request.url).origin).toString();
  const state = await buildState(env.OAUTH_SECRET, callbackUrl);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    302,
  );
}

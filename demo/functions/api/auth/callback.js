/**
 * GET /api/auth/callback — Google OAuth callback.
 *
 * Exchanges the code for the user's Google profile, remembers who they are in
 * a signed cookie, and returns to the demo page, which starts the chat through
 * /api/session.
 */
import { identityCookie } from './_identity.js';
import { verifyState } from './_state.js';

export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return errorRedirect(url.origin, `Google sign-in cancelled: ${errorParam}`);
  }
  if (!code || !state) {
    return errorRedirect(url.origin, 'Invalid OAuth callback — missing code or state.');
  }

  const callbackUrl = `${url.origin}/api/auth/callback`;
  if (!(await verifyState(env.OAUTH_SECRET, state, callbackUrl))) {
    return errorRedirect(url.origin, 'OAuth state mismatch. Please try signing in again.');
  }

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResp.ok) {
    console.error('Google token exchange failed:', tokenResp.status);
    return errorRedirect(url.origin, 'Google token exchange failed. Please try again.');
  }
  const { access_token } = await tokenResp.json();

  const profileResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!profileResp.ok) {
    return errorRedirect(url.origin, 'Failed to fetch user profile from Google.');
  }
  const profile = await profileResp.json();

  const cookie = await identityCookie(env.OAUTH_SECRET, {
    userId: `google:${profile.sub}`,
    userName: profile.name ?? profile.email ?? 'Guest',
  });
  return new Response(null, { status: 302, headers: { Location: `${url.origin}/`, 'Set-Cookie': cookie } });
}

function errorRedirect(origin, message) {
  const url = new URL('/', origin);
  url.hash = `error=${encodeURIComponent(message)}`;
  return Response.redirect(url.toString(), 302);
}

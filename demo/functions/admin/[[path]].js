/**
 * /admin and /admin/* — the admin dashboard and its API, served from this site
 * by forwarding to the ai-chat deployment (AIC_API_URL). Keeping one browser
 * origin is what lets the httpOnly, SameSite=Strict sign-in cookie and the
 * Google sign-in redirect work here. Set DASHBOARD_PUBLIC_URL on the
 * deployment to this site's URL so Google returns to it.
 */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export async function onRequest({ request, env }) {
  const base = String(env.AIC_API_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    return new Response('AIC_API_URL is not configured', { status: 500 });
  }
  const incoming = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));

  const upstream = await fetch(`${base}${incoming.pathname}${incoming.search}`, {
    method: request.method,
    headers,
    body: BODYLESS_METHODS.has(request.method) ? undefined : request.body,
    // Pass redirects (Google sign-in, post-login) to the browser instead of following them here.
    redirect: 'manual',
  });
  return new Response(upstream.body, upstream);
}

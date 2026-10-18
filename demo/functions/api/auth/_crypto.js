/**
 * HMAC-SHA256 signed, expiring payloads: `base64url(json).base64url(sig)`.
 * Prefixed with _ so Cloudflare Pages does not treat this as a route.
 * `purpose` keeps tokens for one use from being accepted for another.
 */

export async function signPayload(secret, purpose, payload, ttlSeconds) {
  const body = b64urlFromString(JSON.stringify({ ...payload, purpose, exp: Date.now() + ttlSeconds * 1000 }));
  return `${body}.${await signature(secret, body)}`;
}

/** Returns the payload, or null for anything malformed, forged, expired or of another purpose. */
export async function verifyPayload(secret, purpose, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  if (token.slice(dot + 1) !== (await signature(secret, body))) return null;
  try {
    const payload = JSON.parse(stringFromB64url(body));
    if (payload.purpose !== purpose || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function signature(secret, data) {
  if (!secret) throw new Error('OAUTH_SECRET is not configured');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return b64urlFromBytes(bytes);
}

function b64urlFromString(text) {
  return b64urlFromBytes(new TextEncoder().encode(text));
}

function b64urlFromBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function stringFromB64url(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

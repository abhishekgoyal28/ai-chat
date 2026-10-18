/**
 * OAuth `state`: signed and short-lived, bound to the callback URL, so the
 * callback can trust it without server storage.
 */
import { signPayload, verifyPayload } from './_crypto.js';

const PURPOSE = 'oauth-state';
const TTL_SECONDS = 10 * 60;

export function buildState(secret, callbackUrl) {
  return signPayload(secret, PURPOSE, { callbackUrl, nonce: crypto.randomUUID() }, TTL_SECONDS);
}

export async function verifyState(secret, state, callbackUrl) {
  const payload = await verifyPayload(secret, PURPOSE, state);
  return payload !== null && payload.callbackUrl === callbackUrl;
}

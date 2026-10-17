/**
 * A minimal "host product" backend — the part YOU write when integrating
 * ai-chat. No dependencies; Node 20+.
 *
 *   AIC_URL=http://localhost:8080 AIC_API_KEY=aic_... AIC_AGENT=support \
 *   AIC_WEBHOOK_SECRET=... node server.mjs
 *   open http://localhost:4000
 *
 * It does the three things every integration does:
 *   1. POST /api/chat/session — for the signed-in user, ask ai-chat for a
 *      session (server-to-server, with the API key) and hand the short-lived
 *      token to the browser. The API key never leaves this server.
 *   2. POST /webhooks/ai-chat — receive events, verify their signature.
 *   3. Serve the page that embeds the chat (index.html + the SDK bundle).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const AIC_URL = (process.env.AIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const AIC_API_KEY = process.env.AIC_API_KEY ?? '';
const AIC_AGENT = process.env.AIC_AGENT ?? 'support';
const WEBHOOK_SECRET = process.env.AIC_WEBHOOK_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 4000);
const SIGNATURE_TOLERANCE_SEC = 300;

if (!AIC_API_KEY) {
  console.error('Set AIC_API_KEY to a host API key from the dashboard (API keys page).');
  process.exit(1);
}

/** Your real app identifies the user from its own session. This demo trusts a query parameter. */
const currentUser = (url) => ({
  id: url.searchParams.get('user') ?? 'demo-user-1',
  name: url.searchParams.get('name') ?? 'Demo User',
  attributes: { plan: 'pro', signupYear: '2024' },
});

const startChatSession = async (user, scope) => {
  const response = await fetch(`${AIC_URL}/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AIC_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: AIC_AGENT,
      user,
      ...(scope && { scope }),
      context: { title: 'Help center', text: 'The user opened the chat from the help center page.' },
    }),
  });
  if (!response.ok) {
    throw new Error(`ai-chat answered ${response.status}: ${await response.text()}`);
  }
  // Only what the browser needs — never the API key.
  const { conversationId, token, tokenExpiresAt, socketUrl, apiUrl } = await response.json();
  return { conversationId, token, tokenExpiresAt, socketUrl, apiUrl };
};

/** AIC-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")> */
const verifySignature = (header, rawBody) => {
  if (!WEBHOOK_SECRET) {
    return true;
  }
  const parts = Object.fromEntries(String(header ?? '').split(',').map((part) => part.split('=')));
  const timestamp = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SEC) {
    return false;
  }
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
};

const readBody = (request) =>
  new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });

const send = (response, status, body, type = 'application/json') => {
  response.writeHead(status, { 'content-type': type });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  try {
    if (request.method === 'POST' && url.pathname === '/api/chat/session') {
      return send(response, 200, await startChatSession(currentUser(url), url.searchParams.get('scope') ?? undefined));
    }
    if (request.method === 'POST' && url.pathname === '/webhooks/ai-chat') {
      const raw = await readBody(request);
      if (!verifySignature(request.headers['aic-signature'], raw)) {
        return send(response, 401, { error: 'bad signature' });
      }
      const event = JSON.parse(raw);
      console.log(`webhook ${event.type}`, JSON.stringify(event.data));
      if (event.type === 'action.invoked') {
        // Do the real work here: create the ticket, page a human, book the slot…
        console.log(`→ would run action "${event.data.action}" with`, event.data.arguments);
      }
      return send(response, 200, { received: true });
    }
    if (request.method === 'GET' && url.pathname === '/ai-chat.js') {
      const bundle = await readFile(join(here, '../../sdk/js/dist/ai-chat.global.js'), 'utf8');
      return send(response, 200, bundle, 'text/javascript');
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, await readFile(join(here, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    send(response, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    send(response, 500, { error: error.message });
  }
}).listen(PORT, () => console.log(`host example on http://localhost:${PORT} → ai-chat at ${AIC_URL}, agent "${AIC_AGENT}"`));

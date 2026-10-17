/**
 * End-to-end smoke test against a running deployment.
 *
 * Drives the platform the way a real product would: signs in to the admin
 * API, creates a Mock provider and a test agent, mints a host API key, starts
 * a session through the host API, chats over the WebSocket, and checks the
 * reply, the ordering, the end-of-session farewell and the cleanup paths.
 *
 *   AIC_URL=https://chat.example.com ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run smoke -w server   (or, in a container: node dist/tools/smoke-test.js)
 *
 * Optional: AIC_SOCKET_URL when the socket is served on another origin.
 * Everything it creates is named "smoke-…" and is disabled or revoked at the end.
 */
import { io, Socket } from 'socket.io-client';

const APP_URL = (process.env.AIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const SOCKET_URL = (process.env.AIC_SOCKET_URL ?? APP_URL).replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const RUN_ID = Date.now().toString(36);

let adminCookie = '';
let failures = 0;

const check = (condition: unknown, label: string): void => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
  }
};

const request = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
  const response = await fetch(`${APP_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(adminCookie && { cookie: adminCookie }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie?.startsWith('aic_admin=')) {
    adminCookie = setCookie.split(';')[0];
  }
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  }
  return parsed as T;
};

interface Frame {
  event: string;
  payload: Record<string, unknown>;
}

/** Collects every server frame, and resolves waiters as matching frames arrive. */
class FrameLog {
  readonly frames: Frame[] = [];
  private waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];

  constructor(socket: Socket) {
    socket.onAny((event: string, payload: Record<string, unknown>) => {
      const frame = { event, payload };
      this.frames.push(frame);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.match(frame)) {
          waiter.resolve(frame);
          return false;
        }
        return true;
      });
    });
  }

  wait(match: (frame: Frame) => boolean, label: string, timeoutMs = 20_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }
}

const emitWithAck = <T>(socket: Socket, event: string, payload: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    socket.timeout(10_000).emit(event, payload, (error: Error | null, ack: T) => (error ? reject(error) : resolve(ack)));
  });

const turn = (text: string, turnId = `t${Math.random().toString(36).slice(2, 10)}`) => ({
  clientTurnId: turnId,
  messages: [{ clientMessageId: `${turnId}m1`, body: text, sentAt: new Date().toISOString() }],
});

const main = async (): Promise<void> => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('set ADMIN_EMAIL and ADMIN_PASSWORD (the dashboard admin credentials)');
  }
  console.log(`ai-chat smoke test → ${APP_URL}`);

  console.log('\n1. Health');
  const ready = await request<{ status: string }>('GET', '/readyz');
  check(ready.status === 'ready', 'chat-app is ready');

  console.log('\n2. Admin API');
  await request('POST', '/admin/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check(adminCookie.length > 0, 'signed in to the dashboard API');
  const personas = await request<Array<{ id: string }>>('GET', '/admin/api/personas');
  const provider = await request<{ id: string }>('POST', '/admin/api/providers', {
    name: `smoke-mock-${RUN_ID}`,
    kind: 'MOCK',
    defaultModel: 'mock-1',
    settings: {},
  });
  const providerTest = await request<{ status: string; parts: string[] }>('POST', `/admin/api/providers/${provider.id}/test`, {});
  check(providerTest.status === 'SUCCESS' && providerTest.parts.length > 0, 'provider test round-trips through chat-expert');

  const agentSlug = `smoke-${RUN_ID}`;
  const agent = await request<{ id: string; revision: number }>('POST', '/admin/api/agents', {
    slug: agentSlug,
    name: `Smoke ${RUN_ID}`,
    personaId: personas[0].id,
    modelRoutes: [{ providerId: provider.id, model: 'mock-1', weight: 100 }],
    settings: {
      greeting: { mode: 'TEMPLATE', template: 'Hi {{user.name}}! Ask me anything.' },
      chips: { source: 'STATIC', items: ['What can you do?', 'Tell me more'], count: 2 },
      farewell: { mode: 'LLM' },
      pacing: { enabled: true, msPerChar: 5, maxDelayMs: 300 },
    },
  });
  check(Boolean(agent.id), 'agent created');
  const apiKey = await request<{ id: string; key: string }>('POST', '/admin/api/api-keys', { name: `smoke-${RUN_ID}` });
  check(apiKey.key.startsWith('aic_'), 'host API key minted');
  const host = { authorization: `Bearer ${apiKey.key}` };

  console.log('\n3. Host API: create session');
  const grant = await request<{ conversationId: string; token: string; created: boolean; expiresAt: string | null }>(
    'POST',
    '/v1/sessions',
    { agent: agentSlug, user: { id: `smoke-user-${RUN_ID}`, name: 'Sam', attributes: { plan: 'pro' } }, scope: 'smoke' },
    host,
  );
  check(grant.created && grant.token, 'session created with a client token');
  check(grant.expiresAt === null, 'no duration configured → the session never expires on its own');
  const again = await request<{ conversationId: string; created: boolean }>(
    'POST',
    '/v1/sessions',
    { agent: agentSlug, user: { id: `smoke-user-${RUN_ID}` }, scope: 'smoke' },
    host,
  );
  check(again.conversationId === grant.conversationId && !again.created, 'same user + agent + scope resumes the same conversation');

  const client = { authorization: `Bearer ${grant.token}` };
  const view = await request<{ messages: Array<{ kind: string; body?: string; chips?: unknown[] }>; agentProfile: { name: string } }>(
    'GET',
    '/v1/client/session',
    undefined,
    client,
  );
  check(view.messages[0]?.kind === 'GREETING' && view.messages[0]?.body === 'Hi Sam! Ask me anything.', 'template greeting rendered with the user name');
  check(view.messages.some((item) => item.kind === 'SUGGESTED_CHIPS'), 'static suggestions offered before the user speaks');

  console.log('\n4. Socket: send a turn and receive the reply');
  const socket = io(SOCKET_URL, { transports: ['websocket'], auth: { token: grant.token }, reconnection: false });
  const frames = new FrameLog(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });
  const subscribeAck = await emitWithAck<{ ok: boolean }>(socket, 'subscribe', {});
  check(subscribeAck.ok, 'subscribed to the conversation');

  const first = turn('hello there');
  const sendAck = await emitWithAck<{ ok: boolean }>(socket, 'message.send', first);
  check(sendAck.ok, 'turn accepted (first tick)');
  const persisted = await frames.wait((frame) => frame.event === 'turn.persisted' && frame.payload.turnId === first.clientTurnId, 'turn.persisted');
  check(Array.isArray(persisted.payload.messages), 'turn persisted with server ids (second tick)');
  await frames.wait((frame) => frame.event === 'agent.typing', 'agent.typing');
  check(true, 'agent typing indicator received');
  const reply = await frames.wait(
    (frame) => frame.event === 'message.part' && frame.payload.requestTurnId === first.clientTurnId && frame.payload.partIndex === 1,
    'second reply part',
  );
  const firstPartIndex = frames.frames.findIndex((frame) => frame.event === 'message.part' && frame.payload.requestTurnId === first.clientTurnId && frame.payload.partIndex === 0);
  check(firstPartIndex !== -1 && firstPartIndex < frames.frames.indexOf(reply), 'reply parts revealed in order');
  check(String(frames.frames[firstPartIndex]?.payload.body).includes('hello there'), 'reply generated from the user message');

  console.log('\n5. Duplicate send is absorbed');
  const resend = await emitWithAck<{ ok: boolean }>(socket, 'message.send', first);
  check(resend.ok, 'identical resend is acked');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const replies = frames.frames.filter((frame) => frame.event === 'message.part' && frame.payload.requestTurnId === first.clientTurnId && frame.payload.partIndex === 0);
  check(replies.length === 1, 'and does not produce a second reply');

  console.log('\n6. Failure and retry');
  const failing = turn('please #fail');
  await emitWithAck(socket, 'message.send', failing);
  const failed = await frames.wait((frame) => frame.event === 'turn.failed' && frame.payload.turnId === failing.clientTurnId, 'turn.failed');
  check(failed.payload.retryable === true, 'failed generation surfaces turn.failed (retryable)');

  console.log('\n7. History and message actions');
  const history = await request<{ messages: Array<{ id: string; senderType: string; status: string }> }>('GET', '/v1/client/messages', undefined, client);
  check(history.messages.some((message) => message.status === 'FAILED'), 'failed turn is visible in history with status FAILED');
  const agentMessage = history.messages.find((message) => message.senderType === 'AGENT');
  if (agentMessage) {
    const pinned = await request<Array<{ pinnedAt?: string }>>('PUT', `/v1/client/messages/${agentMessage.id}/pin`, undefined, client);
    check(Boolean(pinned[pinned.length - 1]?.pinnedAt), 'message pinned');
    await frames.wait((frame) => frame.event === 'message.updated', 'message.updated');
    check(true, 'message.updated broadcast to the socket');
  }

  console.log('\n8. End the session');
  await request('POST', '/v1/client/end', undefined, client);
  const ended = await frames.wait((frame) => frame.event === 'session.ended', 'session.ended');
  check(ended.payload.endReason === 'USER_ENDED', 'session.ended with reason USER_ENDED');
  await frames.wait((frame) => frame.event === 'session.completed', 'session.completed');
  const farewell = frames.frames.find((frame) => frame.event === 'message.part' && frame.payload.kind === 'FAREWELL');
  const divider = frames.frames.find((frame) => frame.event === 'message.part' && frame.payload.kind === 'SESSION_END');
  check(Boolean(divider) && Boolean(farewell), 'divider and LLM-written farewell delivered before session.completed');
  const rejected = turn('after the end');
  await emitWithAck(socket, 'message.send', rejected);
  const sessionEndedError = await frames.wait((frame) => frame.event === 'error' && frame.payload.turnId === rejected.clientTurnId, 'rejection');
  check(sessionEndedError.payload.code === 'SESSION_ENDED', 'turns after the end are rejected with SESSION_ENDED');
  socket.close();

  const reopened = await request<{ status: string; created: boolean }>('POST', '/v1/sessions', { agent: agentSlug, user: { id: `smoke-user-${RUN_ID}` }, scope: 'smoke' }, host);
  check(reopened.status === 'ENDED' && !reopened.created, 'an ended session reopens read-only');

  console.log('\n9. Cleanup');
  await request('DELETE', `/v1/users/smoke-user-${RUN_ID}`, undefined, host);
  const after = await request<{ sessions: unknown[] }>('GET', `/v1/users/smoke-user-${RUN_ID}/sessions`, undefined, host);
  check(after.sessions.length === 0, 'user data erased');
  await request('DELETE', `/admin/api/agents/${agent.id}`);
  await request('DELETE', `/admin/api/providers/${provider.id}`);
  await request('DELETE', `/admin/api/api-keys/${apiKey.id}`);
  check(true, 'test agent, provider and API key removed');

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(`\nSmoke test aborted: ${(error as Error).message}`);
  process.exit(1);
});

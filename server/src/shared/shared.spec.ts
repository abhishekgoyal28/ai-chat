import { validateTurnPayload } from './contracts/turn-validation';
import { SocketErrorCode } from './contracts/socket-protocol';
import { parseAgentSettings, readStoredAgentSettings } from './domain/agent-settings';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword, deriveKey } from './security/crypto';
import { signToken, verifyToken } from './security/signed-token';
import { WindowRateLimiter } from './utils/rate-limiter';
import { TtlCache } from './utils/ttl-cache';

describe('agent settings', () => {
  it('fills every default, with sessions that never end unless a duration is set', () => {
    const settings = parseAgentSettings({});
    expect(settings.session.durationSec).toBeNull();
    expect(settings.farewell.mode).toBe('LLM');
    expect(settings.reply.maxParts).toBe(4);
  });

  it('rejects an out-of-range duration', () => {
    expect(() => parseAgentSettings({ session: { durationSec: 5 } })).toThrow();
  });

  it('reads an invalid stored row section by section instead of failing the agent', () => {
    const settings = readStoredAgentSettings({ session: { durationSec: 5 }, greeting: { mode: 'NONE' } });
    expect(settings.session.durationSec).toBeNull();
    expect(settings.greeting.mode).toBe('NONE');
  });
});

describe('turn validation', () => {
  const limits = { maxMessagesPerTurn: 2, maxBodyChars: 10 };
  const message = (id: string, body = 'hi') => ({ clientMessageId: id, body, sentAt: new Date().toISOString() });

  it('accepts a well-formed turn', () => {
    expect(validateTurnPayload({ clientTurnId: 'turn_1', messages: [message('m1')] }, limits)).toBeNull();
  });

  it.each([
    [{ clientTurnId: 'bad id!', messages: [message('m1')] }, SocketErrorCode.INVALID_PAYLOAD],
    [{ clientTurnId: 't', messages: [message('a'), message('b'), message('c')] }, SocketErrorCode.TOO_MANY_MESSAGES],
    [{ clientTurnId: 't', messages: [message('a', 'x'.repeat(11))] }, SocketErrorCode.MESSAGE_TOO_LONG],
    [{ clientTurnId: 't', messages: [message('a'), message('a')] }, SocketErrorCode.INVALID_PAYLOAD],
    [{ clientTurnId: 't', messages: [{ ...message('a'), replyToId: 'abc' }] }, SocketErrorCode.INVALID_PAYLOAD],
  ])('rejects %j', (payload, code) => {
    expect(validateTurnPayload(payload, limits)?.code).toBe(code);
  });
});

describe('crypto', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips secrets and detects tampering', () => {
    const sealed = encryptSecret('sk-test-123', key);
    expect(decryptSecret(sealed, key)).toBe('sk-test-123');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('signs tokens bound to a type and key', () => {
    const sessionKey = deriveKey('a'.repeat(40), 'session');
    const token = signToken({ typ: 'session', cid: '1' }, sessionKey, 60);
    expect(verifyToken(token, sessionKey, 'session')?.cid).toBe('1');
    expect(verifyToken(token, sessionKey, 'admin')).toBeNull();
    expect(verifyToken(token, deriveKey('a'.repeat(40), 'admin'), 'session')).toBeNull();
    expect(verifyToken(signToken({ typ: 'session' }, sessionKey, -1), sessionKey, 'session')).toBeNull();
  });
});

describe('utilities', () => {
  it('rate limiter blocks past the limit within a window', () => {
    const limiter = new WindowRateLimiter(2, 1000);
    expect([limiter.tryAcquire('k', 0), limiter.tryAcquire('k', 1), limiter.tryAcquire('k', 2)]).toEqual([true, true, false]);
    expect(limiter.tryAcquire('k', 1500)).toBe(true);
  });

  it('ttl cache coalesces concurrent loads', async () => {
    const cache = new TtlCache<number>(1000);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return 42;
    };
    const values = await Promise.all([cache.get('x', load), cache.get('x', load), cache.get('x', load)]);
    expect(values).toEqual([42, 42, 42]);
    expect(loads).toBe(1);
  });
});

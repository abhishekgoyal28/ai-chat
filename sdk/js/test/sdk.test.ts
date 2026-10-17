import { describe, expect, it } from 'vitest';
import { MessageStore } from '../src/message-store';
import { TimerApi, TurnBatcher } from '../src/turn-batcher';

const config = { debounceMs: 1000, typingHoldMs: 2000, maxTurnWaitMs: 5000, maxMessagesPerTurn: 3, maxBodyChars: 100 };

/** A manual clock so batching can be tested without waiting. */
const fakeTimers = () => {
  let now = 0;
  let pending: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  const api: TimerApi = {
    set: (callback, ms) => {
      const id = nextId++;
      pending.push({ at: now + ms, callback, id });
      return id;
    },
    clear: (id) => {
      pending = pending.filter((timer) => timer.id !== id);
    },
    now: () => now,
  };
  const advance = (ms: number) => {
    now += ms;
    const due = pending.filter((timer) => timer.at <= now);
    pending = pending.filter((timer) => timer.at > now);
    due.forEach((timer) => timer.callback());
  };
  return { api, advance };
};

const message = (id: string) => ({ clientMessageId: id, body: id, sentAt: new Date().toISOString() });

describe('TurnBatcher', () => {
  it('sends messages typed in quick succession as one turn', () => {
    const timers = fakeTimers();
    const batches: string[][] = [];
    const batcher = new TurnBatcher(config, (batch) => batches.push(batch.map((m) => m.clientMessageId)), timers.api);
    batcher.add(message('a'));
    timers.advance(500);
    batcher.add(message('b'));
    timers.advance(999);
    expect(batches).toEqual([]);
    timers.advance(1);
    expect(batches).toEqual([['a', 'b']]);
  });

  it('holds the batch while the user keeps typing, up to typingHoldMs past the last message', () => {
    const timers = fakeTimers();
    const batches: string[][] = [];
    const batcher = new TurnBatcher(config, (batch) => batches.push(batch.map((m) => m.clientMessageId)), timers.api);
    batcher.add(message('a'));
    for (let elapsed = 0; elapsed < 2800; elapsed += 400) {
      timers.advance(400);
      batcher.typing();
    }
    expect(batches).toEqual([]);
    timers.advance(400);
    // debounce (1000) + typingHold (2000) after the message.
    expect(batches).toEqual([['a']]);
  });

  it('is not delayed by keystrokes made before the message was sent', () => {
    const timers = fakeTimers();
    const batches: string[][] = [];
    const batcher = new TurnBatcher(config, (batch) => batches.push(batch.map((m) => m.clientMessageId)), timers.api);
    batcher.typing();
    batcher.add(message('a'));
    timers.advance(1000);
    expect(batches).toEqual([['a']]);
  });

  it('never waits past maxTurnWaitMs from the first message', () => {
    const timers = fakeTimers();
    const batches: string[][] = [];
    const batcher = new TurnBatcher({ ...config, typingHoldMs: 60_000 }, (batch) => batches.push(batch.map((m) => m.clientMessageId)), timers.api);
    batcher.add(message('a'));
    for (let elapsed = 0; elapsed < 4800; elapsed += 200) {
      timers.advance(200);
      batcher.typing();
    }
    expect(batches).toEqual([]);
    timers.advance(400);
    expect(batches).toEqual([['a']]);
  });

  it('flushes immediately at the per-turn message limit', () => {
    const timers = fakeTimers();
    const batches: string[][] = [];
    const batcher = new TurnBatcher(config, (batch) => batches.push(batch.map((m) => m.clientMessageId)), timers.api);
    ['a', 'b', 'c'].forEach((id) => batcher.add(message(id)));
    expect(batches).toEqual([['a', 'b', 'c']]);
  });
});

describe('MessageStore', () => {
  const wire = (id: string, overrides = {}) => ({
    id,
    conversationId: '1',
    turnId: 't',
    senderType: 'AGENT' as const,
    kind: 'TEXT' as const,
    status: 'SENT',
    partIndex: 0,
    partsTotal: 1,
    body: `m${id}`,
    sentAt: null,
    ...overrides,
  });

  it('orders by server id, dedupes repeats and keeps unsent messages last', () => {
    const store = new MessageStore();
    store.upsert([wire('10'), wire('9')]);
    store.addLocal({ clientMessageId: 'c1', conversationId: '1', turnId: 't2', senderType: 'USER', kind: 'TEXT', status: 'SENDING', partIndex: 0, partsTotal: 1, body: 'hi', sentAt: null });
    store.upsert([wire('10')]);
    expect(store.list().map((m) => m.id)).toEqual(['9', '10', 'local:c1']);
  });

  it('swaps a local message for its stored row on confirmation', () => {
    const store = new MessageStore();
    store.addLocal({ clientMessageId: 'c1', conversationId: '1', turnId: 't2', senderType: 'USER', kind: 'TEXT', status: 'SENDING', partIndex: 0, partsTotal: 1, body: 'hi', sentAt: null });
    store.confirm([{ clientMessageId: 'c1', id: '11' }]);
    expect(store.list().map((m) => [m.id, m.local])).toEqual([['11', false]]);
    expect(store.newestId).toBe('11');
  });
});

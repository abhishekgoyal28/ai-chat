/**
 * Needs a real Redis: REDIS_URL=redis://localhost:6379/15 npm run test:integration -w server
 * Uses its own QUEUE_PREFIX so it never touches a deployment's queues.
 */
process.env.QUEUE_PREFIX = `aic-test-${Date.now()}`;

import { createRedisConnection } from '../redis/redis.providers';
import { QueueName } from './queue.definitions';
import { RedisQueueTransport } from './redis-queue.transport';

describe('RedisQueueTransport', () => {
  const redis = createRedisConnection('test');
  let transport: RedisQueueTransport;

  beforeEach(() => {
    transport = new RedisQueueTransport(redis);
  });

  afterEach(async () => {
    await transport.drain();
  });

  afterAll(async () => {
    const keys = await redis.keys(`${process.env.QUEUE_PREFIX}*`);
    if (keys.length) {
      await redis.del(...keys);
    }
    await redis.quit();
  });

  it('processes one group strictly in send order while other groups run in parallel', async () => {
    const seen: Record<string, number[]> = { a: [], b: [] };
    let concurrentInGroup = 0;
    let maxConcurrentInGroup = 0;
    const done = new Promise<void>((resolve) => {
      transport.consume<{ group: string; n: number }>(
        QueueName.INBOUND,
        async ({ group, n }) => {
          if (group === 'a') {
            concurrentInGroup += 1;
            maxConcurrentInGroup = Math.max(maxConcurrentInGroup, concurrentInGroup);
          }
          // Early messages are slow, so a non-ordered queue would finish them last.
          await new Promise((r) => setTimeout(r, n < 3 ? 120 : 5));
          seen[group].push(n);
          if (group === 'a') {
            concurrentInGroup -= 1;
          }
          if (seen.a.length === 6 && seen.b.length === 6) {
            resolve();
          }
        },
        { concurrency: 8 },
      );
    });

    for (let n = 0; n < 6; n += 1) {
      await transport.send(QueueName.INBOUND, { body: { group: 'a', n }, groupId: 'a' });
      await transport.send(QueueName.INBOUND, { body: { group: 'b', n }, groupId: 'b' });
    }
    await done;

    expect(seen.a).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seen.b).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxConcurrentInGroup).toBe(1);
  });

  it('drops a duplicate send inside the dedup window', async () => {
    expect(await transport.send(QueueName.REVEALS, { body: { x: 1 }, deduplicationId: 'same' })).toBe(true);
    expect(await transport.send(QueueName.REVEALS, { body: { x: 1 }, deduplicationId: 'same' })).toBe(false);
  });

  it('delivers delayed messages no earlier than their delay', async () => {
    const sentAt = Date.now();
    const received = new Promise<number>((resolve) => {
      transport.consume(QueueName.WEBHOOKS, async () => resolve(Date.now()), { concurrency: 1 });
    });
    await transport.send(QueueName.WEBHOOKS, { body: {}, delayMs: 400 });
    expect((await received) - sentAt).toBeGreaterThanOrEqual(380);
  });
});

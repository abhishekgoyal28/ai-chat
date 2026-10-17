import { DelayedError, Job, Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { config } from '../config/config';
import { describeError, getLogger } from '../logger/logger';
import { createRedisConnection } from '../redis/redis.providers';
import { DEDUPLICATION_WINDOW_MS, QUEUE_DEFINITIONS, QueueDefinition, QueueName } from './queue.definitions';
import { ConsumeOptions, OutgoingQueueMessage, QueueHandler, QueueTransport } from './queue-transport';

interface JobData {
  body: unknown;
  groupId?: string;
  /** Per-group sequence number, assigned at send time. Ordered queues only. */
  seq?: number;
}

/** A job waiting on its predecessor re-checks this often. */
const ORDERING_RETRY_MS = 150;

/**
 * How long a job may wait on a predecessor that never arrives (its producer
 * died between taking a sequence number and adding the job) before the group
 * skips ahead. Longer than any predecessor's full retry schedule.
 */
const ORDERING_GAP_TIMEOUT_MS = 120_000;

const GROUP_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ADVANCE_DONE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
end
return 1`;

/**
 * Self-hosted queue driver: BullMQ on the Redis every deployment already runs.
 *
 * BullMQ supplies durability, delays, retries with backoff and stalled-job
 * recovery. What open-source BullMQ lacks is SQS-FIFO-style per-group ordering,
 * which this class adds: every ordered message takes a per-group sequence
 * number at send time, and a worker only runs sequence N once N-1 is done.
 * An early job is moved back to delayed (no attempt is consumed), so a group
 * is strictly sequential while different groups run in parallel.
 */
export class RedisQueueTransport implements QueueTransport {
  private readonly log = getLogger(RedisQueueTransport.name);
  private readonly producerConnection: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  /** BullMQ never closes connections it was handed, so they are tracked and closed on drain. */
  private readonly workerConnections: Redis[] = [];

  constructor(private readonly redis: Redis) {
    this.producerConnection = createRedisConnection('queue-producer', { maxRetriesPerRequest: null });
  }

  async send(queueName: QueueName, message: OutgoingQueueMessage): Promise<boolean> {
    const definition = QUEUE_DEFINITIONS[queueName];
    if (message.deduplicationId && !(await this.claimDeduplication(queueName, message.deduplicationId))) {
      this.log.debug({ queue: queueName, deduplicationId: message.deduplicationId }, 'duplicate send dropped');
      return false;
    }

    try {
      const data: JobData = { body: message.body };
      if (definition.ordered) {
        if (!message.groupId) {
          throw new Error(`queue ${queueName} is ordered and requires a groupId`);
        }
        data.groupId = message.groupId;
        data.seq = await this.nextSequence(queueName, message.groupId);
      }
      await this.getQueue(queueName).add(queueName, data, {
        delay: Math.max(0, Math.round(message.delayMs ?? 0)),
        attempts: definition.maxAttempts,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      });
      return true;
    } catch (error) {
      // Release the claim so the caller's retry is not mistaken for a duplicate.
      if (message.deduplicationId) {
        await this.redis.del(this.dedupKey(queueName, message.deduplicationId)).catch(() => undefined);
      }
      throw error;
    }
  }

  consume<T>(queueName: QueueName, handler: QueueHandler<T>, options: ConsumeOptions): void {
    const definition = QUEUE_DEFINITIONS[queueName];
    const connection = createRedisConnection(`queue-worker:${queueName}`, { maxRetriesPerRequest: null });
    this.workerConnections.push(connection);
    const worker = new Worker<JobData>(
      queueName,
      (job, token) => this.process(definition, job, token, handler as QueueHandler),
      {
        connection,
        prefix: this.bullPrefix(),
        concurrency: options.concurrency,
        lockDuration: definition.visibilityTimeoutMs,
        autorun: true,
      },
    );

    worker.on('failed', (job, error) => {
      if (!job) {
        return;
      }
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      const context = {
        queue: queueName,
        jobId: job.id,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        error: describeError(error),
      };
      if (!exhausted) {
        this.log.warn(context, 'queue handler failed — will retry');
        return;
      }
      this.log.error(context, 'queue handler failed on its last attempt — message dropped');
      if (definition.ordered && job.data.groupId && job.data.seq) {
        // A dead message must not block the rest of its group forever.
        void this.advanceDone(queueName, job.data.groupId, job.data.seq);
      }
    });
    worker.on('error', (error) => this.log.error({ queue: queueName, error: describeError(error) }, 'queue worker error'));

    this.workers.push(worker);
    this.log.info({ queue: queueName, concurrency: options.concurrency }, 'queue consumer started');
  }

  async drain(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all([this.producerConnection, ...this.workerConnections].map((connection) => connection.quit().catch(() => undefined)));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  private async process(
    definition: QueueDefinition,
    job: Job<JobData>,
    token: string | undefined,
    handler: QueueHandler,
  ): Promise<void> {
    const { groupId, seq } = job.data;
    if (definition.ordered && groupId && seq) {
      const ready = await this.awaitTurn(definition.name, job, groupId, seq, token);
      if (!ready) {
        return;
      }
    }

    await handler(job.data.body, {
      queue: definition.name,
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? definition.maxAttempts,
      messageId: String(job.id),
    });

    if (definition.ordered && groupId && seq) {
      await this.advanceDone(definition.name, groupId, seq);
    }
  }

  /**
   * Returns true when this job is next in its group, false when it already ran
   * (a duplicate). Throws DelayedError — BullMQ's "not yet, consume no attempt"
   * signal — when a predecessor is still pending.
   */
  private async awaitTurn(
    queueName: QueueName,
    job: Job<JobData>,
    groupId: string,
    seq: number,
    token: string | undefined,
  ): Promise<boolean> {
    const done = Number((await this.redis.get(this.doneKey(queueName, groupId))) ?? 0);
    if (seq <= done) {
      this.log.debug({ queue: queueName, groupId, seq }, 'ordered job already processed — skipping');
      return false;
    }
    if (seq === done + 1) {
      return true;
    }
    if (Date.now() - job.timestamp > ORDERING_GAP_TIMEOUT_MS) {
      this.log.warn({ queue: queueName, groupId, seq, done }, 'predecessor never arrived — group skipping ahead');
      await this.advanceDone(queueName, groupId, seq - 1);
      return true;
    }
    await job.moveToDelayed(Date.now() + ORDERING_RETRY_MS, token);
    throw new DelayedError();
  }

  private async claimDeduplication(queueName: QueueName, deduplicationId: string): Promise<boolean> {
    const result = await this.redis.set(
      this.dedupKey(queueName, deduplicationId),
      '1',
      'PX',
      DEDUPLICATION_WINDOW_MS,
      'NX',
    );
    return result === 'OK';
  }

  private async nextSequence(queueName: QueueName, groupId: string): Promise<number> {
    const key = this.seqKey(queueName, groupId);
    const seq = await this.redis.incr(key);
    await this.redis.pexpire(key, GROUP_STATE_TTL_MS);
    return seq;
  }

  private async advanceDone(queueName: QueueName, groupId: string, seq: number): Promise<void> {
    try {
      await this.redis.eval(ADVANCE_DONE_SCRIPT, 1, this.doneKey(queueName, groupId), String(seq), String(GROUP_STATE_TTL_MS));
    } catch (error) {
      this.log.error({ queue: queueName, groupId, seq, error: describeError(error) }, 'failed to advance group cursor');
    }
  }

  private getQueue(queueName: QueueName): Queue {
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.producerConnection, prefix: this.bullPrefix() });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  private bullPrefix(): string {
    return `${config.QUEUE_PREFIX}:bull`;
  }

  private dedupKey(queueName: QueueName, id: string): string {
    return `${config.QUEUE_PREFIX}:q:dedup:${queueName}:${id}`;
  }

  private seqKey(queueName: QueueName, groupId: string): string {
    return `${config.QUEUE_PREFIX}:q:seq:${queueName}:${groupId}`;
  }

  private doneKey(queueName: QueueName, groupId: string): string {
    return `${config.QUEUE_PREFIX}:q:done:${queueName}:${groupId}`;
  }
}

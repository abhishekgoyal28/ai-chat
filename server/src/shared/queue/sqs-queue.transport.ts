import { createHash, randomUUID } from 'crypto';
import { Message, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type Redis from 'ioredis';
import { Consumer } from 'sqs-consumer';
import { config } from '../config/config';
import { describeError, getLogger } from '../logger/logger';
import { DEDUPLICATION_WINDOW_MS, QUEUE_DEFINITIONS, QueueDefinition, QueueName } from './queue.definitions';
import { ConsumeOptions, OutgoingQueueMessage, QueueHandler, QueueTransport } from './queue-transport';

/** SQS's per-message delay ceiling. Delays beyond it are clamped; nothing in ai-chat needs more. */
const MAX_SQS_DELAY_SECONDS = 900;

/**
 * Amazon SQS driver. Ordered queues are FIFO queues (`<prefix><name>.fifo`),
 * everything else is a standard queue (`<prefix><name>`) — see the README for
 * the provisioning commands.
 *
 * Two gaps in plain SQS are closed here so both drivers behave the same:
 *   - Deduplication is claimed in Redis, so standard queues dedupe too.
 *   - sqs-consumer runs a receive batch concurrently, which would let two
 *     messages of one FIFO group race. Batches are regrouped by
 *     MessageGroupId and each group's messages run strictly in order; a
 *     failure stops its group so later messages are redelivered behind it.
 *
 * Credentials come from the default AWS chain (env vars, instance profile,
 * IRSA), never from ai-chat configuration.
 */
export class SqsQueueTransport implements QueueTransport {
  private readonly log = getLogger(SqsQueueTransport.name);
  private readonly sqs = new SQSClient({ region: config.AWS_REGION });
  private readonly consumers: Consumer[] = [];

  constructor(private readonly redis: Redis) {}

  async send(queueName: QueueName, message: OutgoingQueueMessage): Promise<boolean> {
    const definition = QUEUE_DEFINITIONS[queueName];
    if (message.deduplicationId && !(await this.claimDeduplication(queueName, message.deduplicationId))) {
      return false;
    }

    const body = JSON.stringify(message.body);
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl(definition),
          MessageBody: body,
          ...(definition.ordered
            ? {
                MessageGroupId: message.groupId ?? 'default',
                MessageDeduplicationId: message.deduplicationId
                  ? createHash('sha256').update(message.deduplicationId).digest('hex')
                  : randomUUID(),
              }
            : {
                DelaySeconds: Math.min(MAX_SQS_DELAY_SECONDS, Math.ceil(Math.max(0, message.delayMs ?? 0) / 1000)),
              }),
        }),
      );
      return true;
    } catch (error) {
      if (message.deduplicationId) {
        await this.redis.del(this.dedupKey(queueName, message.deduplicationId)).catch(() => undefined);
      }
      throw error;
    }
  }

  consume<T>(queueName: QueueName, handler: QueueHandler<T>, options: ConsumeOptions): void {
    const definition = QUEUE_DEFINITIONS[queueName];
    const consumer = Consumer.create({
      queueUrl: this.queueUrl(definition),
      sqs: this.sqs,
      batchSize: Math.min(10, Math.max(1, options.concurrency)),
      visibilityTimeout: Math.ceil(definition.visibilityTimeoutMs / 1000),
      heartbeatInterval: Math.max(1, Math.floor(definition.visibilityTimeoutMs / 3000)),
      waitTimeSeconds: 20,
      messageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      handleMessageBatch: (messages) => this.handleBatch(definition, messages, handler as QueueHandler),
    });
    consumer.on('error', (error) => this.log.error({ queue: queueName, error: describeError(error) }, 'sqs receive error'));
    consumer.on('processing_error', (error) =>
      this.log.error({ queue: queueName, error: describeError(error) }, 'sqs processing error'),
    );
    consumer.start();
    this.consumers.push(consumer);
    this.log.info({ queue: queueName, url: this.queueUrl(definition) }, 'sqs consumer started');
  }

  async drain(): Promise<void> {
    for (const consumer of this.consumers) {
      consumer.stop({ abort: false });
    }
    await Promise.all(
      this.consumers.map(
        (consumer) =>
          new Promise<void>((resolve) => {
            if (!consumer.status.isPolling) {
              resolve();
              return;
            }
            consumer.once('stopped', () => resolve());
          }),
      ),
    );
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /** Returns the messages to delete: every success, plus poison messages past maxAttempts. */
  private async handleBatch(definition: QueueDefinition, messages: Message[], handler: QueueHandler): Promise<Message[]> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const key = definition.ordered ? (message.Attributes?.MessageGroupId ?? 'default') : (message.MessageId ?? randomUUID());
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }

    const done: Message[] = [];
    await Promise.all(
      [...groups.values()].map(async (groupMessages) => {
        for (const message of groupMessages) {
          const succeeded = await this.handleOne(definition, message, handler);
          if (!succeeded) {
            // Later messages of this group stay invisible and redeliver behind it.
            return;
          }
          done.push(message);
        }
      }),
    );
    return done;
  }

  private async handleOne(definition: QueueDefinition, message: Message, handler: QueueHandler): Promise<boolean> {
    const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const context = {
      queue: definition.name,
      attempt,
      maxAttempts: definition.maxAttempts,
      messageId: message.MessageId ?? 'unknown',
    };
    try {
      await handler(JSON.parse(message.Body ?? 'null'), context);
      return true;
    } catch (error) {
      if (attempt >= definition.maxAttempts) {
        this.log.error({ ...context, error: describeError(error) }, 'queue handler failed on its last attempt — message dropped');
        return true;
      }
      this.log.warn({ ...context, error: describeError(error) }, 'queue handler failed — will retry');
      return false;
    }
  }

  private async claimDeduplication(queueName: QueueName, deduplicationId: string): Promise<boolean> {
    const result = await this.redis.set(this.dedupKey(queueName, deduplicationId), '1', 'PX', DEDUPLICATION_WINDOW_MS, 'NX');
    return result === 'OK';
  }

  private queueUrl(definition: QueueDefinition): string {
    return `${config.SQS_QUEUE_URL_PREFIX}${definition.name}${definition.ordered ? '.fifo' : ''}`;
  }

  private dedupKey(queueName: QueueName, id: string): string {
    return `${config.QUEUE_PREFIX}:q:dedup:${queueName}:${id}`;
  }
}

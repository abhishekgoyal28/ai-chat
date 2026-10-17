import { QueueName } from './queue.definitions';

export interface OutgoingQueueMessage {
  body: unknown;
  /** Ordered queues: messages with the same groupId are processed sequentially. */
  groupId?: string;
  /** A second send with the same id inside the dedup window is dropped. */
  deduplicationId?: string;
  /** Deliver no earlier than this many milliseconds from now. */
  delayMs?: number;
}

export interface QueueMessageContext {
  queue: QueueName;
  /** 1 on first delivery. */
  attempt: number;
  maxAttempts: number;
  messageId: string;
}

export type QueueHandler<T = unknown> = (body: T, context: QueueMessageContext) => Promise<void>;

export interface ConsumeOptions {
  concurrency: number;
}

/**
 * The one queue abstraction. Delivery is at-least-once on every driver, so
 * handlers must be idempotent; a handler that throws is retried with backoff
 * until the queue's maxAttempts, then the message is logged and dropped.
 */
export interface QueueTransport {
  /** Resolves to false when the message was dropped as a duplicate. */
  send(queue: QueueName, message: OutgoingQueueMessage): Promise<boolean>;
  consume<T>(queue: QueueName, handler: QueueHandler<T>, options: ConsumeOptions): void;
  /** Stops taking new messages and waits for in-flight handlers to finish. */
  drain(): Promise<void>;
  /** Liveness of the underlying broker connection, for /readyz. */
  ping(): Promise<boolean>;
}

export const QUEUE_TRANSPORT = Symbol('QUEUE_TRANSPORT');

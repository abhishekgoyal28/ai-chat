/**
 * Every queue in the system and the delivery semantics it needs. Both queue
 * drivers read these definitions, so a queue behaves the same on Redis and SQS.
 */
export enum QueueName {
  /** chat-socket → chat-app: validated turns and connection events. */
  INBOUND = 'inbound',
  /** chat-app → chat-expert: one generation per message. */
  GENERATION_REQUESTS = 'generation-requests',
  /** chat-expert → chat-app: generated replies. */
  GENERATION_RESPONSES = 'generation-responses',
  /** chat-app → chat-app: reveal one reply part when its delay elapses. */
  REVEALS = 'reveals',
  /** chat-app → chat-app: deliver one webhook to the host, with retries. */
  WEBHOOKS = 'webhooks',
  /** chat-app → chat-expert: dashboard playground generations. */
  PREVIEWS = 'previews',
}

export interface QueueDefinition {
  name: QueueName;
  /**
   * Messages sharing a groupId are processed one at a time, in send order.
   * Different groups run in parallel. Maps to an SQS FIFO queue.
   */
  ordered: boolean;
  /** Attempts before a message is given up on (logged, then dropped). */
  maxAttempts: number;
  /** How long a handler may run before the message is redelivered. */
  visibilityTimeoutMs: number;
}

export const QUEUE_DEFINITIONS: Readonly<Record<QueueName, QueueDefinition>> = {
  [QueueName.INBOUND]: { name: QueueName.INBOUND, ordered: true, maxAttempts: 5, visibilityTimeoutMs: 30_000 },
  [QueueName.GENERATION_REQUESTS]: {
    name: QueueName.GENERATION_REQUESTS,
    ordered: false,
    // Every attempt is a billed model call; the worker retries once in-process.
    maxAttempts: 2,
    visibilityTimeoutMs: 120_000,
  },
  [QueueName.GENERATION_RESPONSES]: {
    name: QueueName.GENERATION_RESPONSES,
    ordered: true,
    maxAttempts: 5,
    visibilityTimeoutMs: 30_000,
  },
  [QueueName.REVEALS]: { name: QueueName.REVEALS, ordered: false, maxAttempts: 5, visibilityTimeoutMs: 30_000 },
  [QueueName.WEBHOOKS]: { name: QueueName.WEBHOOKS, ordered: false, maxAttempts: 8, visibilityTimeoutMs: 30_000 },
  [QueueName.PREVIEWS]: { name: QueueName.PREVIEWS, ordered: false, maxAttempts: 1, visibilityTimeoutMs: 120_000 },
};

/** A duplicate send inside this window is dropped. Matches SQS FIFO's fixed window. */
export const DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000;

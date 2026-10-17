import { MessageSendPayload } from './socket-protocol';

/**
 * What chat-socket enqueues on the inbound queue for chat-app. chat-socket has
 * no database, so it reports transport facts and forwards validated turns;
 * chat-app owns every reaction to them.
 *
 * Delivery is at-least-once and handlers must be idempotent: reconnect storms
 * after a deploy make duplicate connection.init events routine.
 */
export enum TransportEventType {
  /** A client subscribed to its conversation. */
  CONNECTION_INIT = 'connection.init',
  /** A validated turn from message.send. */
  MESSAGE_SEND = 'message.send',
}

export interface TransportEventEnvelope {
  type: TransportEventType;
  conversationId: string;
  externalUserId: string;
  socketId: string;
  occurredAt: string;
  payload?: MessageSendPayload;
}

/**
 * Inbound dedup id. clientTurnId absorbs resends after an ack timeout;
 * retryAttempt makes a deliberate retry after turn.failed a distinct message,
 * which a fixed dedup window would otherwise silently drop.
 */
export const buildInboundDeduplicationId = (
  conversationId: string,
  clientTurnId: string,
  retryAttempt?: number,
): string => `${conversationId}:${clientTurnId}:r${retryAttempt ?? 0}`;

import { CLIENT_ID_PATTERN, MessageSendPayload, SocketErrorCode } from './socket-protocol';

export interface TurnLimits {
  maxMessagesPerTurn: number;
  maxBodyChars: number;
}

export interface TurnRejection {
  code: SocketErrorCode;
  message: string;
}

const NUMERIC_ID = /^\d{1,20}$/;

/**
 * Shape and size checks for one turn. chat-socket runs them before queueing
 * (with the caps carried in the session token) and chat-app runs them again
 * on consume (with the agent's live settings) — the socket is a transport,
 * chat-app is the trust boundary.
 */
export const validateTurnPayload = (payload: MessageSendPayload | undefined, limits: TurnLimits): TurnRejection | null => {
  if (!payload || typeof payload !== 'object') {
    return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'payload is required' };
  }
  if (typeof payload.clientTurnId !== 'string' || !CLIENT_ID_PATTERN.test(payload.clientTurnId)) {
    return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'clientTurnId must be 1-64 characters of [A-Za-z0-9_-]' };
  }
  if (payload.retryAttempt !== undefined && (!Number.isInteger(payload.retryAttempt) || payload.retryAttempt < 0 || payload.retryAttempt > 100)) {
    return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'retryAttempt must be an integer between 0 and 100' };
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'messages must contain at least one item' };
  }
  if (payload.messages.length > limits.maxMessagesPerTurn) {
    return { code: SocketErrorCode.TOO_MANY_MESSAGES, message: `a turn may contain at most ${limits.maxMessagesPerTurn} messages` };
  }

  const seen = new Set<string>();
  for (const message of payload.messages) {
    if (!message || typeof message.clientMessageId !== 'string' || !CLIENT_ID_PATTERN.test(message.clientMessageId)) {
      return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'every message needs a clientMessageId of 1-64 characters of [A-Za-z0-9_-]' };
    }
    if (seen.has(message.clientMessageId)) {
      return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'clientMessageId must be unique within a turn' };
    }
    seen.add(message.clientMessageId);
    if (typeof message.body !== 'string' || message.body.trim().length === 0) {
      return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'message body must be a non-empty string' };
    }
    if (message.body.length > limits.maxBodyChars) {
      return { code: SocketErrorCode.MESSAGE_TOO_LONG, message: `a message may be at most ${limits.maxBodyChars} characters` };
    }
    if (typeof message.sentAt !== 'string' || Number.isNaN(Date.parse(message.sentAt))) {
      return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'every message needs an ISO-8601 sentAt' };
    }
    if (message.replyToId !== undefined && !NUMERIC_ID.test(String(message.replyToId))) {
      return { code: SocketErrorCode.INVALID_PAYLOAD, message: 'replyToId must be a message id' };
    }
  }
  return null;
};

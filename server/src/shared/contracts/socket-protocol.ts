/**
 * The WebSocket protocol between clients and chat-socket, and the Redis
 * envelope chat-app publishes for chat-socket to forward.
 *
 * Single source of truth: the JavaScript SDK (sdk/js) mirrors these names, and
 * docs/client-protocol.md documents them. Change them here first.
 */

/** Frames a client emits. Every one is acknowledged through the socket.io ack callback. */
export enum ClientEvent {
  /** Join the conversation named in the session token. Must precede message.send. */
  SUBSCRIBE = 'subscribe',
  UNSUBSCRIBE = 'unsubscribe',
  /** One turn: a batch of 1..N messages typed in one go. Acked after it is durably queued. */
  SEND_MESSAGE = 'message.send',
}

/** Frames the server emits. */
export enum ServerEvent {
  /** One revealed agent (or system) bubble. Same shape as a history row. */
  MESSAGE_PART = 'message.part',
  /** A row changed (pin, star, reaction) — replace it by id. */
  MESSAGE_UPDATED = 'message.updated',
  /** The user's turn was stored; maps clientMessageId → server id. */
  TURN_PERSISTED = 'turn.persisted',
  /** Generation for this turn failed; its messages are FAILED and may be retried. */
  TURN_FAILED = 'turn.failed',
  /** The agent is working on a reply. Clear on the next part, turn.failed or after maxDurationMs. */
  AGENT_TYPING = 'agent.typing',
  /** The conversation became read-only. Farewell bubbles may still be arriving. */
  SESSION_ENDED = 'session.ended',
  /** The transcript is final: every part, including the farewell, has been published. */
  SESSION_COMPLETED = 'session.completed',
  ERROR = 'error',
  /** This server is shutting down; reconnect with jittered backoff. */
  SERVER_SHUTDOWN = 'server.shutdown',
}

/** Only these may be published on a conversation channel; chat-socket drops anything else. */
export const FORWARDABLE_EVENTS: ReadonlySet<string> = new Set<string>([
  ServerEvent.MESSAGE_PART,
  ServerEvent.MESSAGE_UPDATED,
  ServerEvent.TURN_PERSISTED,
  ServerEvent.TURN_FAILED,
  ServerEvent.AGENT_TYPING,
  ServerEvent.SESSION_ENDED,
  ServerEvent.SESSION_COMPLETED,
  ServerEvent.ERROR,
]);

export enum SocketErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',
  SUBSCRIBE_FAILED = 'SUBSCRIBE_FAILED',
  NOT_SUBSCRIBED = 'NOT_SUBSCRIBED',
  MESSAGE_TOO_LONG = 'MESSAGE_TOO_LONG',
  TOO_MANY_MESSAGES = 'TOO_MANY_MESSAGES',
  RATE_LIMITED = 'RATE_LIMITED',
  /** The turn could not be queued. Retryable: resend the identical payload. */
  ENQUEUE_FAILED = 'ENQUEUE_FAILED',
  /** Asynchronous only (arrives as an error frame keyed by turnId). */
  SESSION_ENDED = 'SESSION_ENDED',
  /** Asynchronous only: a replyToId does not name a message in this conversation. */
  INVALID_REPLY_TARGET = 'INVALID_REPLY_TARGET',
}

export interface Ack<T = Record<string, never>> {
  ok: boolean;
  error?: SocketErrorCode;
  message?: string;
  data?: T;
}

export interface SubscribeAckData {
  conversationId: string;
}

export interface MessageSendItem {
  /** Client-generated id (ULID/UUID), at most 64 characters. Stable across resends. */
  clientMessageId: string;
  body: string;
  /** Tap time, ISO-8601. Display only; skew beyond tolerance is replaced with server time. */
  sentAt: string;
  /** Server id of the message this one replies to. */
  replyToId?: string;
}

export interface MessageSendPayload {
  /** Client-generated id for the turn, at most 64 characters. Reused verbatim on resends. */
  clientTurnId: string;
  /** Increment only when retrying after turn.failed — never on an ack timeout. */
  retryAttempt?: number;
  messages: MessageSendItem[];
}

export interface MessageSendAckData {
  turnId: string;
  accepted: number;
}

export interface TurnPersistedPayload {
  conversationId: string;
  turnId: string;
  messages: Array<{ clientMessageId: string; id: string }>;
}

export interface TurnFailedPayload {
  conversationId: string;
  turnId: string;
  /** TIMEOUT · PROVIDER_ERROR · SAFETY_BLOCKED · MALFORMED · NOT_CONFIGURED · PAST_DEADLINE */
  reason: string;
  retryable: boolean;
}

export interface AgentTypingPayload {
  conversationId: string;
  turnId: string;
  maxDurationMs: number;
}

export interface SessionEndedPayload {
  conversationId: string;
  endReason: string;
  endedAt: string;
}

export interface SessionCompletedPayload {
  conversationId: string;
  endReason: string;
  completedAt: string;
}

export interface ErrorFramePayload {
  code: SocketErrorCode | string;
  message: string;
  turnId?: string;
}

export interface ServerShutdownPayload {
  graceMs: number;
}

/** What chat-app publishes on Redis; chat-socket emits `event` with `payload` to the room. */
export interface ChannelEnvelope {
  event: ServerEvent;
  payload: Record<string, unknown>;
}

/**
 * One pub/sub channel and one socket.io room per conversation. The id comes
 * from the verified session token, never from client input, so a client can
 * only ever join the conversation its token names.
 */
export const buildConversationChannel = (prefix: string, conversationId: string): string =>
  `${prefix}:conv:${conversationId}`;

/** Ids the client mints. Bounded so they always fit their columns, with room for server prefixes. */
export const CLIENT_ID_MAX_LENGTH = 64;
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

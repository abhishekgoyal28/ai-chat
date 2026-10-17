/**
 * Wire types. These mirror server/src/shared/contracts/socket-protocol.ts and
 * the message serializer — see docs/client-protocol.md for the full protocol.
 */

export type SenderType = 'USER' | 'AGENT' | 'SYSTEM';
export type MessageKind = 'TEXT' | 'GREETING' | 'FAREWELL' | 'SESSION_END';

export interface WireMessage {
  id: string;
  conversationId: string;
  turnId: string;
  requestTurnId?: string;
  clientMessageId?: string;
  senderType: SenderType;
  kind: MessageKind;
  /** USER: RECEIVED · ANSWERED · FAILED. AGENT/SYSTEM: SENT. */
  status: string;
  partIndex: number;
  partsTotal: number;
  body: string | null;
  sentAt: string | null;
  replyTo?: { id: string; senderType: SenderType; body: string | null };
  reaction?: string;
  pinnedAt?: string;
  starredAt?: string;
}

export interface SuggestedChip {
  id: number;
  text: string;
}

export interface SuggestedChipsItem {
  kind: 'SUGGESTED_CHIPS';
  chips: SuggestedChip[];
}

export type StreamItem = WireMessage | SuggestedChipsItem;

export interface ClientBehaviour {
  debounceMs: number;
  typingHoldMs: number;
  maxTurnWaitMs: number;
  maxMessagesPerTurn: number;
  maxBodyChars: number;
}

export interface PageBlock {
  hasMore: boolean;
  nextBefore: string | null;
  limit: number;
}

export interface SessionView {
  conversationId: string;
  agent: { id: string; slug: string };
  externalUserId: string;
  scope: string;
  status: 'ACTIVE' | 'ENDED';
  acceptingMessages: boolean;
  endReason: string | null;
  startedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  serverTime: string;
  agentProfile: { name: string; avatarUrl: string | null; tagline: string | null };
  config: ClientBehaviour;
  messages: StreamItem[];
  page: PageBlock;
}

export interface HistoryPage {
  conversationId: string;
  serverTime: string;
  messages: WireMessage[];
  page: PageBlock;
}

/** A message in the client's transcript: server rows plus the user's not-yet-stored ones. */
export interface ChatMessage extends Omit<WireMessage, 'id' | 'status'> {
  /** Server id once stored; `local:<clientMessageId>` before that. */
  id: string;
  /**
   * Local delivery state of the user's own messages, then the server status:
   * QUEUED (waiting for the batch) · SENDING · ACCEPTED (first tick) ·
   * RECEIVED / ANSWERED (stored) · FAILED.
   */
  status: string;
  local: boolean;
}

export interface TurnFailedEvent {
  conversationId: string;
  turnId: string;
  reason: string;
  retryable: boolean;
}

export interface SessionEndedEvent {
  conversationId: string;
  endReason: string;
  endedAt: string;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface ChatClientEvents {
  /** The transcript changed: a message arrived, was stored, updated or failed. */
  messages: ChatMessage[];
  /** Suggestions to show under the transcript; empty clears them. */
  suggestions: SuggestedChip[];
  typing: boolean;
  turnFailed: TurnFailedEvent;
  sessionEnded: SessionEndedEvent;
  /** The transcript is final; close the chat UI's live parts. */
  sessionCompleted: { conversationId: string; endReason: string };
  connection: ConnectionState;
  error: { code: string; message: string; turnId?: string };
}

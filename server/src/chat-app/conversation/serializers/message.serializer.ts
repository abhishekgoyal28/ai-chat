import { Message } from '../../../shared/database/entities';
import { MessageKind, MessageSenderType } from '../../../shared/domain/enums';

/**
 * THE wire shape of a message. Session responses, history pages, socket
 * frames and message.updated all go through toWireMessage(), so a client
 * writes one parser for every path. Add or remove a field here and nowhere else.
 */
export interface WireMessage {
  /** BIGINT as a string — it is also the paging cursor and must not lose precision. */
  id: string;
  conversationId: string;
  turnId: string;
  requestTurnId?: string;
  clientMessageId?: string;
  senderType: MessageSenderType;
  kind: MessageKind;
  status: string;
  partIndex: number;
  partsTotal: number;
  body: string | null;
  /** User rows: tap time. Agent rows: reveal time. Display only — order by id. */
  sentAt: string | null;
  replyTo?: { id: string; senderType: MessageSenderType; body: string | null };
  reaction?: string;
  pinnedAt?: string;
  starredAt?: string;
}

export interface SuggestedChip {
  id: number;
  text: string;
}

/** Tap-to-send suggestions ride in the stream as a non-row item. They have no id on purpose. */
export interface SuggestedChipsItem {
  kind: MessageKind.SUGGESTED_CHIPS;
  chips: SuggestedChip[];
}

export type StreamItem = WireMessage | SuggestedChipsItem;

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** `quoted` maps id → row for the page's reply targets, resolved in one query by the caller. */
export const toWireMessage = (message: Message, quoted: Map<string, Message>): WireMessage => {
  const isUser = message.senderType === MessageSenderType.USER;
  const replyTarget = message.replyToId ? quoted.get(message.replyToId) : undefined;
  return {
    id: message.id,
    conversationId: message.conversationId,
    turnId: message.turnId,
    ...(message.requestTurnId && { requestTurnId: message.requestTurnId }),
    ...(isUser && message.clientMessageId && { clientMessageId: message.clientMessageId }),
    senderType: message.senderType,
    kind: message.kind,
    status: message.status,
    partIndex: message.partIndex ?? 0,
    partsTotal: message.partsTotal ?? 1,
    body: message.body,
    sentAt: iso(isUser ? message.clientSentAt : message.publishedAt),
    ...(replyTarget && { replyTo: { id: replyTarget.id, senderType: replyTarget.senderType, body: replyTarget.body } }),
    ...(message.reaction && { reaction: message.reaction }),
    ...(message.pinnedAt && { pinnedAt: message.pinnedAt.toISOString() }),
    ...(message.starredAt && { starredAt: message.starredAt.toISOString() }),
  };
};

export const toWireMessages = (messages: Message[], quoted: Map<string, Message>): WireMessage[] =>
  messages.map((message) => toWireMessage(message, quoted));

/** Chips go last: they invite a reply to what came before. */
export const withSuggestedChips = (messages: WireMessage[], chips: SuggestedChip[]): StreamItem[] =>
  chips.length > 0 ? [...messages, { kind: MessageKind.SUGGESTED_CHIPS, chips }] : messages;

/** Text → chips, dropping blanks, duplicates and anything over the length limit. Model output is no more trusted than operator JSON. */
export const sanitizeChips = (raw: unknown, limit: number, maxChars: number): SuggestedChip[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    const text = entry.trim();
    if (!text || text.length > maxChars || seen.has(text)) {
      continue;
    }
    seen.add(text);
    chips.push(text);
  }
  return chips.slice(0, limit).map((text, index) => ({ id: index + 1, text }));
};

export interface PageBlock {
  hasMore: boolean;
  /** Pass back as `before` to load older messages. Null when there are none. */
  nextBefore: string | null;
  limit: number;
}

/** `messages` ascending by id. */
export const buildPageBlock = (messages: readonly { id: string }[], hasMore: boolean, limit: number): PageBlock => ({
  hasMore,
  nextBefore: hasMore && messages.length > 0 ? messages[0].id : null,
  limit,
});

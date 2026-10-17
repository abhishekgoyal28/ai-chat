import { Injectable } from '@nestjs/common';
import { ServerEvent } from '../../../shared/contracts/socket-protocol';
import { Message } from '../../../shared/database/entities';
import { NotFoundError } from '../../../shared/errors/app-errors';
import { getLogger } from '../../../shared/logger/logger';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { buildPageBlock, PageBlock, toWireMessage, toWireMessages, WireMessage } from '../serializers/message.serializer';
import { ConversationPublisher } from './conversation-publisher.service';

export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 200;
/** Pinning past this evicts the oldest pin — the user's tap always succeeds. */
export const PIN_LIMIT = 5;

export enum HistoryFilter {
  STARRED = 'starred',
  PINNED = 'pinned',
}

export interface HistoryQuery {
  before?: string;
  after?: string;
  limit?: number;
  filter?: HistoryFilter;
}

export interface HistoryPage {
  conversationId: string;
  serverTime: string;
  messages: WireMessage[];
  page: PageBlock;
}

/**
 * Transcript reads and per-message actions. Read-only with respect to the
 * session: reading never starts, resumes or extends anything, so an ENDED
 * conversation reads exactly like an ACTIVE one.
 */
@Injectable()
export class HistoryService {
  private readonly log = getLogger(HistoryService.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly publisher: ConversationPublisher,
  ) {}

  async getPage(conversationId: string, query: HistoryQuery): Promise<HistoryPage> {
    const limit = Math.min(Math.max(1, Math.floor(Number(query.limit) || HISTORY_PAGE_DEFAULT)), HISTORY_PAGE_MAX);
    if (query.filter === HistoryFilter.PINNED) {
      const pinned = await this.messages.findPinned(conversationId);
      return this.respond(conversationId, pinned, { hasMore: false, nextBefore: null, limit: PIN_LIMIT });
    }
    const { messages, hasMore } = await this.messages.findPage(conversationId, {
      beforeId: query.before,
      afterId: query.after,
      limit,
      starredOnly: query.filter === HistoryFilter.STARRED,
    });
    return this.respond(conversationId, messages, buildPageBlock(messages, query.after ? false : hasMore, limit), query.after ? hasMore : undefined);
  }

  async pin(conversationId: string, messageId: string): Promise<WireMessage[]> {
    const message = await this.requireMessage(conversationId, messageId);
    if (message.pinnedAt) {
      return this.publishUpdates(conversationId, [message]);
    }
    const pinned = await this.messages.findPinnedOldestFirst(conversationId);
    const changed: Message[] = [];
    // A loop, so lowering the limit converges instead of leaving a conversation over it.
    for (const victim of pinned.slice(0, Math.max(0, pinned.length - PIN_LIMIT + 1))) {
      await this.messages.setPinnedAt(victim.id, null);
      victim.pinnedAt = null;
      changed.push(victim);
    }
    message.pinnedAt = new Date();
    await this.messages.setPinnedAt(message.id, message.pinnedAt);
    return this.publishUpdates(conversationId, [...changed, message]);
  }

  async unpin(conversationId: string, messageId: string): Promise<WireMessage[]> {
    const message = await this.requireMessage(conversationId, messageId);
    if (message.pinnedAt) {
      message.pinnedAt = null;
      await this.messages.setPinnedAt(message.id, null);
    }
    return this.publishUpdates(conversationId, [message]);
  }

  async star(conversationId: string, messageId: string, starred: boolean): Promise<WireMessage[]> {
    const message = await this.requireMessage(conversationId, messageId);
    if (Boolean(message.starredAt) !== starred) {
      message.starredAt = starred ? new Date() : null;
      await this.messages.setStarredAt(message.id, message.starredAt);
    }
    return this.publishUpdates(conversationId, [message]);
  }

  /** One reaction per message; null clears it. */
  async react(conversationId: string, messageId: string, reaction: string | null): Promise<WireMessage[]> {
    const message = await this.requireMessage(conversationId, messageId);
    message.reaction = reaction;
    await this.messages.setReaction(message.id, reaction);
    return this.publishUpdates(conversationId, [message]);
  }

  private async respond(conversationId: string, messages: Message[], page: PageBlock, hasNewer?: boolean): Promise<HistoryPage> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) {
      throw new NotFoundError('conversation');
    }
    const quoted = await this.quotedFor(conversationId, messages);
    return {
      conversationId,
      serverTime: new Date().toISOString(),
      messages: toWireMessages(messages, quoted),
      page: hasNewer === undefined ? page : { ...page, hasMore: hasNewer },
    };
  }

  private async requireMessage(conversationId: string, messageId: string): Promise<Message> {
    // Scoped to the conversation in the query: "not yours" and "does not exist" look the same.
    const message = await this.messages.findOneInConversation(conversationId, messageId);
    if (!message) {
      throw new NotFoundError('message');
    }
    return message;
  }

  /** Other devices of the same user see the change; the HTTP response is the authoritative copy. */
  private async publishUpdates(conversationId: string, messages: Message[]): Promise<WireMessage[]> {
    const quoted = await this.quotedFor(conversationId, messages);
    const wire = messages.map((message) => toWireMessage(message, quoted));
    for (const message of wire) {
      await this.publisher.publishQuietly(conversationId, ServerEvent.MESSAGE_UPDATED, message as unknown as Record<string, unknown>);
    }
    return wire;
  }

  private quotedFor(conversationId: string, messages: Message[]): Promise<Map<string, Message>> {
    return this.messages.findVisibleByIds(
      conversationId,
      messages.map((message) => message.replyToId).filter((id): id is string => Boolean(id)),
    );
  }
}

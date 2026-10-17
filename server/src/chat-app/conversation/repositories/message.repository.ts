import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, LessThanOrEqual, Repository, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { affectedRows, isDuplicateKeyError } from '../../../shared/database/db-errors';
import { Message } from '../../../shared/database/entities';
import { MessageKind, MessageSenderType, MessageStatus } from '../../../shared/domain/enums';

export interface UserMessageInput {
  clientMessageId: string;
  body: string;
  clientSentAt: Date;
  /** Already verified by the caller to name a visible message in this conversation. */
  replyToId: string | null;
}

export interface AgentPartInput {
  partIndex: number;
  kind: MessageKind;
  body: string;
  revealAt: Date;
  meta: Record<string, unknown> | null;
}

export interface MessagePageQuery {
  /** Rows older than this id (scrolling back). */
  beforeId?: string;
  /** Rows newer than this id (resync after reconnect). */
  afterId?: string;
  limit: number;
  starredOnly?: boolean;
}

/** All reads and writes of `messages`. */
@Injectable()
export class MessageRepository {
  constructor(@InjectRepository(Message) private readonly repo: Repository<Message>) {}

  /**
   * The one visibility rule for every client-facing read: user rows always
   * show (a FAILED one renders its retry affordance); server-authored rows
   * show only once revealed. A second, overlapping filter is how a read
   * starts leaking bubbles ahead of their reveal, so there is only this one.
   */
  private visible(conversationId: string): SelectQueryBuilder<Message> {
    return this.repo
      .createQueryBuilder('message')
      .where('message.conversation_id = :conversationId', { conversationId })
      .andWhere('(message.sender_type = :user OR message.status = :sent)', {
        user: MessageSenderType.USER,
        sent: MessageStatus.SENT,
      });
  }

  /**
   * One page, newest first internally, returned oldest first. Keyset on id —
   * never OFFSET, which skips or repeats rows while new ones arrive.
   * `limit + 1` doubles as the hasMore probe.
   */
  async findPage(conversationId: string, query: MessagePageQuery): Promise<{ messages: Message[]; hasMore: boolean }> {
    const builder = this.visible(conversationId);
    if (query.starredOnly) {
      builder.andWhere('message.starred_at IS NOT NULL');
    }
    if (query.afterId) {
      // Resync reads forwards from a cursor.
      const rows = await builder
        .andWhere('message.id > :afterId', { afterId: query.afterId })
        .orderBy('message.id', 'ASC')
        .limit(query.limit + 1)
        .getMany();
      return { messages: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
    }
    if (query.beforeId) {
      builder.andWhere('message.id < :beforeId', { beforeId: query.beforeId });
    }
    const rows = await builder.orderBy('message.id', 'DESC').limit(query.limit + 1).getMany();
    const hasMore = rows.length > query.limit;
    return { messages: (hasMore ? rows.slice(0, query.limit) : rows).reverse(), hasMore };
  }

  /** Every row, revealed or not — operators see the whole transcript. */
  findAllForConversation(conversationId: string, limit: number): Promise<Message[]> {
    return this.repo.find({ where: { conversationId }, order: { id: 'ASC' }, take: limit });
  }

  findPinned(conversationId: string): Promise<Message[]> {
    return this.visible(conversationId).andWhere('message.pinned_at IS NOT NULL').orderBy('message.pinned_at', 'DESC').getMany();
  }

  /** Pinned rows oldest pin first: [0] is the eviction candidate at the pin limit. */
  findPinnedOldestFirst(conversationId: string): Promise<Message[]> {
    return this.repo
      .createQueryBuilder('message')
      .where('message.conversation_id = :conversationId', { conversationId })
      .andWhere('message.pinned_at IS NOT NULL')
      .orderBy('message.pinned_at', 'ASC')
      .getMany();
  }

  /** Visible messages among `ids` in this conversation — the IDOR guard for client-supplied ids. */
  async findVisibleByIds(conversationId: string, ids: readonly string[]): Promise<Map<string, Message>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await this.visible(conversationId).andWhere('message.id IN (:...ids)', { ids: unique }).getMany();
    return new Map(rows.map((row) => [row.id, row]));
  }

  findOneInConversation(conversationId: string, messageId: string): Promise<Message | null> {
    return this.visible(conversationId).andWhere('message.id = :messageId', { messageId }).getOne();
  }

  findById(id: string): Promise<Message | null> {
    return this.repo.findOne({ where: { id } });
  }

  // --- user turns -----------------------------------------------------------

  /**
   * One turn as a single INSERT, in typing order. A resent turn hits
   * uq(conversation_id, client_message_id) and gets the stored rows back.
   */
  async insertUserMessages(conversationId: string, turnId: string, inputs: UserMessageInput[]): Promise<{ rows: Message[]; inserted: boolean }> {
    const rows = inputs.map((input) =>
      this.repo.create({
        conversationId,
        turnId,
        senderType: MessageSenderType.USER,
        kind: MessageKind.TEXT,
        status: MessageStatus.RECEIVED,
        body: input.body,
        clientMessageId: input.clientMessageId,
        clientSentAt: input.clientSentAt,
        replyToId: input.replyToId,
      }),
    );
    try {
      await this.repo.insert(rows as QueryDeepPartialEntity<Message>[]);
      return { rows, inserted: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const existing = await this.repo.find({
        where: { conversationId, clientMessageId: In(inputs.map((input) => input.clientMessageId)) },
        order: { id: 'ASC' },
      });
      return { rows: existing, inserted: false };
    }
  }

  /** A deliberate retry after turn.failed puts the turn back in line. */
  async resetFailedUserMessages(conversationId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await this.repo.update(
      { conversationId, id: In(ids), senderType: MessageSenderType.USER, status: MessageStatus.FAILED },
      { status: MessageStatus.RECEIVED },
    );
    return affectedRows(result);
  }

  /** User messages no delivered reply covers yet, oldest first. */
  findOutstandingUserMessages(conversationId: string): Promise<Message[]> {
    return this.repo.find({
      where: { conversationId, senderType: MessageSenderType.USER, status: MessageStatus.RECEIVED },
      order: { id: 'ASC' },
      take: 100,
    });
  }

  async hasOutstandingUserMessages(conversationId: string): Promise<boolean> {
    return this.repo.exists({ where: { conversationId, senderType: MessageSenderType.USER, status: MessageStatus.RECEIVED } });
  }

  /** Exactly the rows the reply answered — never "everything up to an id", which would swallow a concurrent retry. */
  async markUserMessagesAnswered(conversationId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await this.repo.update(
      { conversationId, id: In(ids), senderType: MessageSenderType.USER, status: MessageStatus.RECEIVED },
      { status: MessageStatus.ANSWERED },
    );
    return affectedRows(result);
  }

  async markUserMessagesFailed(conversationId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const result = await this.repo.update(
      { conversationId, id: In(ids), senderType: MessageSenderType.USER, status: MessageStatus.RECEIVED },
      { status: MessageStatus.FAILED },
    );
    return affectedRows(result);
  }

  /**
   * The model's view of the conversation: the last `turnLimit` turns, oldest
   * first, without the messages being answered (they go in the request itself). Counted in turns, not rows —
   * a turn is several user bubbles plus several reply parts, and a row window
   * would hand the model a question without its answer. Agent parts still
   * pacing out (PENDING) are included: they are the model's own last words.
   */
  async findHistory(conversationId: string, turnLimit: number, excludeIds: string[]): Promise<Message[]> {
    if (turnLimit <= 0) {
      return [];
    }
    const eligible = (builder: SelectQueryBuilder<Message>) => {
      builder
        .where('message.conversation_id = :conversationId', { conversationId })
        .andWhere(
          `((message.sender_type = :user AND message.status = :answered) OR
            (message.sender_type = :agent AND message.status IN (:...agentStatuses)))`,
          {
            user: MessageSenderType.USER,
            answered: MessageStatus.ANSWERED,
            agent: MessageSenderType.AGENT,
            agentStatuses: [MessageStatus.PENDING, MessageStatus.SENT],
          },
        );
      if (excludeIds.length > 0) {
        builder.andWhere('message.id NOT IN (:...excludeIds)', { excludeIds });
      }
      return builder;
    };

    const turns = await eligible(this.repo.createQueryBuilder('message'))
      .select('message.turn_id', 'turnId')
      .addSelect('MAX(message.id)', 'lastId')
      .groupBy('message.turn_id')
      .orderBy('lastId', 'DESC')
      .limit(turnLimit)
      .getRawMany<{ turnId: string }>();
    if (turns.length === 0) {
      return [];
    }
    return eligible(this.repo.createQueryBuilder('message'))
      .andWhere('message.turn_id IN (:...turnIds)', { turnIds: turns.map((turn) => turn.turnId) })
      .select(['message.id', 'message.senderType', 'message.body', 'message.turnId'])
      .orderBy('message.id', 'ASC')
      .getMany();
  }

  countMessages(conversationId: string): Promise<number> {
    return this.repo.count({ where: { conversationId } });
  }

  // --- agent parts ----------------------------------------------------------

  /** All parts of one reply as one INSERT. A redelivered response gets the stored rows back. */
  async insertAgentParts(
    conversationId: string,
    turnId: string,
    requestTurnId: string | null,
    senderType: MessageSenderType.AGENT | MessageSenderType.SYSTEM,
    parts: AgentPartInput[],
  ): Promise<{ rows: Message[]; inserted: boolean }> {
    const rows = parts.map((part) =>
      this.repo.create({
        conversationId,
        turnId,
        requestTurnId,
        senderType,
        kind: part.kind,
        status: MessageStatus.PENDING,
        body: part.body,
        partIndex: part.partIndex,
        partsTotal: parts.length,
        revealAt: part.revealAt,
        meta: part.meta,
      }),
    );
    try {
      await this.repo.insert(rows as QueryDeepPartialEntity<Message>[]);
      return { rows, inserted: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      return { rows: await this.findTurn(conversationId, turnId), inserted: false };
    }
  }

  findTurn(conversationId: string, turnId: string): Promise<Message[]> {
    return this.repo.find({ where: { conversationId, turnId }, order: { id: 'ASC' } });
  }

  /** PENDING → SENT, stamping publishedAt. False: already sent — publish nothing. */
  async markPartSent(id: string, publishedAt: Date): Promise<boolean> {
    const result = await this.repo.update({ id, status: MessageStatus.PENDING }, { status: MessageStatus.SENT, publishedAt });
    return affectedRows(result) > 0;
  }

  async markPartFailed(id: string): Promise<boolean> {
    const result = await this.repo.update({ id, status: MessageStatus.PENDING }, { status: MessageStatus.FAILED });
    return affectedRows(result) > 0;
  }

  /** Publish order is insertion order: a part waits while an earlier part is still pending. */
  countPendingBefore(conversationId: string, id: string): Promise<number> {
    return this.repo.count({ where: { conversationId, status: MessageStatus.PENDING, id: LessThan(id) } });
  }

  countPending(conversationId: string): Promise<number> {
    return this.repo.count({ where: { conversationId, status: MessageStatus.PENDING } });
  }

  /** Session end: everything still pacing out is revealed immediately. */
  async flushPending(conversationId: string, at: Date): Promise<string[]> {
    const pending = await this.repo.find({ select: ['id'], where: { conversationId, status: MessageStatus.PENDING } });
    if (pending.length > 0) {
      await this.repo.update({ conversationId, status: MessageStatus.PENDING }, { revealAt: at });
    }
    return pending.map((row) => row.id);
  }

  /** Parts whose reveal is long overdue — their reveal job was lost. Rides ix(status, reveal_at). */
  findOverduePending(before: Date, limit: number): Promise<Array<Pick<Message, 'id' | 'conversationId' | 'revealAt'>>> {
    return this.repo.find({
      select: ['id', 'conversationId', 'revealAt'],
      where: { status: MessageStatus.PENDING, revealAt: LessThanOrEqual(before) },
      order: { revealAt: 'ASC' },
      take: limit,
    });
  }

  // --- message actions ------------------------------------------------------

  async setPinnedAt(id: string, pinnedAt: Date | null): Promise<void> {
    await this.repo.update({ id }, { pinnedAt });
  }

  async setStarredAt(id: string, starredAt: Date | null): Promise<void> {
    await this.repo.update({ id }, { starredAt });
  }

  async setReaction(id: string, reaction: string | null): Promise<void> {
    await this.repo.update({ id }, { reaction });
  }

  async deleteByConversationIds(conversationIds: string[]): Promise<void> {
    if (conversationIds.length > 0) {
      await this.repo.delete({ conversationId: In(conversationIds) });
    }
  }

  /** Dashboard overview: replies and their generation stats since a time. */
  async replyStatsSince(since: Date): Promise<{ replies: number; avgLatencyMs: number | null; inputTokens: number; outputTokens: number }> {
    const row = await this.repo
      .createQueryBuilder('message')
      .select('COUNT(*)', 'replies')
      .addSelect("AVG(JSON_EXTRACT(message.meta, '$.latencyMs'))", 'avgLatencyMs')
      .addSelect("COALESCE(SUM(JSON_EXTRACT(message.meta, '$.inputTokens')), 0)", 'inputTokens')
      .addSelect("COALESCE(SUM(JSON_EXTRACT(message.meta, '$.outputTokens')), 0)", 'outputTokens')
      .where('message.sender_type = :agent', { agent: MessageSenderType.AGENT })
      .andWhere('message.part_index = 0')
      .andWhere("JSON_EXTRACT(message.meta, '$.latencyMs') IS NOT NULL")
      .andWhere('message.created_at >= :since', { since })
      .getRawOne<{ replies: string; avgLatencyMs: string | null; inputTokens: string; outputTokens: string }>();
    return {
      replies: Number(row?.replies ?? 0),
      avgLatencyMs: row?.avgLatencyMs === null || row?.avgLatencyMs === undefined ? null : Math.round(Number(row.avgLatencyMs)),
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
    };
  }
}

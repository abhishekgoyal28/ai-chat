import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { affectedRows, isDuplicateKeyError } from '../../../shared/database/db-errors';
import { Conversation } from '../../../shared/database/entities';
import { ConversationEndReason, ConversationStatus } from '../../../shared/domain/enums';

export interface CreateConversationParams {
  agentId: string;
  externalUserId: string;
  scope: string;
  startedAt: Date;
  expiresAt: Date | null;
  userName: string | null;
  userAttributes: Record<string, string> | null;
  context: Record<string, unknown> | null;
  llmProviderId: string | null;
  llmModel: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ConversationListFilter {
  agentId?: string;
  externalUserId?: string;
  status?: ConversationStatus;
  /** Keyset cursor: rows with a smaller id. */
  beforeId?: string;
  limit: number;
}

/** All reads and writes of `conversations`. State transitions are compare-and-set UPDATEs. */
@Injectable()
export class ConversationRepository {
  constructor(@InjectRepository(Conversation) private readonly repo: Repository<Conversation>) {}

  findById(id: string): Promise<Conversation | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByGate(agentId: string, externalUserId: string, scope: string): Promise<Conversation | null> {
    return this.repo.findOne({ where: { agentId, externalUserId, scope } });
  }

  /**
   * The create-or-resume gate: the unique key arbitrates, so two concurrent
   * session starts for the same user, agent and scope can never both create.
   */
  async insertOrFind(params: CreateConversationParams): Promise<{ conversation: Conversation; created: boolean }> {
    try {
      const conversation = await this.repo.save(
        this.repo.create({ ...params, status: ConversationStatus.ACTIVE }),
      );
      return { conversation, created: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const existing = await this.findByGate(params.agentId, params.externalUserId, params.scope);
      if (!existing) {
        throw error;
      }
      return { conversation: existing, created: false };
    }
  }

  async updateParticipantContext(
    id: string,
    values: { userName?: string | null; userAttributes?: Record<string, string> | null; context?: Record<string, unknown> | null },
  ): Promise<void> {
    const patch = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    if (Object.keys(patch).length > 0) {
      await this.repo.update({ id }, patch);
    }
  }

  // --- generation claim -----------------------------------------------------

  /** At most one generation per conversation. False means one is already running. */
  async claimGeneration(id: string, dispatchId: string): Promise<boolean> {
    const result = await this.repo.update(
      { id, inflightDispatchId: IsNull(), status: ConversationStatus.ACTIVE },
      { inflightDispatchId: dispatchId, inflightSince: new Date() },
    );
    return affectedRows(result) > 0;
  }

  async releaseGeneration(id: string, dispatchId: string): Promise<boolean> {
    const result = await this.repo.update({ id, inflightDispatchId: dispatchId }, { inflightDispatchId: null, inflightSince: null });
    return affectedRows(result) > 0;
  }

  /** Generations claimed before `before` that never released — the worker lost them. */
  findStaleGenerations(before: Date, limit: number): Promise<Conversation[]> {
    return this.repo.find({
      where: { inflightSince: LessThanOrEqual(before), inflightDispatchId: Not(IsNull()) },
      order: { inflightSince: 'ASC' },
      take: limit,
    });
  }

  // --- end of session -------------------------------------------------------

  /**
   * The end claim. Exactly one trigger wins (timer, user, host or operator);
   * the reason is stored with the claim so a deferred end finishes with it.
   */
  async claimEnd(id: string, reason: ConversationEndReason): Promise<boolean> {
    const result = await this.repo.update(
      { id, status: ConversationStatus.ACTIVE, endInitiatedAt: IsNull() },
      { endInitiatedAt: new Date(), pendingEndReason: reason },
    );
    return affectedRows(result) > 0;
  }

  async finalizeEnd(id: string, reason: ConversationEndReason): Promise<boolean> {
    const result = await this.repo.update(
      { id, status: ConversationStatus.ACTIVE },
      { status: ConversationStatus.ENDED, endReason: reason, endedAt: new Date(), inflightDispatchId: null, inflightSince: null },
    );
    return affectedRows(result) > 0;
  }

  async claimCompleted(id: string, completedAt: Date): Promise<boolean> {
    const result = await this.repo.update(
      { id, status: ConversationStatus.ENDED, completedAt: IsNull() },
      { completedAt },
    );
    return affectedRows(result) > 0;
  }

  /** ACTIVE conversations whose timer ran out and whose end has not started. Rides ix(status, expires_at). */
  findExpired(asOf: Date, limit: number): Promise<Conversation[]> {
    return this.repo.find({
      where: { status: ConversationStatus.ACTIVE, expiresAt: LessThanOrEqual(asOf), endInitiatedAt: IsNull() },
      order: { expiresAt: 'ASC' },
      take: limit,
    });
  }

  /** Ends started before `before` that never finalised. Rides ix(status, end_initiated_at). */
  findStalledEnds(before: Date, limit: number): Promise<Conversation[]> {
    return this.repo.find({
      where: { status: ConversationStatus.ACTIVE, endInitiatedAt: LessThanOrEqual(before) },
      order: { endInitiatedAt: 'ASC' },
      take: limit,
    });
  }

  async setSuggestedChips(id: string, chips: string[]): Promise<void> {
    await this.repo.update({ id }, { suggestedChips: chips });
  }

  // --- listings -------------------------------------------------------------

  async list(filter: ConversationListFilter): Promise<{ rows: Conversation[]; hasMore: boolean }> {
    const query = this.repo.createQueryBuilder('conversation').orderBy('conversation.id', 'DESC').limit(filter.limit + 1);
    if (filter.agentId) {
      query.andWhere('conversation.agent_id = :agentId', { agentId: filter.agentId });
    }
    if (filter.externalUserId) {
      query.andWhere('conversation.external_user_id = :externalUserId', { externalUserId: filter.externalUserId });
    }
    if (filter.status) {
      query.andWhere('conversation.status = :status', { status: filter.status });
    }
    if (filter.beforeId) {
      query.andWhere('conversation.id < :beforeId', { beforeId: filter.beforeId });
    }
    const rows = await query.getMany();
    return { rows: rows.slice(0, filter.limit), hasMore: rows.length > filter.limit };
  }

  findIdsByUser(externalUserId: string): Promise<Array<Pick<Conversation, 'id'>>> {
    return this.repo.find({ select: ['id'], where: { externalUserId } });
  }

  async findIdsEndedBefore(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.repo.find({
      select: ['id'],
      where: { status: ConversationStatus.ENDED, endedAt: LessThanOrEqual(cutoff) },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length > 0) {
      await this.repo.delete({ id: In(ids) });
    }
  }

  /** Dashboard overview. One query per number keeps each on an index. */
  async countCreatedSince(since: Date): Promise<number> {
    return this.repo.createQueryBuilder('c').where('c.created_at >= :since', { since }).getCount();
  }

  async countActive(): Promise<number> {
    return this.repo
      .createQueryBuilder('c')
      .where('c.status = :status', { status: ConversationStatus.ACTIVE })
      .andWhere(new Brackets((query) => query.where('c.expires_at IS NULL').orWhere('c.expires_at > :now', { now: new Date() })))
      .getCount();
  }

  async countByAgentSince(since: Date): Promise<Array<{ agentId: string; conversations: number }>> {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select('c.agent_id', 'agentId')
      .addSelect('COUNT(*)', 'conversations')
      .where('c.created_at >= :since', { since })
      .groupBy('c.agent_id')
      .getRawMany<{ agentId: string; conversations: string }>();
    return rows.map((row) => ({ agentId: String(row.agentId), conversations: Number(row.conversations) }));
  }
}

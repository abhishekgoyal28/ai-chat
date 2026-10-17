import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isDuplicateKeyError } from '../../shared/database/db-errors';
import { ActionInvocation, UserDevice } from '../../shared/database/entities';
import { ActionInvocationStatus, DevicePlatform } from '../../shared/domain/enums';
import { sha256Hex } from '../../shared/security/crypto';

@Injectable()
export class UserDeviceRepository {
  constructor(@InjectRepository(UserDevice) private readonly repo: Repository<UserDevice>) {}

  /** A token belongs to one user at a time; re-registering moves it. */
  async upsert(externalUserId: string, platform: DevicePlatform, token: string): Promise<void> {
    const tokenHash = sha256Hex(token);
    await this.repo.upsert({ externalUserId, platform, token, tokenHash }, ['tokenHash']);
  }

  async deleteToken(externalUserId: string, token: string): Promise<void> {
    await this.repo.delete({ externalUserId, tokenHash: sha256Hex(token) });
  }

  async deleteTokens(tokens: string[]): Promise<void> {
    if (tokens.length > 0) {
      await this.repo.delete({ tokenHash: In(tokens.map(sha256Hex)) });
    }
  }

  findTokens(externalUserId: string): Promise<Array<Pick<UserDevice, 'token' | 'platform'>>> {
    return this.repo.find({ select: ['token', 'platform'], where: { externalUserId }, take: 20 });
  }

  async deleteByUser(externalUserId: string): Promise<void> {
    await this.repo.delete({ externalUserId });
  }
}

@Injectable()
export class ActionInvocationRepository {
  constructor(@InjectRepository(ActionInvocation) private readonly repo: Repository<ActionInvocation>) {}

  /** Null when this turn already invoked this action (a redelivered reply). */
  async insert(params: Pick<ActionInvocation, 'conversationId' | 'agentId' | 'actionName' | 'turnId' | 'arguments'>): Promise<ActionInvocation | null> {
    try {
      return await this.repo.save(this.repo.create({ ...params, status: ActionInvocationStatus.PENDING, error: null }));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return null;
      }
      throw error;
    }
  }

  async markResult(id: string, status: ActionInvocationStatus, error: string | null): Promise<void> {
    await this.repo.update({ id }, { status, error: error?.slice(0, 500) ?? null });
  }

  /** Invocations per action for one conversation — the per-conversation quota check. */
  async countByAction(conversationId: string): Promise<Map<string, number>> {
    const rows = await this.repo
      .createQueryBuilder('invocation')
      .select('invocation.action_name', 'actionName')
      .addSelect('COUNT(*)', 'total')
      .where('invocation.conversation_id = :conversationId', { conversationId })
      .groupBy('invocation.action_name')
      .getRawMany<{ actionName: string; total: string }>();
    return new Map(rows.map((row) => [row.actionName, Number(row.total)]));
  }

  findForConversation(conversationId: string): Promise<ActionInvocation[]> {
    return this.repo.find({ where: { conversationId }, order: { id: 'ASC' } });
  }

  async deleteByConversationIds(conversationIds: string[]): Promise<void> {
    if (conversationIds.length > 0) {
      await this.repo.delete({ conversationId: In(conversationIds) });
    }
  }
}

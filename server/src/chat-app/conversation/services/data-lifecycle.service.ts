import { Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { config } from '../../../shared/config/config';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { REDIS_CLIENT } from '../../../shared/redis/redis.providers';
import { ActionInvocationRepository, UserDeviceRepository } from '../../integrations/integration.repositories';
import { PlatformSettingsService } from '../../platform/platform-settings.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_BATCH = 500;

/**
 * Data the platform must be able to forget: one user's data on request
 * (DELETE /v1/users/:id), and ended conversations past the retention window.
 */
@Injectable()
export class DataLifecycleService {
  private readonly log = getLogger(DataLifecycleService.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly invocations: ActionInvocationRepository,
    private readonly devices: UserDeviceRepository,
    private readonly settings: PlatformSettingsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Erases every conversation, message, action record and device token of one user. */
  async eraseUser(externalUserId: string): Promise<{ conversations: number }> {
    const ids = (await this.conversations.findIdsByUser(externalUserId)).map((row) => row.id);
    await this.deleteConversations(ids);
    await this.devices.deleteByUser(externalUserId);
    this.log.info({ conversations: ids.length }, 'user data erased');
    return { conversations: ids.length };
  }

  @Interval(RETENTION_INTERVAL_MS)
  async applyRetention(): Promise<void> {
    try {
      const { endedConversationDays } = await this.settings.getRetention();
      if (!endedConversationDays) {
        return;
      }
      const lock = await this.redis.set(`${config.QUEUE_PREFIX}:lock:retention`, '1', 'PX', RETENTION_INTERVAL_MS - 60_000, 'NX');
      if (lock !== 'OK') {
        return;
      }
      const cutoff = new Date(Date.now() - endedConversationDays * 24 * 60 * 60 * 1000);
      const ids = await this.conversations.findIdsEndedBefore(cutoff, RETENTION_BATCH);
      await this.deleteConversations(ids);
      if (ids.length > 0) {
        this.log.info({ deleted: ids.length, endedConversationDays }, 'retention applied');
      }
    } catch (error) {
      this.log.error({ error: describeError(error) }, 'retention run failed');
    }
  }

  private async deleteConversations(ids: string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100);
      await this.messages.deleteByConversationIds(chunk);
      await this.invocations.deleteByConversationIds(chunk);
      await this.conversations.deleteByIds(chunk);
    }
  }
}

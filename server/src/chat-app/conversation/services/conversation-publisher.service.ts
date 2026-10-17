import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { config } from '../../../shared/config/config';
import { buildConversationChannel, ChannelEnvelope, FORWARDABLE_EVENTS, ServerEvent } from '../../../shared/contracts/socket-protocol';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { REDIS_CLIENT } from '../../../shared/redis/redis.providers';

/**
 * chat-app's only path to a connected client: PUBLISH on the conversation's
 * Redis channel, which chat-socket forwards to the room.
 *
 * At-most-once by design — nothing is queued for a client that is not
 * listening, and clients resync from the database on reconnect. Never treat a
 * publish as proof the user saw anything, and never fail a database write
 * because a publish failed.
 */
@Injectable()
export class ConversationPublisher {
  private readonly log = getLogger(ConversationPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Returns how many chat-socket processes received the frame (PUBLISH's own
   * reply). Zero means nobody is connected to this conversation right now —
   * computed atomically with the publish, so it cannot go stale the way a
   * separate presence lookup would. Throws on a Redis failure.
   */
  async publish(conversationId: string, event: ServerEvent, payload: Record<string, unknown>): Promise<number> {
    if (!FORWARDABLE_EVENTS.has(event)) {
      throw new Error(`event is not forwardable to clients: ${event}`);
    }
    const envelope: ChannelEnvelope = { event, payload };
    return this.redis.publish(buildConversationChannel(config.QUEUE_PREFIX, conversationId), JSON.stringify(envelope));
  }

  /** For advisory frames: a failure is logged and swallowed. Returns -1 on failure. */
  async publishQuietly(conversationId: string, event: ServerEvent, payload: Record<string, unknown>): Promise<number> {
    try {
      return await this.publish(conversationId, event, payload);
    } catch (error) {
      this.log.error({ conversationId, event, error: describeError(error) }, 'frame publish failed — client will resync');
      return -1;
    }
  }
}

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { Server } from 'socket.io';
import { ChannelEnvelope, FORWARDABLE_EVENTS } from '../../shared/contracts/socket-protocol';
import { describeError, getLogger } from '../../shared/logger/logger';
import { createRedisConnection } from '../../shared/redis/redis.providers';

/**
 * Bridges Redis pub/sub to socket.io rooms.
 *
 * One dedicated subscriber connection per process holds one SUBSCRIBE per
 * conversation with live sockets here (refcounted). A frame published by any
 * chat-app pod reaches whichever chat-socket pod holds the user's socket, so
 * no sticky sessions and no socket.io adapter are needed.
 *
 * Pub/sub is at-most-once: a frame published during a reconnect is lost.
 * That is by design — MySQL is the source of truth and clients resync with
 * GET /v1/client/messages?after=<last id> on every reconnect.
 */
@Injectable()
export class ChannelSubscriptionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = getLogger(ChannelSubscriptionService.name);
  private readonly refCounts = new Map<string, number>();
  private subscriber: Redis;
  private server: Server | null = null;

  onModuleInit(): void {
    this.subscriber = createRedisConnection('socket-subscriber');
    this.subscriber.on('message', (channel: string, raw: string) => this.forward(channel, raw));
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber.removeAllListeners('message');
    await this.subscriber.quit().catch(() => undefined);
  }

  bindServer(server: Server): void {
    this.server = server;
  }

  async subscribe(channel: string): Promise<void> {
    const current = this.refCounts.get(channel) ?? 0;
    this.refCounts.set(channel, current + 1);
    if (current === 0) {
      try {
        await this.subscriber.subscribe(channel);
      } catch (error) {
        this.release(channel).catch(() => undefined);
        throw error;
      }
    }
  }

  async release(channel: string): Promise<void> {
    const current = this.refCounts.get(channel) ?? 0;
    if (current > 1) {
      this.refCounts.set(channel, current - 1);
      return;
    }
    this.refCounts.delete(channel);
    if (current === 1) {
      await this.subscriber.unsubscribe(channel).catch((error) =>
        // A lost UNSUBSCRIBE leaks one idle subscription; never fail cleanup over it.
        this.log.warn({ channel, error: describeError(error) }, 'unsubscribe failed'),
      );
    }
  }

  subscribedChannelCount(): number {
    return this.refCounts.size;
  }

  /** Only whitelisted events are forwarded: a channel envelope can never emit arbitrary frames. */
  private forward(channel: string, raw: string): void {
    if (!this.server) {
      return;
    }
    let envelope: ChannelEnvelope;
    try {
      envelope = JSON.parse(raw) as ChannelEnvelope;
    } catch (error) {
      this.log.error({ channel, error: describeError(error) }, 'malformed channel envelope');
      return;
    }
    if (!envelope?.event || !FORWARDABLE_EVENTS.has(envelope.event)) {
      this.log.warn({ channel, event: envelope?.event }, 'dropped non-forwardable channel envelope');
      return;
    }
    this.server.to(channel).emit(envelope.event, envelope.payload);
  }
}

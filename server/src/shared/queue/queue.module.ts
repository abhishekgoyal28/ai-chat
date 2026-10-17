import { Global, Inject, Injectable, Module, BeforeApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { config, QueueDriver } from '../config/config';
import { getLogger } from '../logger/logger';
import { REDIS_CLIENT } from '../redis/redis.providers';
import { QUEUE_TRANSPORT, QueueTransport } from './queue-transport';
import { RedisQueueTransport } from './redis-queue.transport';
import { SqsQueueTransport } from './sqs-queue.transport';

@Injectable()
class QueueLifecycle implements BeforeApplicationShutdown {
  private readonly log = getLogger('queue');

  constructor(@Inject(QUEUE_TRANSPORT) private readonly transport: QueueTransport) {}

  /** In-flight handlers finish before the process exits; their messages are acknowledged, not redelivered. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.log.info({ signal }, 'draining queue consumers');
    await this.transport.drain();
    this.log.info('queue consumers drained');
  }
}

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_TRANSPORT,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis): QueueTransport =>
        config.QUEUE_DRIVER === QueueDriver.SQS ? new SqsQueueTransport(redis) : new RedisQueueTransport(redis),
    },
    QueueLifecycle,
  ],
  exports: [QUEUE_TRANSPORT],
})
export class QueueModule {}

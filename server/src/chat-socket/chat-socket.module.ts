import { Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { healthModule } from '../shared/observability/health';
import { QueueModule } from '../shared/queue/queue.module';
import { QUEUE_TRANSPORT, QueueTransport } from '../shared/queue/queue-transport';
import { REDIS_CLIENT, RedisModule } from '../shared/redis/redis.providers';
import { ChatSocketGateway } from './chat-socket.gateway';
import { ChannelSubscriptionService } from './services/channel-subscription.service';
import { ConnectionRegistryService } from './services/connection-registry.service';
import { SocketShutdownService } from './services/socket-shutdown.service';

/**
 * chat-socket: Redis and the queue, nothing else. No TypeORM, no consumers,
 * no business services — what this process must never do is simply absent
 * from its module graph.
 */
@Module({
  imports: [
    RedisModule,
    QueueModule,
    healthModule({
      inject: [REDIS_CLIENT, QUEUE_TRANSPORT],
      useFactory: (redis: Redis, queue: QueueTransport) => [
        { name: 'redis', check: async () => (await redis.ping()) === 'PONG' },
        { name: 'queue', check: () => queue.ping() },
      ],
    }),
  ],
  providers: [ChannelSubscriptionService, ConnectionRegistryService, ChatSocketGateway, SocketShutdownService],
})
export class ChatSocketModule {}

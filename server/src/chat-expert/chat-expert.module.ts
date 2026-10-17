import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../shared/database/data-source';
import { EXPERT_ENTITIES } from '../shared/database/entities';
import { healthModule } from '../shared/observability/health';
import { QueueModule } from '../shared/queue/queue.module';
import { QUEUE_TRANSPORT, QueueTransport } from '../shared/queue/queue-transport';
import { REDIS_CLIENT, RedisModule } from '../shared/redis/redis.providers';
import { ExpertConfigRepository } from './config/expert-config.repository';
import { ExpertConfigService } from './config/expert-config.service';
import { GenerationConsumer } from './generation/generation.consumer';
import { GenerationService } from './generation/generation.service';
import { LlmClientFactory } from './llm/llm-client.factory';

/**
 * chat-expert: the only process that talks to models. It consumes generation
 * and preview requests, reads configuration (read-only, cached) and never
 * touches conversation tables — persistence is chat-app's job. The entity
 * list is explicit so this service cannot accidentally load the whole schema.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(buildDataSourceOptions(EXPERT_ENTITIES, 5)),
    TypeOrmModule.forFeature(EXPERT_ENTITIES),
    RedisModule,
    QueueModule,
    healthModule({
      inject: [DataSource, REDIS_CLIENT, QUEUE_TRANSPORT],
      useFactory: (dataSource: DataSource, redis: Redis, queue: QueueTransport) => [
        { name: 'database', check: async () => Boolean(await dataSource.query('SELECT 1')) },
        { name: 'redis', check: async () => (await redis.ping()) === 'PONG' },
        { name: 'queue', check: () => queue.ping() },
      ],
    }),
  ],
  providers: [ExpertConfigRepository, ExpertConfigService, LlmClientFactory, GenerationService, GenerationConsumer],
})
export class ChatExpertModule {}

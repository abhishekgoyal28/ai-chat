import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { config } from '../config/config';
import { describeError, getLogger } from '../logger/logger';

/** Command client: GET/SET/PUBLISH/locks. Shared by everything in the process. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const log = getLogger('redis');

/**
 * A new connection to REDIS_URL. Pub/sub subscribers and BullMQ workers each
 * need their own connection (a subscribed or blocking connection cannot issue
 * ordinary commands), so they call this rather than sharing REDIS_CLIENT.
 */
export const createRedisConnection = (name: string, overrides: RedisOptions = {}): Redis => {
  const client = new Redis(config.REDIS_URL, {
    connectionName: `ai-chat:${name}`,
    lazyConnect: false,
    ...overrides,
  });
  client.on('error', (error) => log.error({ connection: name, error: describeError(error) }, 'redis connection error'));
  client.on('reconnecting', () => log.warn({ connection: name }, 'redis reconnecting'));
  return client;
};

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => createRedisConnection('commands', { maxRetriesPerRequest: 3 }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}

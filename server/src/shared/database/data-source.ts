import { DataSourceOptions } from 'typeorm';
import { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';
import { config } from '../config/config';
import { ALL_ENTITIES } from './entities';
import { InitialSchema1760000000000 } from './migrations/1760000000000-initial-schema';
import { SnakeNamingStrategy } from './snake-naming.strategy';

/** Every migration, oldest first. Append new ones here. */
export const MIGRATIONS = [InitialSchema1760000000000];

/**
 * Connection options shared by every process that touches MySQL. `timezone:
 * 'Z'` keeps every DATETIME in UTC; `bigNumberStrings` keeps BIGINT ids as
 * strings so they never lose precision in JavaScript.
 */
export const buildDataSourceOptions = (
  entities: DataSourceOptions['entities'] = ALL_ENTITIES,
  poolSize = config.DATABASE_POOL_SIZE,
): MysqlConnectionOptions => ({
  type: 'mysql',
  url: config.DATABASE_URL,
  entities,
  migrations: MIGRATIONS,
  migrationsTableName: 'schema_migrations',
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
  timezone: 'Z',
  charset: 'utf8mb4_unicode_ci',
  supportBigNumbers: true,
  bigNumberStrings: true,
  poolSize,
  extra: { connectionLimit: poolSize },
});

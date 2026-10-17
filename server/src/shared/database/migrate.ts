import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { requireConfig } from '../config/config';
import { describeError, logger } from '../logger/logger';
import { buildDataSourceOptions } from './data-source';

const MIGRATION_LOCK = 'ai_chat_migrations';
const MIGRATION_LOCK_TIMEOUT_SEC = 300;

/**
 * Applies pending migrations and exits. Used by the Helm pre-upgrade Job and
 * `npm run migrate`; chat-app also runs migrations on boot when
 * RUN_MIGRATIONS=true (the default), which suits single-instance installs.
 *
 * Concurrent runs are safe: a MySQL named lock lets one runner work while the
 * others wait, then find nothing left to apply.
 */
export const runMigrations = async (): Promise<string[]> => {
  const dataSource = new DataSource(buildDataSourceOptions(undefined, 2));
  await dataSource.initialize();
  const lockRunner = dataSource.createQueryRunner();
  try {
    const [row] = await lockRunner.query('SELECT GET_LOCK(?, ?) AS acquired', [MIGRATION_LOCK, MIGRATION_LOCK_TIMEOUT_SEC]);
    if (Number(row?.acquired) !== 1) {
      throw new Error('timed out waiting for another migration run to finish');
    }
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    return applied.map((migration) => migration.name);
  } finally {
    await lockRunner.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]).catch(() => undefined);
    await lockRunner.release();
    await dataSource.destroy();
  }
};

if (require.main === module) {
  requireConfig('migrate', ['DATABASE_URL']);
  runMigrations()
    .then((applied) => {
      logger.info({ applied }, applied.length ? 'migrations applied' : 'database schema is up to date');
      process.exit(0);
    })
    .catch((error) => {
      logger.fatal({ error: describeError(error) }, 'migration failed');
      process.exit(1);
    });
}

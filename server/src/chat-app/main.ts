import './service-name';
import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { config, requireConfig } from '../shared/config/config';
import { runMigrations } from '../shared/database/migrate';
import { bootstrapService } from '../shared/http/bootstrap';
import { describeError, logger } from '../shared/logger/logger';
import { parseEncryptionKey } from '../shared/security/crypto';
import { ChatAppModule } from './chat-app.module';
import { mountDashboard } from './dashboard-static';

const start = async (): Promise<void> => {
  requireConfig('chat-app', ['DATABASE_URL', 'REDIS_URL', 'AUTH_SECRET', 'ENCRYPTION_KEY']);
  parseEncryptionKey(config.ENCRYPTION_KEY as string);

  if (config.RUN_MIGRATIONS) {
    const applied = await runMigrations();
    logger.info({ applied }, applied.length ? 'migrations applied' : 'database schema is up to date');
  }

  await bootstrapService({
    service: 'chat-app',
    module: ChatAppModule,
    port: config.APP_PORT,
    configure: (app) => {
      app.use(cookieParser());
      if (config.DASHBOARD_ENABLED) {
        mountDashboard(app);
      }
    },
  });
};

start().catch((error) => {
  logger.fatal({ error: describeError(error) }, 'chat-app failed to start');
  process.exit(1);
});

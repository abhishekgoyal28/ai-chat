import './service-name';
import 'reflect-metadata';
import { config, requireConfig } from '../shared/config/config';
import { bootstrapService } from '../shared/http/bootstrap';
import { describeError, logger } from '../shared/logger/logger';
import { ChatExpertModule } from './chat-expert.module';

requireConfig('chat-expert', ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY']);

bootstrapService({ service: 'chat-expert', module: ChatExpertModule, port: config.EXPERT_PORT }).catch((error) => {
  logger.fatal({ error: describeError(error) }, 'chat-expert failed to start');
  process.exit(1);
});

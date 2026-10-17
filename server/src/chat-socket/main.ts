import './service-name';
import 'reflect-metadata';
import { config, requireConfig } from '../shared/config/config';
import { bootstrapService } from '../shared/http/bootstrap';
import { describeError, logger } from '../shared/logger/logger';
import { ChatSocketModule } from './chat-socket.module';

requireConfig('chat-socket', ['REDIS_URL', 'AUTH_SECRET']);

bootstrapService({ service: 'chat-socket', module: ChatSocketModule, port: config.SOCKET_PORT }).catch((error) => {
  logger.fatal({ error: describeError(error) }, 'chat-socket failed to start');
  process.exit(1);
});

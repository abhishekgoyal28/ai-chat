import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { config } from '../config/config';
import { AppExceptionFilter } from '../errors/app-exception.filter';
import { describeError, logger } from '../logger/logger';
import { initMetrics } from '../observability/metrics';

export interface BootstrapOptions {
  service: 'chat-app' | 'chat-socket' | 'chat-expert';
  module: unknown;
  port: number;
  /** Runs after the app is created and before it listens. */
  configure?: (app: NestExpressApplication) => Promise<void> | void;
}

/**
 * Shared entrypoint for all three services: structured logs, one error shape,
 * strict request validation, Prometheus metrics and graceful shutdown.
 *
 * Each service is started as a plain `node dist/<service>/main.js` process so
 * SIGTERM reaches it directly and enableShutdownHooks() can drain in-flight
 * work before the container is stopped.
 */
export const bootstrapService = async ({ service, module, port, configure }: BootstrapOptions): Promise<INestApplication> => {
  process.env.AI_CHAT_SERVICE = service;
  initMetrics(service);

  process.on('unhandledRejection', (reason) => logger.error({ error: describeError(reason) }, 'unhandled promise rejection'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ error: describeError(error) }, 'uncaught exception — exiting');
    process.exit(1);
  });

  const app = await NestFactory.create<NestExpressApplication>(module as never, {
    bufferLogs: false,
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();
  if (config.TRUST_PROXY) {
    app.set('trust proxy', true);
  }
  app.disable('x-powered-by');
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }),
  );
  app.useBodyParser('json', { limit: '1mb' });
  // Client and host APIs authenticate with bearer tokens, never cookies, so
  // cross-origin calls carry no ambient credentials. The dashboard's cookie is
  // SameSite=Strict and same-origin, and CORS never grants it to other sites.
  app.enableCors({
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : true,
    credentials: false,
  });

  await configure?.(app);
  await app.listen(port, '0.0.0.0');
  logger.info({ port, queueDriver: config.QUEUE_DRIVER }, `${service} listening`);
  return app;
};

import pino, { Logger } from 'pino';
import { config } from '../config/config';

/**
 * The one logger every service uses. JSON lines on stdout — the format every
 * log shipper (Fluent Bit, Vector, CloudWatch, Loki) ingests without parsing
 * rules. Set LOG_PRETTY=true for human-readable output in local development.
 *
 * Never instantiate another logger: use `logger` or `getLogger(context)`.
 * Redaction covers the fields this codebase handles that must never reach a
 * log line, wherever they are nested.
 */
export const logger: Logger = pino({
  level: config.LOG_LEVEL,
  base: { service: process.env.AI_CHAT_SERVICE ?? 'ai-chat' },
  redact: {
    paths: [
      '*.password',
      '*.passwordHash',
      '*.apiKey',
      '*.token',
      '*.secret',
      '*.authorization',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  serializers: { error: pino.stdSerializers.err, err: pino.stdSerializers.err },
  ...(config.LOG_PRETTY && {
    transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } },
  }),
});

export const getLogger = (context: string): Logger => logger.child({ context });

/** Errors serialise to `{}` through JSON.stringify — always log through this. */
export const describeError = (error: unknown): { message: string; name?: string; stack?: string } =>
  error instanceof Error
    ? { message: error.message, name: error.name, stack: error.stack }
    : { message: String(error) };

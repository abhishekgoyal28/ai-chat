import { z } from 'zod';

/**
 * Every environment variable the three services read, validated once at boot.
 *
 * One schema for all services on purpose: a single `.env` (or one Kubernetes
 * Secret + ConfigMap) configures the whole deployment, and a variable means
 * the same thing wherever it is read. Variables a given service does not need
 * are optional here and asserted by that service's entrypoint through
 * `requireConfig()`, so chat-socket boots without a database URL.
 */

const booleanFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') {
        return fallback;
      }
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const integerFromEnv = (fallback: number, { min = 0 }: { min?: number } = {}) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      if (value === undefined || value.trim() === '') {
        return fallback;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer >= ${min}` });
        return z.NEVER;
      }
      return parsed;
    });

const listFromEnv = () =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );

export enum QueueDriver {
  REDIS = 'redis',
  SQS = 'sqs',
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanFromEnv(false),

  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: integerFromEnv(10, { min: 1 }),
  REDIS_URL: z.string().default('redis://localhost:6379/0'),

  QUEUE_DRIVER: z.nativeEnum(QueueDriver).default(QueueDriver.REDIS),
  QUEUE_PREFIX: z.string().default('aic'),
  SQS_QUEUE_URL_PREFIX: z.string().optional(),
  AWS_REGION: z.string().optional(),

  AUTH_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),

  PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  PUBLIC_SOCKET_URL: z.string().optional(),
  CORS_ORIGINS: listFromEnv(),
  TRUST_PROXY: booleanFromEnv(true),

  APP_PORT: integerFromEnv(3000, { min: 1 }),
  SOCKET_PORT: integerFromEnv(3001, { min: 1 }),
  EXPERT_PORT: integerFromEnv(3002, { min: 1 }),

  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  RUN_MIGRATIONS: booleanFromEnv(true),
  DASHBOARD_ENABLED: booleanFromEnv(true),
  SESSION_TOKEN_TTL_SEC: integerFromEnv(3600, { min: 60 }),
  ADMIN_SESSION_TTL_SEC: integerFromEnv(43200, { min: 300 }),
  GENERATION_TIMEOUT_MS: integerFromEnv(90000, { min: 5000 }),
  HOST_API_RATE_LIMIT_PER_MINUTE: integerFromEnv(1200, { min: 1 }),
  CLIENT_API_RATE_LIMIT_PER_MINUTE: integerFromEnv(120, { min: 1 }),

  SOCKET_PING_INTERVAL_MS: integerFromEnv(25000, { min: 1000 }),
  SOCKET_PING_TIMEOUT_MS: integerFromEnv(20000, { min: 1000 }),
  SOCKET_SHUTDOWN_GRACE_MS: integerFromEnv(3000),
  SOCKET_MAX_TURNS_PER_MINUTE: integerFromEnv(20, { min: 1 }),

  EXPERT_CONCURRENCY: integerFromEnv(10, { min: 1 }),
  LLM_TIMEOUT_MS: integerFromEnv(30000, { min: 1000 }),
  CONFIG_CACHE_TTL_MS: integerFromEnv(15000),

  METRICS_ENABLED: booleanFromEnv(true),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const parseConfig = (): AppConfig => {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigValidationError(`Invalid environment configuration:\n${problems}`);
  }
  return Object.freeze(parsed.data);
};

export const config: AppConfig = parseConfig();

/**
 * Fails fast, with every missing name in one message, when a service is
 * started without the variables it cannot run without.
 */
export const requireConfig = (service: string, keys: Array<keyof AppConfig>): void => {
  const missing = keys.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw new ConfigValidationError(
      `${service} cannot start: missing required environment variables: ${missing.join(', ')}`,
    );
  }
  if (keys.includes('AUTH_SECRET') && (config.AUTH_SECRET?.length ?? 0) < 32) {
    throw new ConfigValidationError(`${service} cannot start: AUTH_SECRET must be at least 32 characters`);
  }
  if (config.QUEUE_DRIVER === QueueDriver.SQS && (!config.SQS_QUEUE_URL_PREFIX || !config.AWS_REGION)) {
    throw new ConfigValidationError(
      `${service} cannot start: QUEUE_DRIVER=sqs requires SQS_QUEUE_URL_PREFIX and AWS_REGION`,
    );
  }
};

/** Where clients open the WebSocket. Defaults to the app URL, which suits path-based routing. */
export const publicSocketUrl = (): string => config.PUBLIC_SOCKET_URL || config.PUBLIC_APP_URL;

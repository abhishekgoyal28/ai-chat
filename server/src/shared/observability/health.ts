import { Controller, Get, HttpCode, HttpStatus, Inject, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import { config } from '../config/config';
import { metricsRegistry } from './metrics';

/** One dependency check for /readyz. Must resolve quickly and never throw. */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean>;
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

const CHECK_TIMEOUT_MS = 2000;

const withTimeout = (promise: Promise<boolean>): Promise<boolean> =>
  Promise.race([
    promise.catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CHECK_TIMEOUT_MS)),
  ]);

/**
 * /healthz — liveness: the process is up. Never checks dependencies, so a
 *            Redis blip does not restart every pod at once.
 * /readyz  — readiness: every dependency this service needs answers. A
 *            failing pod is taken out of the load balancer, not killed.
 * /metrics — Prometheus.
 */
@Controller()
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  healthz(): { status: string; uptimeSec: number } {
    return { status: 'ok', uptimeSec: Math.floor(process.uptime()) };
  }

  @Get('readyz')
  async readyz(@Res() response: Response): Promise<void> {
    const results = await Promise.all(
      this.checks.map(async ({ name, check }) => ({ name, ok: await withTimeout(check()) })),
    );
    const ready = results.every((result) => result.ok);
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ready ? 'ready' : 'not_ready',
      checks: Object.fromEntries(results.map((result) => [result.name, result.ok ? 'ok' : 'failing'])),
    });
  }

  @Get('metrics')
  async metrics(@Res() response: Response): Promise<void> {
    if (!config.METRICS_ENABLED) {
      response.status(HttpStatus.NOT_FOUND).end();
      return;
    }
    response.setHeader('Content-Type', metricsRegistry.contentType);
    response.send(await metricsRegistry.metrics());
  }
}

/** Each service imports this with the checks it needs. */
export const healthModule = (checksProvider: {
  inject: Array<string | symbol | (abstract new (...args: never[]) => unknown)>;
  useFactory: (...deps: never[]) => ReadinessCheck[];
}) => {
  @Module({
    controllers: [HealthController],
    providers: [{ provide: READINESS_CHECKS, ...checksProvider }],
  })
  class HealthModule {}
  return HealthModule;
};

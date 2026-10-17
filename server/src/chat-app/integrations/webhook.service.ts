import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { describeError, getLogger } from '../../shared/logger/logger';
import { metrics } from '../../shared/observability/metrics';
import { QueueName } from '../../shared/queue/queue.definitions';
import { QUEUE_TRANSPORT, QueueMessageContext, QueueTransport } from '../../shared/queue/queue-transport';
import { hmacSha256Hex } from '../../shared/security/crypto';
import { ActionInvocationStatus } from '../../shared/domain/enums';
import { PlatformSettingsService, WebhookEvent } from '../platform/platform-settings.service';
import { ActionInvocationRepository } from './integration.repositories';

export interface WebhookJob {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  data: Record<string, unknown>;
  /** action.invoked only: the invocation row to mark with the delivery result. */
  invocationId?: string;
}

const DELIVERY_TIMEOUT_MS = 10_000;

/** 4xx other than these means the host rejected the event; retrying will not help. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 409, 425, 429]);

class PermanentDeliveryError extends Error {}

/**
 * Outbound events to the host product's webhook URL, delivered from a queue
 * with exponential-backoff retries, so a slow or failing host never slows a
 * conversation down.
 *
 * Every request is signed: `AIC-Signature: t=<unix seconds>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, "<t>.<raw body>"). Hosts verify it and reject
 * stale timestamps — see docs/host-integration.md.
 */
@Injectable()
export class WebhookService implements OnApplicationBootstrap {
  private readonly log = getLogger(WebhookService.name);

  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly invocations: ActionInvocationRepository,
    @Inject(QUEUE_TRANSPORT) private readonly queue: QueueTransport,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.consume<WebhookJob>(QueueName.WEBHOOKS, (job, context) => this.deliver(job, context), { concurrency: 10 });
  }

  /** True when the event was queued; false when webhooks are off or the event is not subscribed. */
  async emit(event: WebhookEvent, data: Record<string, unknown>, invocationId?: string): Promise<boolean> {
    try {
      const settings = await this.settings.getWebhooks();
      if (!settings.url || !settings.events.includes(event)) {
        return false;
      }
      const job: WebhookJob = { id: randomUUID(), event, createdAt: new Date().toISOString(), data, ...(invocationId && { invocationId }) };
      await this.queue.send(QueueName.WEBHOOKS, { body: job });
      return true;
    } catch (error) {
      // Never let an integration failure break the conversation path.
      this.log.error({ event, error: describeError(error) }, 'webhook enqueue failed');
      return false;
    }
  }

  async isConfigured(): Promise<boolean> {
    return Boolean((await this.settings.getWebhooks()).url);
  }

  /** The dashboard's "send test event": one synchronous, signed delivery with the result shown. */
  async sendTest(): Promise<{ delivered: boolean; status: number | null; error: string | null }> {
    const settings = await this.settings.getWebhooks();
    if (!settings.url) {
      return { delivered: false, status: null, error: 'no webhook URL is configured' };
    }
    const body = JSON.stringify({ id: randomUUID(), type: 'webhook.test', createdAt: new Date().toISOString(), data: {} });
    try {
      const response = await fetch(settings.url, {
        method: 'POST',
        headers: this.headers('webhook.test', body, settings.secret),
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      return { delivered: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
    } catch (error) {
      return { delivered: false, status: null, error: (error as Error).message };
    }
  }

  private headers(event: string, body: string, secret: string | null, deliveryId: string = randomUUID()): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      'content-type': 'application/json',
      'user-agent': 'ai-chat-webhooks/1',
      'aic-event': event,
      'aic-delivery': deliveryId,
      ...(secret && { 'aic-signature': `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}` }),
    };
  }

  private async deliver(job: WebhookJob, context: QueueMessageContext): Promise<void> {
    const settings = await this.settings.getWebhooks();
    if (!settings.url) {
      this.log.warn({ event: job.event, deliveryId: job.id }, 'webhook URL removed — dropping queued event');
      return;
    }
    const body = JSON.stringify({ id: job.id, type: job.event, createdAt: job.createdAt, data: job.data });
    const headers = this.headers(job.event, body, settings.secret, job.id);

    try {
      const response = await fetch(settings.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
      if (response.ok) {
        metrics.webhookDeliveries.inc({ event: job.event, outcome: 'delivered' });
        await this.markInvocation(job, ActionInvocationStatus.SUCCEEDED, null);
        return;
      }
      if (response.status >= 400 && response.status < 500 && !RETRYABLE_CLIENT_STATUSES.has(response.status)) {
        throw new PermanentDeliveryError(`host rejected the webhook with HTTP ${response.status}`);
      }
      throw new Error(`host answered HTTP ${response.status}`);
    } catch (error) {
      const permanent = error instanceof PermanentDeliveryError;
      const lastAttempt = context.attempt >= context.maxAttempts;
      if (permanent || lastAttempt) {
        metrics.webhookDeliveries.inc({ event: job.event, outcome: 'failed' });
        this.log.error({ event: job.event, deliveryId: job.id, attempt: context.attempt, error: describeError(error) }, 'webhook delivery failed permanently');
        await this.markInvocation(job, ActionInvocationStatus.FAILED, (error as Error).message);
        return;
      }
      metrics.webhookDeliveries.inc({ event: job.event, outcome: 'retry' });
      throw error;
    }
  }

  private async markInvocation(job: WebhookJob, status: ActionInvocationStatus, error: string | null): Promise<void> {
    if (job.invocationId) {
      await this.invocations.markResult(job.invocationId, status, error);
    }
  }
}

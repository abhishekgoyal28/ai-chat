import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '../../../shared/config/config';
import {
  GENERATION_SCHEMA_VERSION,
  PreviewAgentConfig,
  PreviewRequest,
  PreviewResponse,
} from '../../../shared/contracts/generation.contract';
import { DependencyError } from '../../../shared/errors/app-errors';
import { QueueName } from '../../../shared/queue/queue.definitions';
import { QUEUE_TRANSPORT, QueueTransport } from '../../../shared/queue/queue-transport';
import { createRedisConnection } from '../../../shared/redis/redis.providers';

const PREVIEW_TIMEOUT_MS = 90_000;

export interface PreviewInput {
  kind: PreviewRequest['kind'];
  agent: PreviewAgentConfig;
  history: PreviewRequest['history'];
  userMessage?: string;
  user: PreviewRequest['user'];
  context?: PreviewRequest['context'];
}

/**
 * Synchronous generations for the dashboard (playground, provider test).
 * Model calls stay inside chat-expert: the request goes on the preview queue
 * and this blocks on a Redis list until the worker pushes the answer, so the
 * dashboard also proves the real worker path end to end.
 */
@Injectable()
export class PreviewService {
  constructor(@Inject(QUEUE_TRANSPORT) private readonly queue: QueueTransport) {}

  async run(input: PreviewInput): Promise<PreviewResponse> {
    const previewId = randomUUID();
    const replyKey = `${config.QUEUE_PREFIX}:preview:${previewId}`;
    const request: PreviewRequest = {
      schemaVersion: GENERATION_SCHEMA_VERSION,
      previewId,
      replyKey,
      kind: input.kind,
      agent: input.agent,
      history: input.history,
      ...(input.userMessage && { userMessage: input.userMessage }),
      user: input.user,
      context: input.context ?? null,
      deadline: new Date(Date.now() + PREVIEW_TIMEOUT_MS - 5000).toISOString(),
    };

    // BLPOP holds its connection, so each wait gets its own short-lived one.
    const waiter = createRedisConnection('preview-wait', { maxRetriesPerRequest: 1 });
    try {
      await this.queue.send(QueueName.PREVIEWS, { body: request });
      const result = await waiter.blpop(replyKey, Math.ceil(PREVIEW_TIMEOUT_MS / 1000));
      if (!result) {
        throw new DependencyError('no answer from chat-expert — is it running and connected to the same Redis?');
      }
      return JSON.parse(result[1]) as PreviewResponse;
    } finally {
      waiter.disconnect();
    }
  }
}

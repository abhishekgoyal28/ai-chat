import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type Redis from 'ioredis';
import { config } from '../../shared/config/config';
import {
  GenerationKind,
  GenerationRequest,
  PreviewRequest,
  SUPPORTED_REQUEST_VERSIONS,
} from '../../shared/contracts/generation.contract';
import { ValidationError } from '../../shared/errors/app-errors';
import { getLogger } from '../../shared/logger/logger';
import { QueueName } from '../../shared/queue/queue.definitions';
import { QUEUE_TRANSPORT, QueueTransport } from '../../shared/queue/queue-transport';
import { REDIS_CLIENT } from '../../shared/redis/redis.providers';
import { GenerationService } from './generation.service';

/** How long a preview answer waits in Redis for chat-app to collect it. */
const PREVIEW_RESULT_TTL_MS = 120_000;

/**
 * chat-expert's two inputs: conversation generations and dashboard previews.
 * Up to EXPERT_CONCURRENCY generations run at once per process.
 */
@Injectable()
export class GenerationConsumer implements OnApplicationBootstrap {
  private readonly log = getLogger(GenerationConsumer.name);

  constructor(
    private readonly generationService: GenerationService,
    @Inject(QUEUE_TRANSPORT) private readonly queue: QueueTransport,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.consume<GenerationRequest>(QueueName.GENERATION_REQUESTS, (body) => this.handleGeneration(body), {
      concurrency: config.EXPERT_CONCURRENCY,
    });
    this.queue.consume<PreviewRequest>(QueueName.PREVIEWS, (body) => this.handlePreview(body), {
      concurrency: Math.max(1, Math.floor(config.EXPERT_CONCURRENCY / 2)),
    });
  }

  async handleGeneration(raw: GenerationRequest): Promise<void> {
    const request = this.validate(raw);
    this.log.info(
      { conversationId: request.conversationId, turnId: request.turnId, kind: request.kind, messages: request.userMessages.length },
      'generation request received',
    );
    const response = await this.generationService.generate(request);
    await this.queue.send(QueueName.GENERATION_RESPONSES, {
      body: response,
      groupId: response.conversationId,
      // A redelivered request (process died mid-call) produces a second
      // response; the dispatch id makes the queue drop it.
      deduplicationId: `response:${response.dispatchId}`,
    });
  }

  async handlePreview(request: PreviewRequest): Promise<void> {
    if (!request?.previewId || !request.replyKey?.startsWith(`${config.QUEUE_PREFIX}:preview:`)) {
      this.log.warn({ previewId: request?.previewId }, 'malformed preview request dropped');
      return;
    }
    const response = await this.generationService.preview(request);
    await this.redis.multi().rpush(request.replyKey, JSON.stringify(response)).pexpire(request.replyKey, PREVIEW_RESULT_TTL_MS).exec();
  }

  /** The payload is ours, but a malformed or version-skewed message must fail loudly here. */
  private validate(request: GenerationRequest): GenerationRequest {
    if (!request || !SUPPORTED_REQUEST_VERSIONS.has(request.schemaVersion)) {
      throw new ValidationError(`unsupported generation request version: ${String(request?.schemaVersion)}`);
    }
    if (!request.dispatchId || !request.conversationId || !request.agentId || !request.turnId || !request.kind) {
      throw new ValidationError('generation request is missing required fields');
    }
    if (request.kind === GenerationKind.REPLY && !request.userMessages?.length) {
      throw new ValidationError('REPLY request carries no user messages');
    }
    return { ...request, history: request.history ?? [], userMessages: request.userMessages ?? [] };
  }
}

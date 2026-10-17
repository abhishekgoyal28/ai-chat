import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { GenerationResponse } from '../../shared/contracts/generation.contract';
import { TransportEventEnvelope } from '../../shared/contracts/transport-events';
import { QueueName } from '../../shared/queue/queue.definitions';
import { QUEUE_TRANSPORT, QueueTransport } from '../../shared/queue/queue-transport';
import { InboundHandler } from './services/inbound-handler.service';
import { ResponseHandler } from './services/response-handler.service';
import { RevealHandler } from './services/reveal-handler.service';
import { RevealJob } from './services/reveal-scheduler.service';

/**
 * chat-app's three conversation queues. Inbound and responses are ordered per
 * conversation; reveals are a plain delay queue whose ordering is enforced by
 * the reveal handler itself.
 */
@Injectable()
export class ConversationConsumers implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_TRANSPORT) private readonly queue: QueueTransport,
    private readonly inbound: InboundHandler,
    private readonly responses: ResponseHandler,
    private readonly reveals: RevealHandler,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.consume<TransportEventEnvelope>(QueueName.INBOUND, (envelope) => this.inbound.handle(envelope), { concurrency: 20 });
    this.queue.consume<GenerationResponse>(QueueName.GENERATION_RESPONSES, (response) => this.responses.handle(response), { concurrency: 20 });
    this.queue.consume<RevealJob>(QueueName.REVEALS, (job) => this.reveals.handle(job), { concurrency: 20 });
  }
}

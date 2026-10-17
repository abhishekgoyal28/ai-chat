import { Inject, Injectable } from '@nestjs/common';
import { AgentSettings } from '../../../shared/domain/agent-settings';
import { QueueName } from '../../../shared/queue/queue.definitions';
import { QUEUE_TRANSPORT, QueueTransport } from '../../../shared/queue/queue-transport';

export interface RevealJob {
  messageId: string;
  conversationId: string;
}

/**
 * Cumulative reveal offsets for a multi-part reply, in ms from now. Part 0
 * shows immediately; each later part waits min(length × msPerChar, maxDelayMs)
 * after the one before — a reading-time proxy, so a long answer arrives like
 * someone typing rather than all at once.
 */
export const computeRevealOffsets = (bodies: string[], pacing: AgentSettings['pacing']): number[] => {
  if (!pacing.enabled) {
    return bodies.map(() => 0);
  }
  let elapsed = 0;
  return bodies.map((body, index) => {
    if (index > 0) {
      elapsed += Math.min(body.length * pacing.msPerChar, pacing.maxDelayMs);
    }
    return elapsed;
  });
};

/**
 * Puts reveal jobs on the delay queue. The queue holds the schedule durably:
 * an in-process timer would silently lose bubbles on every rolling restart.
 */
@Injectable()
export class RevealScheduler {
  constructor(@Inject(QUEUE_TRANSPORT) private readonly queue: QueueTransport) {}

  async schedule(job: RevealJob, delayMs: number): Promise<void> {
    await this.queue.send(QueueName.REVEALS, { body: job, delayMs });
  }

  async scheduleAll(conversationId: string, messageIds: string[], offsetsMs: number[]): Promise<void> {
    await Promise.all(messageIds.map((messageId, index) => this.schedule({ messageId, conversationId }, offsetsMs[index] ?? 0)));
  }
}

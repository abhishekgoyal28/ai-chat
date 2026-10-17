import { Injectable } from '@nestjs/common';
import { buildGreetingTurnId, buildReplyTurnId } from '../../../shared/contracts/generation.contract';
import { ServerEvent } from '../../../shared/contracts/socket-protocol';
import { Conversation, Message } from '../../../shared/database/entities';
import { ConversationEndReason, ConversationStatus, MessageKind, MessageSenderType } from '../../../shared/domain/enums';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { metrics } from '../../../shared/observability/metrics';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { PushService } from '../../integrations/push.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { toWireMessage } from '../serializers/message.serializer';
import { ConversationPublisher } from './conversation-publisher.service';
import { GreetingService } from './greeting.service';
import { RevealJob, RevealScheduler } from './reveal-scheduler.service';
import { SessionEndService } from './session-end.service';

/** A part whose predecessor is still pending re-checks after this long. */
const ORDERING_RETRY_MS = 300;

/**
 * Fires when a part's reveal delay elapses: one guarded PENDING → SENT update
 * and one publish.
 *
 * The update is the idempotency gate — a duplicate job finds the part already
 * SENT and does nothing. Publish order is insertion order: a part whose
 * predecessor is still pending waits, which is what keeps a goodbye behind
 * the answer it follows (the delay queue itself promises no order).
 */
@Injectable()
export class RevealHandler {
  private readonly log = getLogger(RevealHandler.name);

  constructor(
    private readonly messages: MessageRepository,
    private readonly conversations: ConversationRepository,
    private readonly agents: AgentRuntimeService,
    private readonly publisher: ConversationPublisher,
    private readonly reveals: RevealScheduler,
    private readonly push: PushService,
    private readonly greeting: GreetingService,
    private readonly sessionEnd: SessionEndService,
  ) {}

  async handle(job: RevealJob): Promise<void> {
    if (!job?.messageId || !job.conversationId) {
      this.log.warn({ job }, 'malformed reveal job dropped');
      return;
    }
    if ((await this.messages.countPendingBefore(job.conversationId, job.messageId)) > 0) {
      await this.reveals.schedule(job, ORDERING_RETRY_MS);
      return;
    }
    const publishedAt = new Date();
    if (!(await this.messages.markPartSent(job.messageId, publishedAt))) {
      return;
    }

    const [part, conversation] = await Promise.all([this.messages.findById(job.messageId), this.conversations.findById(job.conversationId)]);
    if (!part || !conversation) {
      return;
    }
    await this.publishPart(conversation, part);
    this.observeFirstPartLatency(part, publishedAt);

    if (this.isLastGreetingPart(conversation, part)) {
      await this.publishGreetingChips(conversation);
    }
    if (conversation.status === ConversationStatus.ENDED) {
      await this.sessionEnd.publishCompletedIfFinal(conversation.id, conversation.endReason ?? ConversationEndReason.TIMER_EXPIRED);
    }
  }

  private async publishPart(conversation: Conversation, part: Message): Promise<void> {
    const receivers = await this.publisher.publishQuietly(
      conversation.id,
      ServerEvent.MESSAGE_PART,
      toWireMessage(part, new Map()) as unknown as Record<string, unknown>,
    );
    if (receivers === 0 && part.senderType === MessageSenderType.AGENT && part.kind !== MessageKind.SESSION_END) {
      // Nobody is connected, and pub/sub does not queue: hand it to push.
      metrics.partsPublished.inc({ delivery: 'offline' });
      const agent = await this.agents.getById(conversation.agentId);
      const persona = agent ? await this.agents.getPersonaProfile(agent.personaId) : null;
      await this.push.notifyUndelivered(conversation, part, persona?.displayName ?? agent?.name ?? 'Assistant');
      return;
    }
    metrics.partsPublished.inc({ delivery: receivers > 0 ? 'socket' : 'publish_failed' });
  }

  private isLastGreetingPart(conversation: Conversation, part: Message): boolean {
    return part.turnId === buildReplyTurnId(buildGreetingTurnId(conversation.id)) && (part.partIndex ?? 0) + 1 === (part.partsTotal ?? 1);
  }

  /** Suggestions follow the greeting's last bubble; they are never stored as a row. */
  private async publishGreetingChips(conversation: Conversation): Promise<void> {
    try {
      const agent = await this.agents.getById(conversation.agentId);
      const chips = agent ? this.greeting.resolveChips(conversation, agent) : [];
      if (chips.length > 0) {
        await this.publisher.publishQuietly(conversation.id, ServerEvent.MESSAGE_PART, {
          conversationId: conversation.id,
          kind: MessageKind.SUGGESTED_CHIPS,
          chips,
        });
      }
    } catch (error) {
      this.log.error({ conversationId: conversation.id, error: describeError(error) }, 'greeting chips publish failed — reads still serve them');
    }
  }

  private observeFirstPartLatency(part: Message, publishedAt: Date): void {
    const requestedAt = typeof part.meta?.requestedAt === 'string' ? Date.parse(part.meta.requestedAt) : NaN;
    if (part.partIndex === 0 && part.kind === MessageKind.TEXT && !Number.isNaN(requestedAt)) {
      metrics.turnFirstPartMs.observe(publishedAt.getTime() - requestedAt);
    }
  }
}

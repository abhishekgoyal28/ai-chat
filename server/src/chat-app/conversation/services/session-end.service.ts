import { Injectable } from '@nestjs/common';
import { buildFarewellTurnId, buildReplyTurnId } from '../../../shared/contracts/generation.contract';
import { ServerEvent } from '../../../shared/contracts/socket-protocol';
import { Conversation } from '../../../shared/database/entities';
import { FarewellMode } from '../../../shared/domain/agent-settings';
import { ConversationEndReason, ConversationStatus, MessageKind, MessageSenderType } from '../../../shared/domain/enums';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { metrics } from '../../../shared/observability/metrics';
import { AgentRuntimeService, RuntimeAgent } from '../../agents/agent-runtime.service';
import { WebhookService } from '../../integrations/webhook.service';
import { WebhookEvent } from '../../platform/platform-settings.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { ConversationPublisher } from './conversation-publisher.service';
import { DispatchOutcome, GenerationDispatcher } from './generation-dispatcher.service';
import { RevealScheduler } from './reveal-scheduler.service';

/**
 * Ending a conversation. Every trigger — the timer, the user's End button,
 * the host API, an operator — converges here through one compare-and-set
 * claim, so only one of them ever writes the goodbye.
 *
 *   initiateEnd   claim (reason stored with it) → reveal anything still
 *                 pacing out → if a reply is generating, wait for it;
 *                 otherwise continueEnd now.
 *   continueEnd   divider row → farewell per the agent's mode:
 *                   NONE  finalise now
 *                   FIXED post fallbackText, finalise
 *                   LLM   dispatch a FAREWELL generation; the response
 *                         handler posts it and finalises
 *   finalize      ACTIVE → ENDED, session.ended, webhook.
 *   completed     once nothing is left pending, session.completed — exactly once.
 *
 * The sweeper force-finalises an end that stalls (a lost generation), with
 * the fixed fallback text, so no conversation is ever stuck ending.
 */
@Injectable()
export class SessionEndService {
  private readonly log = getLogger(SessionEndService.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentRuntimeService,
    private readonly dispatcher: GenerationDispatcher,
    private readonly reveals: RevealScheduler,
    private readonly publisher: ConversationPublisher,
    private readonly webhooks: WebhookService,
  ) {}

  /** False when another trigger already owns the end — callers treat that as success. */
  async initiateEnd(conversation: Conversation, reason: ConversationEndReason): Promise<boolean> {
    if (!(await this.conversations.claimEnd(conversation.id, reason))) {
      return false;
    }
    this.log.info({ conversationId: conversation.id, reason }, 'session end initiated');
    await this.flushPending(conversation.id);

    const fresh = await this.conversations.findById(conversation.id);
    if (!fresh) {
      return true;
    }
    if (fresh.inflightDispatchId) {
      // The goodbye must not overtake the answer the user is waiting for.
      this.log.info({ conversationId: conversation.id }, 'end deferred until the in-flight generation lands');
      return true;
    }
    await this.continueEnd(fresh);
    return true;
  }

  /** Runs once the end is claimed and nothing is generating. Idempotent. */
  async continueEnd(conversation: Conversation): Promise<void> {
    const reason = conversation.pendingEndReason ?? ConversationEndReason.TIMER_EXPIRED;
    const agent = await this.agents.getById(conversation.agentId);
    await this.persistDivider(conversation, agent);

    const mode = agent?.settings.farewell.mode ?? FarewellMode.NONE;
    if (agent && mode === FarewellMode.LLM) {
      try {
        const outcome = await this.dispatcher.dispatchFarewell(conversation, agent, reason);
        if (outcome === DispatchOutcome.DISPATCHED) {
          return;
        }
      } catch (error) {
        this.log.error({ conversationId: conversation.id, error: describeError(error) }, 'farewell dispatch failed — posting the fixed farewell');
      }
    }
    if (agent && mode !== FarewellMode.NONE) {
      await this.persistFixedFarewell(conversation, agent);
    }
    await this.finalize(conversation, reason);
  }

  /** The sweeper's escape hatch for an end that never finished. */
  async forceFinalize(conversation: Conversation): Promise<void> {
    const reason = conversation.pendingEndReason ?? ConversationEndReason.TIMER_EXPIRED;
    this.log.warn({ conversationId: conversation.id, reason }, 'session end stalled — force-finalising');
    if (conversation.inflightDispatchId) {
      await this.conversations.releaseGeneration(conversation.id, conversation.inflightDispatchId);
    }
    const agent = await this.agents.getById(conversation.agentId);
    await this.flushPending(conversation.id);
    await this.persistDivider(conversation, agent);
    if (agent && agent.settings.farewell.mode !== FarewellMode.NONE) {
      await this.persistFixedFarewell(conversation, agent);
    }
    await this.finalize(conversation, reason);
  }

  /** ACTIVE → ENDED. False when it was already ended. */
  async finalize(conversation: Conversation, reason: ConversationEndReason): Promise<boolean> {
    if (!(await this.conversations.finalizeEnd(conversation.id, reason))) {
      return false;
    }
    metrics.sessions.inc({ event: 'ended', reason });
    this.log.info({ conversationId: conversation.id, reason }, 'session ended');
    const endedAt = new Date().toISOString();
    await this.publisher.publishQuietly(conversation.id, ServerEvent.SESSION_ENDED, { conversationId: conversation.id, endReason: reason, endedAt });
    await this.webhooks.emit(WebhookEvent.SESSION_ENDED, {
      conversationId: conversation.id,
      externalUserId: conversation.externalUserId,
      agentId: conversation.agentId,
      scope: conversation.scope,
      endReason: reason,
      endedAt,
    });
    // If every part was already revealed, no reveal will come along to send this.
    await this.publishCompletedIfFinal(conversation.id, reason);
    return true;
  }

  /**
   * session.completed: the conversation is ENDED and nothing is pending. Both
   * finalize() and the reveal consumer call this; the completedAt claim, not
   * the check, makes the frame exactly-once.
   */
  async publishCompletedIfFinal(conversationId: string, reason: string): Promise<void> {
    if ((await this.messages.countPending(conversationId)) > 0) {
      return;
    }
    const completedAt = new Date();
    if (!(await this.conversations.claimCompleted(conversationId, completedAt))) {
      return;
    }
    await this.publisher.publishQuietly(conversationId, ServerEvent.SESSION_COMPLETED, {
      conversationId,
      endReason: reason,
      completedAt: completedAt.toISOString(),
    });
  }

  /** Whether a conversation still accepts new user turns. */
  isAcceptingTurns(conversation: Conversation): boolean {
    return conversation.status === ConversationStatus.ACTIVE && !conversation.endInitiatedAt;
  }

  private async persistDivider(conversation: Conversation, agent: RuntimeAgent | null): Promise<void> {
    const { rows } = await this.messages.insertAgentParts(conversation.id, buildFarewellTurnId(conversation.id), null, MessageSenderType.SYSTEM, [
      {
        partIndex: 0,
        kind: MessageKind.SESSION_END,
        body: agent?.settings.farewell.dividerText ?? 'Conversation ended',
        revealAt: new Date(),
        meta: { endReason: conversation.pendingEndReason },
      },
    ]);
    await this.reveals.scheduleAll(conversation.id, rows.map((row) => row.id), [0]);
  }

  private async persistFixedFarewell(conversation: Conversation, agent: RuntimeAgent): Promise<void> {
    const turnId = buildFarewellTurnId(conversation.id);
    const { rows } = await this.messages.insertAgentParts(conversation.id, buildReplyTurnId(turnId), turnId, MessageSenderType.AGENT, [
      { partIndex: 0, kind: MessageKind.FAREWELL, body: agent.settings.farewell.fallbackText, revealAt: new Date(), meta: { fixed: true } },
    ]);
    await this.reveals.scheduleAll(conversation.id, rows.map((row) => row.id), [0]);
  }

  private async flushPending(conversationId: string): Promise<void> {
    const flushed = await this.messages.flushPending(conversationId, new Date());
    if (flushed.length > 0) {
      await this.reveals.scheduleAll(conversationId, flushed, flushed.map(() => 0));
    }
  }
}

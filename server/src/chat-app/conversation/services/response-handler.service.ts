import { Injectable } from '@nestjs/common';
import {
  buildReplyTurnId,
  GenerationFailureReason,
  GenerationKind,
  GenerationResponse,
  GenerationStatus,
  SUPPORTED_RESPONSE_VERSIONS,
} from '../../../shared/contracts/generation.contract';
import { ServerEvent, TurnFailedPayload } from '../../../shared/contracts/socket-protocol';
import { Conversation, Message } from '../../../shared/database/entities';
import { AGENT_LIMITS } from '../../../shared/domain/agent-settings';
import { ConversationEndReason, ConversationStatus, MessageKind, MessageSenderType, MessageStatus } from '../../../shared/domain/enums';
import { ValidationError } from '../../../shared/errors/app-errors';
import { getLogger } from '../../../shared/logger/logger';
import { AgentRuntimeService, RuntimeAgent } from '../../agents/agent-runtime.service';
import { ActionRunnerService } from '../../integrations/action-runner.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { sanitizeChips } from '../serializers/message.serializer';
import { ConversationPublisher } from './conversation-publisher.service';
import { GenerationDispatcher } from './generation-dispatcher.service';
import { GreetingService } from './greeting.service';
import { computeRevealOffsets, RevealScheduler } from './reveal-scheduler.service';
import { SessionEndService } from './session-end.service';

/** A failed turn the user can fix by retrying (or rephrasing). NOT_CONFIGURED needs an operator. */
const NON_RETRYABLE_FAILURES = new Set<string>([GenerationFailureReason.NOT_CONFIGURED]);

/**
 * Consumes chat-expert's responses: persists reply parts PENDING with their
 * reveal schedule, hands each to the reveal queue, releases the generation
 * claim, then moves the conversation on — the next outstanding turn, or the
 * deferred end.
 *
 * Idempotent end to end: parts insert under a deterministic turn id (a
 * redelivery re-derives it and the insert dedupes), and every follow-up step
 * is a compare-and-set. A response whose dispatch no longer holds the claim
 * (timed out and retried, or the conversation ended) is stale and dropped,
 * so a late answer can never land under the goodbye.
 */
@Injectable()
export class ResponseHandler {
  private readonly log = getLogger(ResponseHandler.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentRuntimeService,
    private readonly dispatcher: GenerationDispatcher,
    private readonly reveals: RevealScheduler,
    private readonly sessionEnd: SessionEndService,
    private readonly greeting: GreetingService,
    private readonly actions: ActionRunnerService,
    private readonly publisher: ConversationPublisher,
  ) {}

  async handle(raw: GenerationResponse): Promise<void> {
    const response = this.validate(raw);
    const conversation = await this.conversations.findById(response.conversationId);
    if (!conversation) {
      this.log.warn({ conversationId: response.conversationId }, 'response for an unknown conversation — dropped');
      return;
    }
    const agent = await this.agents.getById(conversation.agentId);
    const replyTurnId = buildReplyTurnId(response.requestTurnId);

    if (conversation.inflightDispatchId !== response.dispatchId) {
      await this.handleWithoutClaim(conversation, agent, response, replyTurnId);
      return;
    }

    const persisted = await this.persist(conversation, agent, response, replyTurnId);
    await this.conversations.releaseGeneration(conversation.id, response.dispatchId);
    if (persisted.inserted && response.action && agent) {
      // Only on the first insert: a redelivery must never trigger the action twice.
      await this.actions.run(conversation, agent, response.requestTurnId, response.action);
    }
    await this.followUp(conversation.id, response);
  }

  /**
   * The claim is gone. If this response's parts already exist, a previous
   * attempt crashed after persisting — finish its follow-up. Otherwise the
   * dispatch was abandoned and the response is stale.
   */
  private async handleWithoutClaim(
    conversation: Conversation,
    agent: RuntimeAgent | null,
    response: GenerationResponse,
    replyTurnId: string,
  ): Promise<void> {
    const existing = await this.messages.findTurn(conversation.id, replyTurnId);
    if (existing.length === 0) {
      this.log.info(
        { conversationId: conversation.id, turnId: response.requestTurnId, kind: response.kind, status: conversation.status },
        'stale generation response — dropped',
      );
      return;
    }
    await this.schedulePending(conversation.id, existing, agent);
    await this.followUp(conversation.id, response);
  }

  private async persist(
    conversation: Conversation,
    agent: RuntimeAgent | null,
    response: GenerationResponse,
    replyTurnId: string,
  ): Promise<{ inserted: boolean }> {
    if (response.status === GenerationStatus.FAILED) {
      return this.persistFailure(conversation, agent, response);
    }

    const kind = response.kind === GenerationKind.FAREWELL ? MessageKind.FAREWELL : MessageKind.TEXT;
    const offsets = agent ? computeRevealOffsets(response.parts, agent.settings.pacing) : response.parts.map(() => 0);
    const now = Date.now();
    const { rows, inserted } = await this.messages.insertAgentParts(
      conversation.id,
      replyTurnId,
      response.requestTurnId,
      MessageSenderType.AGENT,
      response.parts.map((body, index) => ({
        partIndex: index,
        kind: response.kind === GenerationKind.GREETING && index === 0 ? MessageKind.GREETING : kind,
        body,
        revealAt: new Date(now + offsets[index]),
        // Generation metadata on part 0 only, so per-reply analytics read one row.
        meta:
          index === 0
            ? {
                ...(response.meta ?? {}),
                requestedAt: conversation.inflightSince?.toISOString() ?? null,
                ...(response.action && { action: response.action.name }),
              }
            : null,
      })),
    );

    if (response.kind === GenerationKind.REPLY) {
      await this.messages.markUserMessagesAnswered(conversation.id, response.answeredMessageIds);
    }
    if (response.kind === GenerationKind.GREETING && response.chips?.length) {
      // Pinned before the reveals go out: the last greeting part publishes them.
      const chips = sanitizeChips(response.chips, AGENT_LIMITS.maxChips, AGENT_LIMITS.maxChipChars).map((chip) => chip.text);
      if (chips.length > 0) {
        await this.conversations.setSuggestedChips(conversation.id, chips);
      }
    }
    await this.reveals.scheduleAll(conversation.id, rows.map((row) => row.id), offsets);
    this.log.info(
      { conversationId: conversation.id, turnId: response.requestTurnId, kind: response.kind, parts: rows.length, inserted },
      'reply persisted',
    );
    return { inserted };
  }

  private async persistFailure(
    conversation: Conversation,
    agent: RuntimeAgent | null,
    response: GenerationResponse,
  ): Promise<{ inserted: boolean }> {
    const reason = response.failureReason ?? GenerationFailureReason.PROVIDER_ERROR;
    switch (response.kind) {
      case GenerationKind.REPLY: {
        await this.messages.markUserMessagesFailed(conversation.id, response.answeredMessageIds);
        const payload: TurnFailedPayload = {
          conversationId: conversation.id,
          turnId: response.requestTurnId,
          reason,
          retryable: !NON_RETRYABLE_FAILURES.has(reason),
        };
        await this.publisher.publishQuietly(conversation.id, ServerEvent.TURN_FAILED, { ...payload });
        break;
      }
      case GenerationKind.GREETING:
        // A broken opener would be an absurd first line; the template is the intended fallback.
        if (agent) {
          const persona = await this.agents.getPersonaProfile(agent.personaId);
          await this.greeting.persistTemplateGreeting(conversation, agent, persona?.displayName ?? agent.name);
        }
        break;
      case GenerationKind.FAREWELL:
        // continueEnd / forceFinalize post the fixed farewell; finalize happens in followUp.
        break;
    }
    this.log.warn({ conversationId: conversation.id, turnId: response.requestTurnId, kind: response.kind, reason }, 'generation failed');
    return { inserted: false };
  }

  /** What happens next, re-read fresh because the claim and end state may have just changed. */
  private async followUp(conversationId: string, response: GenerationResponse): Promise<void> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation || conversation.status !== ConversationStatus.ACTIVE) {
      return;
    }
    if (response.kind === GenerationKind.FAREWELL) {
      if (response.status === GenerationStatus.FAILED) {
        await this.sessionEnd.forceFinalize(conversation);
      } else {
        await this.sessionEnd.finalize(conversation, conversation.pendingEndReason ?? ConversationEndReason.TIMER_EXPIRED);
      }
      return;
    }
    if (conversation.endInitiatedAt) {
      await this.sessionEnd.continueEnd(conversation);
      return;
    }
    // Messages that arrived while this generation ran are answered now, with it in history.
    await this.dispatcher.dispatchPendingReply(conversation);
  }

  private async schedulePending(conversationId: string, rows: Message[], agent: RuntimeAgent | null): Promise<void> {
    const pending = rows.filter((row) => row.status === MessageStatus.PENDING);
    if (pending.length === 0) {
      return;
    }
    const offsets = agent ? computeRevealOffsets(pending.map((row) => row.body ?? ''), agent.settings.pacing) : pending.map(() => 0);
    await this.reveals.scheduleAll(conversationId, pending.map((row) => row.id), offsets);
  }

  private validate(response: GenerationResponse): GenerationResponse {
    if (!response || !SUPPORTED_RESPONSE_VERSIONS.has(response.schemaVersion)) {
      throw new ValidationError(`unsupported generation response version: ${String(response?.schemaVersion)}`);
    }
    if (!response.conversationId || !response.dispatchId || !response.requestTurnId || !response.status) {
      throw new ValidationError('generation response is missing required fields');
    }
    if (response.status === GenerationStatus.SUCCESS && !response.parts?.length) {
      throw new ValidationError('SUCCESS response carries no parts');
    }
    return { ...response, answeredMessageIds: response.answeredMessageIds ?? [] };
  }
}

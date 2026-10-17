import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '../../../shared/config/config';
import {
  buildFarewellTurnId,
  buildGreetingTurnId,
  GENERATION_SCHEMA_VERSION,
  GenerationKind,
  GenerationRequest,
  HistoryEntry,
  HistoryRole,
  RequestUserMessage,
} from '../../../shared/contracts/generation.contract';
import { ServerEvent } from '../../../shared/contracts/socket-protocol';
import { Conversation, Message } from '../../../shared/database/entities';
import { ChipsSource, GreetingMode } from '../../../shared/domain/agent-settings';
import { ConversationEndReason, ConversationStatus, MessageSenderType } from '../../../shared/domain/enums';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { QueueName } from '../../../shared/queue/queue.definitions';
import { QUEUE_TRANSPORT, QueueTransport } from '../../../shared/queue/queue-transport';
import { AgentRuntimeService, RuntimeAgent } from '../../agents/agent-runtime.service';
import { ActionRunnerService } from '../../integrations/action-runner.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { ConversationPublisher } from './conversation-publisher.service';

export enum DispatchOutcome {
  DISPATCHED = 'DISPATCHED',
  /** Another generation holds the claim; this work is picked up when it lands. */
  BUSY = 'BUSY',
  NOTHING_TO_DO = 'NOTHING_TO_DO',
}

/**
 * Sends generation requests to chat-expert under the conversation's
 * generation claim — at most one in flight per conversation.
 *
 * Why one at a time: a second turn generated concurrently with the first
 * would be answered without the first answer in its history, so the user
 * gets two replies where the second ignores the first. Instead, messages
 * that arrive mid-generation wait, and when the reply lands they are
 * answered together, with that reply in context.
 */
@Injectable()
export class GenerationDispatcher {
  private readonly log = getLogger(GenerationDispatcher.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentRuntimeService,
    private readonly actions: ActionRunnerService,
    private readonly publisher: ConversationPublisher,
    @Inject(QUEUE_TRANSPORT) private readonly queue: QueueTransport,
  ) {}

  /** Answers every outstanding user message, if nothing else is generating. */
  async dispatchPendingReply(conversation: Conversation): Promise<DispatchOutcome> {
    if (conversation.status !== ConversationStatus.ACTIVE || conversation.endInitiatedAt) {
      return DispatchOutcome.NOTHING_TO_DO;
    }
    const outstanding = await this.messages.findOutstandingUserMessages(conversation.id);
    if (outstanding.length === 0) {
      return DispatchOutcome.NOTHING_TO_DO;
    }
    const agent = await this.requireAgent(conversation.agentId);
    const turnId = outstanding[outstanding.length - 1].turnId;

    return this.withClaim(conversation, turnId, async (dispatchId) => {
      const [history, quoted, availableActions] = await Promise.all([
        this.buildHistory(conversation.id, agent, outstanding.map((message) => message.id)),
        this.messages.findVisibleByIds(
          conversation.id,
          outstanding.map((message) => message.replyToId).filter((id): id is string => Boolean(id)),
        ),
        this.actions.availableActions(conversation, agent),
      ]);
      await this.send(
        this.baseRequest(conversation, agent, dispatchId, turnId, GenerationKind.REPLY, {
          userMessages: outstanding.map((message) => this.toRequestMessage(message, quoted)),
          history,
          ...(availableActions.length > 0 && { availableActions }),
        }),
      );
      await this.publisher.publishQuietly(conversation.id, ServerEvent.AGENT_TYPING, {
        conversationId: conversation.id,
        turnId,
        maxDurationMs: config.GENERATION_TIMEOUT_MS,
      });
    });
  }

  /** The LLM-written opening message (greeting mode LLM). */
  async dispatchGreeting(conversation: Conversation, agent: RuntimeAgent): Promise<DispatchOutcome> {
    const turnId = buildGreetingTurnId(conversation.id);
    const chipCount = agent.settings.chips.source === ChipsSource.LLM ? agent.settings.chips.count : undefined;
    return this.withClaim(conversation, turnId, (dispatchId) =>
      this.send(
        this.baseRequest(conversation, agent, dispatchId, turnId, GenerationKind.GREETING, {
          userMessages: [],
          history: [],
          ...(chipCount && { chipCount }),
        }),
      ),
    );
  }

  /** The LLM-written closing message (farewell mode LLM). Runs after the end claim. */
  async dispatchFarewell(conversation: Conversation, agent: RuntimeAgent, endReason: ConversationEndReason): Promise<DispatchOutcome> {
    const turnId = buildFarewellTurnId(conversation.id);
    return this.withClaim(conversation, turnId, async (dispatchId) =>
      this.send(
        this.baseRequest(conversation, agent, dispatchId, turnId, GenerationKind.FAREWELL, {
          userMessages: [],
          history: await this.buildHistory(conversation.id, agent, []),
          endReason,
        }),
      ),
    );
  }

  isGreetingPending(agent: RuntimeAgent): boolean {
    return agent.settings.greeting.mode === GreetingMode.LLM;
  }

  /**
   * Takes the claim, runs `send`, and releases the claim again if sending
   * failed — a claim held by a request that never left would block the
   * conversation until the stale-generation sweep.
   */
  private async withClaim(conversation: Conversation, turnId: string, send: (dispatchId: string) => Promise<void>): Promise<DispatchOutcome> {
    const dispatchId = randomUUID();
    if (!(await this.conversations.claimGeneration(conversation.id, dispatchId))) {
      return DispatchOutcome.BUSY;
    }
    try {
      await send(dispatchId);
      this.log.info({ conversationId: conversation.id, turnId, dispatchId }, 'generation dispatched');
      return DispatchOutcome.DISPATCHED;
    } catch (error) {
      this.log.error({ conversationId: conversation.id, turnId, error: describeError(error) }, 'generation dispatch failed — releasing claim');
      await this.conversations.releaseGeneration(conversation.id, dispatchId);
      throw error;
    }
  }

  private async send(request: GenerationRequest): Promise<void> {
    await this.queue.send(QueueName.GENERATION_REQUESTS, { body: request, deduplicationId: `request:${request.dispatchId}` });
  }

  private baseRequest(
    conversation: Conversation,
    agent: RuntimeAgent,
    dispatchId: string,
    turnId: string,
    kind: GenerationKind,
    extra: Pick<GenerationRequest, 'userMessages' | 'history'> & Partial<GenerationRequest>,
  ): GenerationRequest {
    return {
      schemaVersion: GENERATION_SCHEMA_VERSION,
      dispatchId,
      conversationId: conversation.id,
      agentId: agent.id,
      turnId,
      kind,
      ...(conversation.llmProviderId && conversation.llmModel && {
        route: { providerId: conversation.llmProviderId, model: conversation.llmModel },
      }),
      user: {
        externalUserId: conversation.externalUserId,
        name: conversation.userName,
        ...(conversation.userAttributes && { attributes: conversation.userAttributes }),
      },
      context: (conversation.context as GenerationRequest['context']) ?? null,
      deadline: new Date(Date.now() + config.GENERATION_TIMEOUT_MS).toISOString(),
      ...extra,
    };
  }

  private async buildHistory(conversationId: string, agent: RuntimeAgent, excludeIds: string[]): Promise<HistoryEntry[]> {
    const rows = await this.messages.findHistory(conversationId, agent.settings.history.turns, excludeIds);
    return rows
      .filter((row) => row.body)
      .map((row) => ({ role: row.senderType === MessageSenderType.USER ? HistoryRole.USER : HistoryRole.AGENT, body: row.body ?? '' }));
  }

  private toRequestMessage(message: Message, quoted: Map<string, Message>): RequestUserMessage {
    const target = message.replyToId ? quoted.get(message.replyToId) : undefined;
    return {
      id: message.id,
      body: message.body ?? '',
      ...(target?.body && {
        replyTo: { role: target.senderType === MessageSenderType.USER ? HistoryRole.USER : HistoryRole.AGENT, body: target.body },
      }),
    };
  }

  private async requireAgent(agentId: string): Promise<RuntimeAgent> {
    const agent = await this.agents.getById(agentId);
    if (!agent) {
      throw new Error(`agent ${agentId} no longer exists`);
    }
    return agent;
  }
}

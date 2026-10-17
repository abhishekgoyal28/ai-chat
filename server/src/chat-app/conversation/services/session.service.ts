import { Injectable } from '@nestjs/common';
import { config, publicSocketUrl } from '../../../shared/config/config';
import { Conversation } from '../../../shared/database/entities';
import { ClientBehaviour, GreetingMode } from '../../../shared/domain/agent-settings';
import { ConversationEndReason, ConversationStatus, MessageSenderType } from '../../../shared/domain/enums';
import { ForbiddenError, NotFoundError } from '../../../shared/errors/app-errors';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { metrics } from '../../../shared/observability/metrics';
import { signSessionToken } from '../../../shared/security/session-token';
import { AgentRuntimeService, pickModelRoute, RuntimeAgent } from '../../agents/agent-runtime.service';
import { WebhookService } from '../../integrations/webhook.service';
import { WebhookEvent } from '../../platform/platform-settings.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { buildPageBlock, PageBlock, StreamItem, toWireMessages, withSuggestedChips } from '../serializers/message.serializer';
import { GenerationDispatcher } from './generation-dispatcher.service';
import { GreetingService } from './greeting.service';
import { SessionEndService } from './session-end.service';

export interface StartSessionInput {
  agentSlug: string;
  externalUserId: string;
  scope?: string;
  userName?: string | null;
  userAttributes?: Record<string, string> | null;
  context?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface SessionSummary {
  conversationId: string;
  agent: { id: string; slug: string };
  externalUserId: string;
  scope: string;
  status: ConversationStatus;
  /** False once the conversation has ended or is ending — disable the composer. */
  acceptingMessages: boolean;
  endReason: string | null;
  startedAt: string;
  /** Null when the session never ends on its own. */
  expiresAt: string | null;
  endedAt: string | null;
}

export interface SessionGrant extends SessionSummary {
  created: boolean;
  token: string;
  tokenExpiresAt: string;
  socketUrl: string;
  apiUrl: string;
}

export interface ClientSessionView extends SessionSummary {
  serverTime: string;
  agentProfile: { name: string; avatarUrl: string | null; tagline: string | null };
  config: ClientBehaviour;
  messages: StreamItem[];
  page: PageBlock;
}

/** First screenful of a reopened conversation. Deeper scrollback is the messages endpoint's job. */
const SESSION_PAGE_SIZE = 30;

/**
 * Create-or-resume, driven by the host backend. One conversation per
 * (agent, user, scope), forever:
 *   - new        → created ACTIVE; the timer (if the agent has one) starts now
 *   - ACTIVE     → the same conversation continues; host-supplied user details
 *                  and context are refreshed
 *   - ENDED      → returned read-only; never a new timer
 * The host passes a different `scope` when it wants a fresh conversation.
 */
@Injectable()
export class SessionService {
  private readonly log = getLogger(SessionService.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentRuntimeService,
    private readonly greeting: GreetingService,
    private readonly dispatcher: GenerationDispatcher,
    private readonly sessionEnd: SessionEndService,
    private readonly webhooks: WebhookService,
  ) {}

  async startOrResume(input: StartSessionInput): Promise<SessionGrant> {
    const agent = await this.agents.getBySlug(input.agentSlug);
    if (!agent) {
      throw new NotFoundError(`agent "${input.agentSlug}"`);
    }
    if (!agent.active) {
      throw new ForbiddenError(`agent "${input.agentSlug}" is disabled`);
    }

    const now = new Date();
    const route = pickModelRoute(agent.modelRoutes);
    const durationSec = agent.settings.session.durationSec;
    const { conversation, created } = await this.conversations.insertOrFind({
      agentId: agent.id,
      externalUserId: input.externalUserId,
      scope: input.scope ?? '',
      startedAt: now,
      expiresAt: durationSec ? new Date(now.getTime() + durationSec * 1000) : null,
      userName: input.userName ?? null,
      userAttributes: input.userAttributes ?? null,
      context: input.context ?? null,
      llmProviderId: route?.providerId ?? null,
      llmModel: route?.model ?? null,
      metadata: input.metadata ?? null,
    });

    if (created) {
      await this.onCreated(conversation, agent);
    } else {
      await this.onResumed(conversation, input);
    }

    const current = (await this.conversations.findById(conversation.id)) ?? conversation;
    return this.grant(current, agent, created);
  }

  /** A fresh token for an existing conversation — for long or never-ending sessions. */
  async refreshToken(conversationId: string): Promise<SessionGrant> {
    const conversation = await this.requireConversation(conversationId);
    const agent = await this.requireAgent(conversation.agentId);
    return this.grant(conversation, agent, false);
  }

  async getSummary(conversationId: string): Promise<SessionSummary> {
    const conversation = await this.requireConversation(conversationId);
    const agent = await this.requireAgent(conversation.agentId);
    return this.summarise(conversation, agent);
  }

  async updateContext(
    conversationId: string,
    values: { userName?: string | null; userAttributes?: Record<string, string> | null; context?: Record<string, unknown> | null },
  ): Promise<SessionSummary> {
    await this.requireConversation(conversationId);
    await this.conversations.updateParticipantContext(conversationId, values);
    return this.getSummary(conversationId);
  }

  async end(conversationId: string, reason: ConversationEndReason): Promise<SessionSummary> {
    const conversation = await this.requireConversation(conversationId);
    await this.sessionEnd.initiateEnd(conversation, reason);
    return this.getSummary(conversationId);
  }

  async listForUser(externalUserId: string, beforeId: string | undefined, limit: number): Promise<{ sessions: SessionSummary[]; nextBefore: string | null }> {
    const { rows, hasMore } = await this.conversations.list({ externalUserId, beforeId, limit });
    const agents = await Promise.all([...new Set(rows.map((row) => row.agentId))].map((id) => this.agents.getById(id)));
    const byId = new Map(agents.filter((agent): agent is RuntimeAgent => agent !== null).map((agent) => [agent.id, agent]));
    const sessions = rows
      .filter((row) => byId.has(row.agentId))
      .map((row) => this.summarise(row, byId.get(row.agentId) as RuntimeAgent));
    return { sessions, nextBefore: hasMore && rows.length > 0 ? rows[rows.length - 1].id : null };
  }

  /** What the chat screen needs to render: identity, behaviour, the newest page and suggestions. */
  async getClientView(conversationId: string): Promise<ClientSessionView> {
    let conversation = await this.requireConversation(conversationId);
    const agent = await this.requireAgent(conversation.agentId);
    conversation = await this.applyLazyExpiry(conversation);

    const [persona, page] = await Promise.all([
      this.agents.getPersonaProfile(agent.personaId),
      this.messages.findPage(conversation.id, { limit: SESSION_PAGE_SIZE }),
    ]);
    const quoted = await this.messages.findVisibleByIds(
      conversation.id,
      page.messages.map((message) => message.replyToId).filter((id): id is string => Boolean(id)),
    );
    const userHasSpoken = page.messages.some((message) => message.senderType === MessageSenderType.USER);
    const greetingPending = agent.settings.greeting.mode === GreetingMode.LLM && page.messages.length === 0;
    const offerChips = conversation.status === ConversationStatus.ACTIVE && !conversation.endInitiatedAt && !page.hasMore && !userHasSpoken && !greetingPending;

    return {
      ...this.summarise(conversation, agent),
      serverTime: new Date().toISOString(),
      agentProfile: {
        name: persona?.displayName ?? agent.name,
        avatarUrl: persona?.avatarUrl ?? null,
        tagline: persona?.tagline ?? null,
      },
      config: agent.settings.client,
      messages: withSuggestedChips(toWireMessages(page.messages, quoted), offerChips ? this.greeting.resolveChips(conversation, agent) : []),
      page: buildPageBlock(page.messages, page.hasMore, SESSION_PAGE_SIZE),
    };
  }

  private async onCreated(conversation: Conversation, agent: RuntimeAgent): Promise<void> {
    metrics.sessions.inc({ event: 'created', reason: '' });
    this.log.info({ conversationId: conversation.id, agent: agent.slug }, 'conversation created');
    await this.webhooks.emit(WebhookEvent.SESSION_STARTED, {
      conversationId: conversation.id,
      externalUserId: conversation.externalUserId,
      agentId: agent.id,
      agentSlug: agent.slug,
      scope: conversation.scope,
      startedAt: conversation.startedAt.toISOString(),
      expiresAt: conversation.expiresAt?.toISOString() ?? null,
    });

    const persona = await this.agents.getPersonaProfile(agent.personaId);
    const displayName = persona?.displayName ?? agent.name;
    if (agent.settings.greeting.mode === GreetingMode.TEMPLATE) {
      await this.greeting.persistTemplateGreeting(conversation, agent, displayName);
    } else if (agent.settings.greeting.mode === GreetingMode.LLM) {
      try {
        await this.dispatcher.dispatchGreeting(conversation, agent);
      } catch (error) {
        // A conversation must never open empty over a queue error.
        this.log.error({ conversationId: conversation.id, error: describeError(error) }, 'LLM greeting dispatch failed — using the template');
        await this.greeting.persistTemplateGreeting(conversation, agent, displayName);
      }
    }
  }

  private async onResumed(conversation: Conversation, input: StartSessionInput): Promise<void> {
    if (conversation.status === ConversationStatus.ACTIVE) {
      await this.conversations.updateParticipantContext(conversation.id, {
        userName: input.userName,
        userAttributes: input.userAttributes,
        context: input.context,
      });
    }
    await this.applyLazyExpiry(conversation);
  }

  /** A session opened after its timer ran out starts ending now instead of at the next sweep. */
  private async applyLazyExpiry(conversation: Conversation): Promise<Conversation> {
    if (
      conversation.status === ConversationStatus.ACTIVE &&
      !conversation.endInitiatedAt &&
      conversation.expiresAt &&
      conversation.expiresAt.getTime() <= Date.now()
    ) {
      await this.sessionEnd.initiateEnd(conversation, ConversationEndReason.TIMER_EXPIRED);
      return (await this.conversations.findById(conversation.id)) ?? conversation;
    }
    return conversation;
  }

  private grant(conversation: Conversation, agent: RuntimeAgent, created: boolean): SessionGrant {
    const token = signSessionToken({
      conversationId: conversation.id,
      externalUserId: conversation.externalUserId,
      agentId: agent.id,
      maxMessagesPerTurn: agent.settings.client.maxMessagesPerTurn,
      maxBodyChars: agent.settings.client.maxBodyChars,
    });
    return {
      ...this.summarise(conversation, agent),
      created,
      token,
      tokenExpiresAt: new Date(Date.now() + config.SESSION_TOKEN_TTL_SEC * 1000).toISOString(),
      socketUrl: publicSocketUrl(),
      apiUrl: config.PUBLIC_APP_URL,
    };
  }

  private summarise(conversation: Conversation, agent: RuntimeAgent): SessionSummary {
    return {
      conversationId: conversation.id,
      agent: { id: agent.id, slug: agent.slug },
      externalUserId: conversation.externalUserId,
      scope: conversation.scope,
      status: conversation.status,
      acceptingMessages: this.sessionEnd.isAcceptingTurns(conversation),
      endReason: conversation.endReason ?? (conversation.endInitiatedAt ? conversation.pendingEndReason : null),
      startedAt: conversation.startedAt.toISOString(),
      expiresAt: conversation.expiresAt?.toISOString() ?? null,
      endedAt: conversation.endedAt?.toISOString() ?? null,
    };
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.conversations.findById(id);
    if (!conversation) {
      throw new NotFoundError('conversation');
    }
    return conversation;
  }

  private async requireAgent(id: string): Promise<RuntimeAgent> {
    const agent = await this.agents.getById(id);
    if (!agent) {
      throw new NotFoundError('agent');
    }
    return agent;
  }
}

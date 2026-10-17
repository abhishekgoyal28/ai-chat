import { Injectable } from '@nestjs/common';
import { config, publicSocketUrl } from '../../../shared/config/config';
import { agentSettingsSchema, AGENT_LIMITS } from '../../../shared/domain/agent-settings';
import { AdminRole, LlmProviderKind, PushMode, RecordStatus } from '../../../shared/domain/enums';
import { AgentRuntimeRepository } from '../../agents/agent-runtime.repository';
import { ApiKeyRepository } from '../../auth/api-key.repository';
import { ConversationRepository } from '../../conversation/repositories/conversation.repository';
import { MessageRepository } from '../../conversation/repositories/message.repository';
import { DEFAULT_WEBHOOK_EVENTS } from '../../platform/platform-settings.service';
import { AgentAdminRepository, ProviderRepository } from '../repositories/config.repositories';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The dashboard home: usage numbers, and a setup checklist for a fresh install. */
@Injectable()
export class OverviewService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentAdminRepository,
    private readonly runtimeAgents: AgentRuntimeRepository,
    private readonly providers: ProviderRepository,
    private readonly apiKeys: ApiKeyRepository,
  ) {}

  async overview(): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - DAY_MS);
    const [created24h, active, replies, byAgent, agents, providers, keys] = await Promise.all([
      this.conversations.countCreatedSince(since),
      this.conversations.countActive(),
      this.messages.replyStatsSince(since),
      this.conversations.countByAgentSince(new Date(Date.now() - 7 * DAY_MS)),
      this.agents.list(),
      this.providers.list(),
      this.apiKeys.list(),
    ]);
    const names = new Map((await this.runtimeAgents.findAgentsByIds(byAgent.map((row) => row.agentId))).map((agent) => [agent.id, agent.name]));

    return {
      last24h: { conversations: created24h, replies: replies.replies, avgReplyLatencyMs: replies.avgLatencyMs, inputTokens: replies.inputTokens, outputTokens: replies.outputTokens },
      activeConversations: active,
      conversationsByAgent7d: byAgent.map((row) => ({ agentId: row.agentId, name: names.get(row.agentId) ?? `#${row.agentId}`, conversations: row.conversations })),
      setup: {
        providerAdded: providers.some((provider) => provider.status === RecordStatus.ACTIVE),
        agentCreated: agents.length > 0,
        agentRouted: agents.some((agent) => (agent.modelRoutes ?? []).length > 0),
        apiKeyCreated: keys.some((key) => !key.revokedAt),
        hasConversations: created24h > 0 || active > 0,
      },
    };
  }

  /** Enums, limits and defaults the dashboard renders forms from, so it never hard-codes them. */
  meta(): Record<string, unknown> {
    return {
      version: process.env.npm_package_version ?? '0.1.0',
      publicAppUrl: config.PUBLIC_APP_URL,
      publicSocketUrl: publicSocketUrl(),
      queueDriver: config.QUEUE_DRIVER,
      providerKinds: Object.values(LlmProviderKind),
      roles: Object.values(AdminRole),
      pushModes: Object.values(PushMode),
      webhookEvents: DEFAULT_WEBHOOK_EVENTS,
      agentLimits: AGENT_LIMITS,
      agentSettingsDefaults: agentSettingsSchema.parse({}),
    };
  }
}

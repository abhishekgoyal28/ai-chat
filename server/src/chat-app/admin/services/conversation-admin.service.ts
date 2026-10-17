import { Injectable } from '@nestjs/common';
import { ActionInvocation, Conversation, Message } from '../../../shared/database/entities';
import { ConversationEndReason, ConversationStatus } from '../../../shared/domain/enums';
import { NotFoundError } from '../../../shared/errors/app-errors';
import { AgentRuntimeRepository } from '../../agents/agent-runtime.repository';
import { ConversationRepository } from '../../conversation/repositories/conversation.repository';
import { MessageRepository } from '../../conversation/repositories/message.repository';
import { SessionEndService } from '../../conversation/services/session-end.service';
import { ActionInvocationRepository } from '../../integrations/integration.repositories';

/** Operators read whole transcripts, unrevealed parts and generation metadata included. */
const TRANSCRIPT_LIMIT = 2000;

export interface ConversationListItem {
  id: string;
  agent: { id: string; slug: string; name: string } | null;
  externalUserId: string;
  userName: string | null;
  scope: string;
  status: ConversationStatus;
  endReason: string | null;
  startedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
}

@Injectable()
export class ConversationAdminService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly invocations: ActionInvocationRepository,
    private readonly agents: AgentRuntimeRepository,
    private readonly sessionEnd: SessionEndService,
  ) {}

  async list(filter: { agentId?: string; externalUserId?: string; status?: ConversationStatus; before?: string; limit: number }): Promise<{
    conversations: ConversationListItem[];
    nextBefore: string | null;
  }> {
    const { rows, hasMore } = await this.conversations.list({ ...filter, beforeId: filter.before });
    const agents = await this.agents.findAgentsByIds([...new Set(rows.map((row) => row.agentId))]);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    return {
      conversations: rows.map((row) => this.toItem(row, byId.get(row.agentId) ?? null)),
      nextBefore: hasMore && rows.length > 0 ? rows[rows.length - 1].id : null,
    };
  }

  async get(id: string): Promise<{
    conversation: ConversationListItem & { userAttributes: Record<string, string> | null; context: Record<string, unknown> | null; metadata: Record<string, unknown> | null; llmProviderId: string | null; llmModel: string | null; generating: boolean };
    messages: Message[];
    actions: ActionInvocation[];
  }> {
    const conversation = await this.require(id);
    const [messages, actions, agents] = await Promise.all([
      this.messages.findAllForConversation(id, TRANSCRIPT_LIMIT),
      this.invocations.findForConversation(id),
      this.agents.findAgentsByIds([conversation.agentId]),
    ]);
    return {
      conversation: {
        ...this.toItem(conversation, agents[0] ?? null),
        userAttributes: conversation.userAttributes,
        context: conversation.context,
        metadata: conversation.metadata,
        llmProviderId: conversation.llmProviderId,
        llmModel: conversation.llmModel,
        generating: Boolean(conversation.inflightDispatchId),
      },
      messages,
      actions,
    };
  }

  async end(id: string): Promise<void> {
    const conversation = await this.require(id);
    await this.sessionEnd.initiateEnd(conversation, ConversationEndReason.ADMIN_ENDED);
  }

  private toItem(conversation: Conversation, agent: { id: string; slug: string; name: string } | null): ConversationListItem {
    return {
      id: conversation.id,
      agent: agent ? { id: agent.id, slug: agent.slug, name: agent.name } : null,
      externalUserId: conversation.externalUserId,
      userName: conversation.userName,
      scope: conversation.scope,
      status: conversation.status,
      endReason: conversation.endReason ?? conversation.pendingEndReason,
      startedAt: conversation.startedAt.toISOString(),
      expiresAt: conversation.expiresAt?.toISOString() ?? null,
      endedAt: conversation.endedAt?.toISOString() ?? null,
    };
  }

  private async require(id: string): Promise<Conversation> {
    const conversation = await this.conversations.findById(id);
    if (!conversation) {
      throw new NotFoundError('conversation');
    }
    return conversation;
  }
}

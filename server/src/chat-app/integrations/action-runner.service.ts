import { Injectable } from '@nestjs/common';
import { GenerationAction } from '../../shared/contracts/generation.contract';
import { Conversation } from '../../shared/database/entities';
import { AgentActionDefinition } from '../../shared/domain/agent-settings';
import { describeError, getLogger } from '../../shared/logger/logger';
import { WebhookEvent } from '../platform/platform-settings.service';
import { RuntimeAgent } from '../agents/agent-runtime.service';
import { ActionInvocationRepository } from './integration.repositories';
import { WebhookService } from './webhook.service';

/**
 * Agent actions: things the model can trigger alongside a reply, delivered to
 * the host as `action.invoked` webhooks. The host does the actual work
 * (create a ticket, book a slot, escalate to a human).
 *
 * Offered only when they can actually run: the action is enabled, its
 * per-conversation quota has room, and a webhook URL is configured. The model
 * is never told about an action that would fail.
 */
@Injectable()
export class ActionRunnerService {
  private readonly log = getLogger(ActionRunnerService.name);

  constructor(
    private readonly invocations: ActionInvocationRepository,
    private readonly webhooks: WebhookService,
  ) {}

  async availableActions(conversation: Conversation, agent: RuntimeAgent): Promise<string[]> {
    const enabled = agent.settings.actions.filter((action) => action.enabled);
    if (enabled.length === 0) {
      return [];
    }
    try {
      if (!(await this.webhooks.isConfigured())) {
        return [];
      }
      const used = await this.invocations.countByAction(conversation.id);
      return enabled
        .filter((action) => action.maxPerConversation === null || (used.get(action.name) ?? 0) < action.maxPerConversation)
        .map((action) => action.name);
    } catch (error) {
      // An eligibility failure costs the turn its actions, never its reply.
      this.log.warn({ conversationId: conversation.id, error: describeError(error) }, 'action availability check failed');
      return [];
    }
  }

  /** Runs after the reply is persisted. Never throws: the reply stands whatever happens here. */
  async run(conversation: Conversation, agent: RuntimeAgent, turnId: string, action: GenerationAction): Promise<void> {
    const definition: AgentActionDefinition | undefined = agent.settings.actions.find((candidate) => candidate.name === action.name && candidate.enabled);
    if (!definition) {
      this.log.warn({ conversationId: conversation.id, action: action.name }, 'model returned an action the agent does not offer — dropped');
      return;
    }
    const missing = definition.parameters.filter((parameter) => parameter.required && !action.arguments[parameter.name]);
    if (missing.length > 0) {
      this.log.warn({ conversationId: conversation.id, action: action.name, missing: missing.map((p) => p.name) }, 'action missing required arguments — dropped');
      return;
    }
    try {
      const invocation = await this.invocations.insert({
        conversationId: conversation.id,
        agentId: agent.id,
        actionName: definition.name,
        turnId,
        arguments: action.arguments,
      });
      if (!invocation) {
        return;
      }
      await this.webhooks.emit(
        WebhookEvent.ACTION_INVOKED,
        {
          invocationId: invocation.id,
          action: definition.name,
          arguments: action.arguments,
          conversationId: conversation.id,
          externalUserId: conversation.externalUserId,
          scope: conversation.scope,
          agent: { id: agent.id, slug: agent.slug },
        },
        invocation.id,
      );
      this.log.info({ conversationId: conversation.id, action: definition.name }, 'action invoked');
    } catch (error) {
      this.log.error({ conversationId: conversation.id, action: action.name, error: describeError(error) }, 'action invocation failed');
    }
  }
}

import { Injectable } from '@nestjs/common';
import { buildGreetingTurnId } from '../../../shared/contracts/generation.contract';
import { Conversation } from '../../../shared/database/entities';
import { ChipsSource } from '../../../shared/domain/agent-settings';
import { MessageKind, MessageSenderType } from '../../../shared/domain/enums';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { RuntimeAgent } from '../../agents/agent-runtime.service';
import { MessageRepository } from '../repositories/message.repository';
import { sanitizeChips, SuggestedChip } from '../serializers/message.serializer';
import { AGENT_LIMITS } from '../../../shared/domain/agent-settings';

export interface TemplateVariables {
  userName: string | null;
  agentName: string;
  contextTitle: string | null;
}

/**
 * Fills {{user.name}}, {{agent.name}} and {{context.title}}. A missing value
 * removes the placeholder and tidies the punctuation it leaves behind —
 * "Hi {{user.name}}!" becomes "Hi!" rather than "Hi !" — because many
 * conversations have no user name.
 */
export const renderTemplate = (template: string, variables: TemplateVariables): string => {
  const values: Record<string, string | null> = {
    'user.name': variables.userName?.trim() || null,
    'agent.name': variables.agentName,
    'context.title': variables.contextTitle?.trim() || null,
  };
  const rendered = template.replace(/\{\{\s*([a-z.]+)\s*\}\}/g, (match, key: string) => (key in values ? (values[key] ?? '\u0000') : match));
  const tidy = rendered
    .replace(/[ \t]*\u0000[ \t]*,?/g, '')
    .replace(/[ \t]+([!?.,])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
};

/**
 * The opening message. TEMPLATE greetings are written and revealed instantly
 * so they ride in the session-start response; LLM greetings are dispatched by
 * the session service and arrive over the socket.
 */
@Injectable()
export class GreetingService {
  private readonly log = getLogger(GreetingService.name);

  constructor(private readonly messages: MessageRepository) {}

  /** Never throws — a greeting is decoration on a session that already exists. */
  async persistTemplateGreeting(conversation: Conversation, agent: RuntimeAgent, agentDisplayName: string): Promise<void> {
    try {
      const body = renderTemplate(agent.settings.greeting.template, {
        userName: conversation.userName,
        agentName: agentDisplayName,
        contextTitle: (conversation.context?.title as string | undefined) ?? null,
      });
      if (!body) {
        return;
      }
      const { rows, inserted } = await this.messages.insertAgentParts(
        conversation.id,
        buildGreetingTurnId(conversation.id),
        null,
        MessageSenderType.AGENT,
        [{ partIndex: 0, kind: MessageKind.GREETING, body, revealAt: new Date(), meta: { template: true } }],
      );
      if (inserted) {
        // Revealed in the same request, so it is in the session-start response.
        // If this write is lost, the overdue-part sweep reveals it.
        await Promise.all(rows.map((row) => this.messages.markPartSent(row.id, new Date())));
      }
    } catch (error) {
      this.log.error({ conversationId: conversation.id, error: describeError(error) }, 'greeting failed — conversation opens without it');
    }
  }

  /** The suggestions a conversation offers: generated ones pinned on it, else the agent's static list. */
  resolveChips(conversation: Conversation, agent: RuntimeAgent): SuggestedChip[] {
    const { source, items, count } = agent.settings.chips;
    if (source === ChipsSource.NONE) {
      return [];
    }
    if (source === ChipsSource.LLM) {
      const generated = sanitizeChips(conversation.suggestedChips, count, AGENT_LIMITS.maxChipChars);
      if (generated.length > 0) {
        return generated;
      }
    }
    return sanitizeChips(items, count, AGENT_LIMITS.maxChipChars);
  }
}

import { LlmProviderKind } from '../../../shared/domain/enums';
import { LlmClient, LlmGenerateRequest, LlmGenerateResult, LlmRole, LlmSafetyError } from '../llm-client';
import { normaliseParts } from '../structured-reply';

/** Typing `#action:<name> key=value ...` makes the mock trigger that action. */
const ACTION_DIRECTIVE = /#action:([a-z][a-z0-9_]*)((?:\s+[A-Za-z][A-Za-z0-9_]*=\S+)*)/;

/**
 * Deterministic, free, offline replies for smoke tests, CI and trying the
 * platform without an API key. It is a provider an operator adds on purpose
 * from the dashboard — never a silent default.
 *
 * Behaviour, so tests can drive every path:
 *   - echoes the user's turn back as one or two parts
 *   - `#fail` raises a refusal, exercising turn.failed
 *   - `#slow` waits two seconds before answering
 *   - `#action:<name> key=value` triggers an action the agent offers
 */
export class MockLlmClient implements LlmClient {
  readonly kind = LlmProviderKind.MOCK;

  async generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const lastUser = [...request.conversation].reverse().find((message) => message.role === LlmRole.USER)?.content ?? '';

    if (lastUser.includes('#fail')) {
      throw new LlmSafetyError('mock provider refused on #fail');
    }
    if (lastUser.includes('#slow')) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const isSystemTurn = lastUser.startsWith('[');
    const parts = isSystemTurn
      ? [lastUser.includes('ended') ? 'Thanks for the chat — goodbye! (mock)' : 'Hello! How can I help you today? (mock)']
      : [`You said: ${lastUser}`, 'This is the mock provider — add a real LLM provider in the dashboard for real answers.'];

    return {
      parts: normaliseParts(parts, request.output),
      ...(request.output.chipCount && {
        chips: Array.from({ length: request.output.chipCount }, (_, index) => `Suggested question ${index + 1}`),
      }),
      action: this.parseAction(lastUser, request),
      model: request.model || 'mock-1',
      inputTokens: Math.ceil((request.systemPrompt.length + lastUser.length) / 4),
      outputTokens: Math.ceil(parts.join(' ').length / 4),
    };
  }

  private parseAction(text: string, request: LlmGenerateRequest): LlmGenerateResult['action'] {
    const match = ACTION_DIRECTIVE.exec(text);
    const definition = match && request.output.actions.find((action) => action.name === match[1]);
    if (!match || !definition) {
      return null;
    }
    const args: Record<string, string> = {};
    for (const pair of match[2].trim().split(/\s+/).filter(Boolean)) {
      const [key, ...rest] = pair.split('=');
      if (definition.parameterNames.includes(key)) {
        args[key] = rest.join('=');
      }
    }
    return { name: definition.name, arguments: args };
  }
}

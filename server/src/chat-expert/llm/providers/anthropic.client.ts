import Anthropic from '@anthropic-ai/sdk';
import { LlmProviderKind } from '../../../shared/domain/enums';
import {
  LlmClient,
  LlmConfigurationError,
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmMalformedError,
  LlmProviderError,
  LlmSafetyError,
  LlmTimeoutError,
} from '../llm-client';
import { buildReplyJsonSchema, parseStructuredReply } from '../structured-reply';

export interface AnthropicClientOptions {
  apiKey: string | null;
  baseUrl: string | null;
  /** Re-run a declined request on a fallback model server-side. Default on. */
  refusalFallback: boolean;
}

/**
 * Current Claude models think adaptively and spend part of `max_tokens` doing
 * so; a chat-sized cap would truncate the reply. The agent's maxOutputTokens
 * still bounds the visible answer through the reply-length rules.
 */
const MIN_CLAUDE_MAX_TOKENS = 16000;

const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Claude through the official Anthropic SDK, with structured outputs
 * (`output_config.format`) constraining the reply to the shared JSON schema.
 *
 * Sampling parameters are never sent: current Claude models reject them.
 * Depth is tuned with `output_config.effort` from the agent's reasoning
 * effort setting. With refusalFallback on (the default) requests go through
 * the beta endpoint with server-side fallbacks, so a safety decline is retried
 * on a fallback model inside the same call; the final `stop_reason` is still
 * checked, because the fallback can decline too.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly kind = LlmProviderKind.ANTHROPIC;
  private readonly client: Anthropic;
  private readonly useFallbacks: boolean;

  constructor(options: AnthropicClientOptions) {
    if (!options.apiKey) {
      throw new LlmConfigurationError('Anthropic provider has no API key');
    }
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseUrl ?? undefined, maxRetries: 0 });
    // Server-side fallbacks exist on the Claude API itself, not behind proxies.
    this.useFallbacks = options.refusalFallback && !options.baseUrl;
  }

  async generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const params = {
      model: request.model,
      max_tokens: Math.max(request.maxOutputTokens, MIN_CLAUDE_MAX_TOKENS),
      system: request.systemPrompt,
      messages: request.conversation.map((message) => ({ role: message.role, content: message.content })),
      output_config: {
        format: { type: 'json_schema' as const, schema: buildReplyJsonSchema(request.output) },
        ...(request.reasoningEffort && { effort: request.reasoningEffort }),
      },
    };

    let response: { content: Array<{ type: string; text?: string }>; stop_reason: string | null; model: string; usage: { input_tokens: number; output_tokens: number } };
    try {
      response = this.useFallbacks
        ? await this.client.beta.messages.create(
            { ...params, betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: 'default' },
            { timeout: request.timeoutMs },
          )
        : await this.client.messages.create(params, { timeout: request.timeoutMs });
    } catch (error) {
      throw this.mapError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new LlmSafetyError('Claude declined to answer this request');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new LlmMalformedError('the reply was cut off at max_tokens');
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const reply = parseStructuredReply(text, request.output);
    return {
      ...reply,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new LlmTimeoutError();
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new LlmConfigurationError(`Anthropic rejected the credentials: ${error.message}`);
    }
    if (error instanceof Anthropic.NotFoundError) {
      return new LlmConfigurationError(`model not found: ${error.message}`);
    }
    if (error instanceof Anthropic.BadRequestError) {
      return new LlmProviderError(`request rejected: ${error.message}`, false);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new LlmProviderError(`rate limited: ${error.message}`, true);
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new LlmProviderError(`could not reach Anthropic: ${error.message}`, true);
    }
    if (error instanceof Anthropic.APIError) {
      return new LlmProviderError(`Anthropic error ${error.status ?? ''}: ${error.message}`, true);
    }
    return error instanceof Error ? error : new LlmProviderError(String(error));
  }
}

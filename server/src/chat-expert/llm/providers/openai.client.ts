import OpenAI from 'openai';
import { LlmProviderKind } from '../../../shared/domain/enums';
import {
  LlmClient,
  LlmConfigurationError,
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProviderError,
  LlmSafetyError,
  LlmTimeoutError,
} from '../llm-client';
import { buildReplyJsonSchema, parseStructuredReply } from '../structured-reply';

export interface OpenAiClientOptions {
  kind: LlmProviderKind.OPENAI | LlmProviderKind.OPENAI_COMPATIBLE;
  apiKey: string | null;
  baseUrl: string | null;
  organization?: string;
  headers?: Record<string, string>;
}

/**
 * OpenAI Chat Completions, and every server that speaks the same API:
 * Ollama, vLLM, LM Studio, Azure OpenAI deployments and LLM gateways.
 *
 * Differences handled here: OpenAI itself gets strict schema decoding and
 * `max_completion_tokens`; compatible servers get a non-strict schema and
 * `max_tokens`, which is what they implement. Optional knobs (temperature,
 * reasoning effort) are sent only when the agent sets them, because some
 * models reject them outright.
 */
export class OpenAiLlmClient implements LlmClient {
  readonly kind: LlmProviderKind;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiClientOptions) {
    this.kind = options.kind;
    if (options.kind === LlmProviderKind.OPENAI && !options.apiKey) {
      throw new LlmConfigurationError('OpenAI provider has no API key');
    }
    if (options.kind === LlmProviderKind.OPENAI_COMPATIBLE && !options.baseUrl) {
      throw new LlmConfigurationError('OpenAI-compatible provider has no base URL');
    }
    this.client = new OpenAI({
      // Local servers ignore the key, but the SDK requires a non-empty value.
      apiKey: options.apiKey || 'not-required',
      baseURL: options.baseUrl ?? undefined,
      organization: options.organization,
      defaultHeaders: options.headers,
      // The worker owns retries; SDK retries would silently stack on top.
      maxRetries: 0,
    });
  }

  async generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const isOpenAi = this.kind === LlmProviderKind.OPENAI;
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            ...request.conversation.map((message) => ({ role: message.role, content: message.content })),
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'chat_reply', strict: isOpenAi, schema: buildReplyJsonSchema(request.output) },
          },
          ...(isOpenAi ? { max_completion_tokens: request.maxOutputTokens } : { max_tokens: request.maxOutputTokens }),
          ...(request.temperature !== null && { temperature: request.temperature }),
          ...(request.reasoningEffort && { reasoning_effort: request.reasoningEffort }),
        },
        { timeout: request.timeoutMs },
      );
    } catch (error) {
      throw this.mapError(error);
    }

    const choice = completion.choices[0];
    if (choice?.message?.refusal) {
      throw new LlmSafetyError(`model refused: ${choice.message.refusal.slice(0, 200)}`);
    }
    if (choice?.finish_reason === 'content_filter') {
      throw new LlmSafetyError('reply blocked by the provider content filter');
    }

    const reply = parseStructuredReply(choice?.message?.content ?? '', request.output);
    return {
      ...reply,
      model: completion.model || request.model,
      inputTokens: completion.usage?.prompt_tokens,
      outputTokens: completion.usage?.completion_tokens,
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      return new LlmTimeoutError();
    }
    if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
      return new LlmConfigurationError(`provider rejected the credentials: ${error.message}`);
    }
    if (error instanceof OpenAI.NotFoundError) {
      return new LlmConfigurationError(`model or endpoint not found: ${error.message}`);
    }
    if (error instanceof OpenAI.RateLimitError) {
      return new LlmProviderError(`rate limited: ${error.message}`, true);
    }
    if (error instanceof OpenAI.BadRequestError) {
      return new LlmProviderError(`request rejected: ${error.message}`, false);
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new LlmProviderError(`could not reach the provider: ${error.message}`, true);
    }
    if (error instanceof OpenAI.APIError) {
      return new LlmProviderError(`provider error ${error.status ?? ''}: ${error.message}`, true);
    }
    return error instanceof Error ? error : new LlmProviderError(String(error));
  }
}

import { ApiError, GoogleGenAI } from '@google/genai';
import { LlmProviderKind } from '../../../shared/domain/enums';
import {
  LlmClient,
  LlmConfigurationError,
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmMalformedError,
  LlmProviderError,
  LlmRole,
  LlmSafetyError,
  LlmTimeoutError,
} from '../llm-client';
import { buildReplyJsonSchema, parseStructuredReply } from '../structured-reply';

export type GeminiClientOptions =
  | { kind: LlmProviderKind.GEMINI; apiKey: string | null }
  | { kind: LlmProviderKind.VERTEX_AI; serviceAccountJson: string | null; location: string };

const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

/**
 * Gemini, through a Google AI Studio API key or Vertex AI with a
 * service-account JSON. One client per provider row for the process lifetime;
 * constructing one per call would redo authentication every time.
 */
export class GeminiLlmClient implements LlmClient {
  readonly kind: LlmProviderKind;
  private readonly client: GoogleGenAI;

  constructor(options: GeminiClientOptions) {
    this.kind = options.kind;
    if (options.kind === LlmProviderKind.GEMINI) {
      if (!options.apiKey) {
        throw new LlmConfigurationError('Gemini provider has no API key');
      }
      this.client = new GoogleGenAI({ apiKey: options.apiKey });
      return;
    }
    if (!options.serviceAccountJson) {
      throw new LlmConfigurationError('Vertex AI provider has no service-account JSON');
    }
    let credentials: { project_id?: string };
    try {
      credentials = JSON.parse(options.serviceAccountJson);
    } catch {
      throw new LlmConfigurationError('Vertex AI service-account JSON is not valid JSON');
    }
    if (!credentials.project_id) {
      throw new LlmConfigurationError('Vertex AI service-account JSON has no project_id');
    }
    this.client = new GoogleGenAI({
      vertexai: true,
      project: credentials.project_id,
      location: options.location,
      googleAuthOptions: { credentials },
    });
  }

  async generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
    let response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;
    try {
      response = await this.client.models.generateContent({
        model: request.model,
        contents: request.conversation.map((message) => ({
          role: message.role === LlmRole.USER ? 'user' : 'model',
          parts: [{ text: message.content }],
        })),
        config: {
          systemInstruction: request.systemPrompt,
          responseMimeType: 'application/json',
          responseJsonSchema: buildReplyJsonSchema(request.output),
          maxOutputTokens: request.maxOutputTokens,
          ...(request.temperature !== null && { temperature: request.temperature }),
          httpOptions: { timeout: request.timeoutMs },
        },
      });
    } catch (error) {
      throw this.mapError(error);
    }

    if (response.promptFeedback?.blockReason) {
      throw new LlmSafetyError(`prompt blocked: ${response.promptFeedback.blockReason}`);
    }
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && BLOCKED_FINISH_REASONS.has(String(finishReason))) {
      throw new LlmSafetyError(`reply blocked: ${finishReason}`);
    }
    if (String(finishReason) === 'MAX_TOKENS') {
      throw new LlmMalformedError('the reply was cut off at maxOutputTokens');
    }

    const reply = parseStructuredReply(response.text ?? '', request.output);
    return {
      ...reply,
      model: response.modelVersion || request.model,
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        return new LlmConfigurationError(`Google rejected the credentials: ${error.message}`);
      }
      if (error.status === 404) {
        return new LlmConfigurationError(`model not found: ${error.message}`);
      }
      if (error.status === 400) {
        return new LlmProviderError(`request rejected: ${error.message}`, false);
      }
      return new LlmProviderError(`Gemini error ${error.status}: ${error.message}`, true);
    }
    // The SDK aborts on its own timeout without the word "timeout" in every message.
    if (error instanceof Error && (error.name === 'AbortError' || /abort|timed? ?out/i.test(error.message))) {
      return new LlmTimeoutError();
    }
    return error instanceof Error ? new LlmProviderError(error.message) : new LlmProviderError(String(error));
  }
}

import { LlmProviderKind } from '../../shared/domain/enums';

/**
 * The provider-agnostic model port. Vendor SDKs are imported only by the
 * adapters in this folder; everything else talks to LlmClient.
 */

export enum LlmRole {
  USER = 'user',
  ASSISTANT = 'assistant',
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface ActionSpec {
  name: string;
  parameterNames: string[];
}

/** What the structured output must contain. Adapters turn this into their schema format. */
export interface OutputSpec {
  maxParts: number;
  maxPartChars: number;
  /** Set on greeting turns that also generate suggestions. */
  chipCount?: number;
  maxChipChars: number;
  /** Empty means the schema has no action field at all. */
  actions: ActionSpec[];
}

export interface LlmGenerateRequest {
  model: string;
  systemPrompt: string;
  conversation: LlmMessage[];
  output: OutputSpec;
  temperature: number | null;
  maxOutputTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
  timeoutMs: number;
}

export interface LlmGenerateResult {
  parts: string[];
  chips?: string[];
  action?: { name: string; arguments: Record<string, string> } | null;
  /** The model that actually answered (a fallback may differ from the one requested). */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmClient {
  readonly kind: LlmProviderKind;
  generate(request: LlmGenerateRequest): Promise<LlmGenerateResult>;
}

/** Failure taxonomy every adapter maps its vendor errors onto. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class LlmTimeoutError extends LlmError {
  constructor(message = 'model call timed out') {
    super(message, true);
  }
}

export class LlmProviderError extends LlmError {
  constructor(message: string, retryable = true) {
    super(message, retryable);
  }
}

/** The model or a safety system declined. Retrying the same request will decline again. */
export class LlmSafetyError extends LlmError {
  constructor(message = 'the model declined to answer') {
    super(message, false);
  }
}

export class LlmMalformedError extends LlmError {
  constructor(message = 'the model returned an unusable reply') {
    super(message, true);
  }
}

/** Missing credentials, unknown model, disabled provider. An operator has to act. */
export class LlmConfigurationError extends LlmError {
  constructor(message: string) {
    super(message, false);
  }
}

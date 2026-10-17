import { Injectable } from '@nestjs/common';
import { config } from '../../shared/config/config';
import { LlmProvider } from '../../shared/database/entities';
import { LlmProviderKind, RecordStatus } from '../../shared/domain/enums';
import { decryptSecret, parseEncryptionKey } from '../../shared/security/crypto';
import { LlmClient, LlmConfigurationError } from './llm-client';
import { AnthropicLlmClient } from './providers/anthropic.client';
import { GeminiLlmClient } from './providers/gemini.client';
import { MockLlmClient } from './providers/mock.client';
import { OpenAiLlmClient } from './providers/openai.client';

const DEFAULT_VERTEX_LOCATION = 'global';

/**
 * Builds one LlmClient per provider row and keeps it for the row's revision:
 * an edit in the dashboard bumps the revision, and the next request builds a
 * fresh client with the new key or URL. Credentials are decrypted here and
 * nowhere else in chat-expert.
 */
@Injectable()
export class LlmClientFactory {
  private readonly clients = new Map<string, { revision: number; client: LlmClient }>();
  private readonly encryptionKey = config.ENCRYPTION_KEY ? parseEncryptionKey(config.ENCRYPTION_KEY) : null;

  clientFor(provider: LlmProvider): LlmClient {
    if (provider.status !== RecordStatus.ACTIVE) {
      throw new LlmConfigurationError(`LLM provider "${provider.name}" is disabled`);
    }
    const cached = this.clients.get(provider.id);
    if (cached && cached.revision === provider.revision) {
      return cached.client;
    }
    const client = this.build(provider);
    this.clients.set(provider.id, { revision: provider.revision, client });
    return client;
  }

  /** Builds a client without caching it — the dashboard's connection test. */
  buildUncached(provider: LlmProvider): LlmClient {
    return this.build(provider);
  }

  private build(provider: LlmProvider): LlmClient {
    const secret = this.decrypt(provider);
    const settings = provider.settings ?? {};
    switch (provider.kind) {
      case LlmProviderKind.OPENAI:
      case LlmProviderKind.OPENAI_COMPATIBLE:
        return new OpenAiLlmClient({
          kind: provider.kind,
          apiKey: secret,
          baseUrl: provider.baseUrl,
          organization: settings.organization,
          headers: settings.headers,
        });
      case LlmProviderKind.ANTHROPIC:
        return new AnthropicLlmClient({
          apiKey: secret,
          baseUrl: provider.baseUrl,
          refusalFallback: settings.refusalFallback !== false,
        });
      case LlmProviderKind.GEMINI:
        return new GeminiLlmClient({ kind: LlmProviderKind.GEMINI, apiKey: secret });
      case LlmProviderKind.VERTEX_AI:
        return new GeminiLlmClient({
          kind: LlmProviderKind.VERTEX_AI,
          serviceAccountJson: secret,
          location: settings.location || DEFAULT_VERTEX_LOCATION,
        });
      case LlmProviderKind.MOCK:
        return new MockLlmClient();
      default:
        throw new LlmConfigurationError(`unsupported provider kind: ${String(provider.kind)}`);
    }
  }

  private decrypt(provider: LlmProvider): string | null {
    if (!provider.encryptedCredentials) {
      return null;
    }
    if (!this.encryptionKey) {
      throw new LlmConfigurationError('ENCRYPTION_KEY is not set, so stored provider credentials cannot be read');
    }
    try {
      return decryptSecret(provider.encryptedCredentials, this.encryptionKey);
    } catch {
      throw new LlmConfigurationError(
        `credentials for provider "${provider.name}" cannot be decrypted — was ENCRYPTION_KEY changed?`,
      );
    }
  }
}

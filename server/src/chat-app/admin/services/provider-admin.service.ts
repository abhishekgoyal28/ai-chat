import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../../../shared/config/config';
import { GenerationKind, PreviewResponse } from '../../../shared/contracts/generation.contract';
import { LlmProvider } from '../../../shared/database/entities';
import { ConfigResourceType, LlmProviderKind } from '../../../shared/domain/enums';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors/app-errors';
import { decryptSecret, encryptSecret, maskSecret, parseEncryptionKey } from '../../../shared/security/crypto';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { providerInputSchema, providerUpdateSchema } from '../admin.schemas';
import { AgentAdminRepository, ProviderRepository } from '../repositories/config.repositories';
import { PreviewService } from './preview.service';
import { RevisionRecorder } from './revision-recorder.service';

type ProviderInput = z.infer<typeof providerInputSchema>;

export interface ProviderView {
  id: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string | null;
  defaultModel: string | null;
  settings: LlmProvider['settings'];
  status: string;
  revision: number;
  /** Never the secret itself. */
  credentialsSet: boolean;
  credentialsHint: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Which kinds need what — used to give a precise validation message. */
const REQUIRES_CREDENTIALS = new Set([LlmProviderKind.OPENAI, LlmProviderKind.ANTHROPIC, LlmProviderKind.GEMINI, LlmProviderKind.VERTEX_AI]);
const REQUIRES_BASE_URL = new Set([LlmProviderKind.OPENAI_COMPATIBLE]);

/**
 * LLM providers. Credentials are write-only: sealed with ENCRYPTION_KEY on
 * the way in and never returned — the dashboard sees whether a key is set
 * and a masked hint, so an operator can tell keys apart.
 */
@Injectable()
export class ProviderAdminService {
  private readonly encryptionKey = config.ENCRYPTION_KEY ? parseEncryptionKey(config.ENCRYPTION_KEY) : null;

  constructor(
    private readonly providers: ProviderRepository,
    private readonly agents: AgentAdminRepository,
    private readonly preview: PreviewService,
    private readonly revisions: RevisionRecorder,
  ) {}

  async list(): Promise<ProviderView[]> {
    return (await this.providers.list()).map((provider) => this.toView(provider));
  }

  async get(id: string): Promise<ProviderView> {
    return this.toView(await this.require(id));
  }

  async create(input: ProviderInput, by: AdminPrincipal): Promise<ProviderView> {
    this.validate(input.kind, input.credentials ?? null, input.baseUrl ?? null);
    const provider = await this.providers.create({
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl ?? null,
      encryptedCredentials: input.credentials ? this.seal(input.credentials) : null,
      defaultModel: input.defaultModel ?? null,
      settings: input.settings,
      status: input.status,
    });
    await this.record(provider, by);
    return this.toView(provider);
  }

  async update(id: string, input: z.infer<typeof providerUpdateSchema>, by: AdminPrincipal): Promise<ProviderView> {
    const existing = await this.require(id);
    const encryptedCredentials =
      input.credentials === undefined ? existing.encryptedCredentials : input.credentials ? this.seal(input.credentials) : null;
    this.validate(input.kind, encryptedCredentials, input.baseUrl ?? null);
    await this.providers.update(id, input.expectedRevision, {
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl ?? null,
      encryptedCredentials,
      defaultModel: input.defaultModel ?? null,
      settings: input.settings,
      status: input.status,
    });
    const provider = await this.require(id);
    await this.record(provider, by);
    return this.toView(provider);
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    const users = await this.agents.findReferencing('providerId', id);
    if (users.length > 0) {
      throw new ConflictError(`still routed to by: ${users.map((agent) => agent.name).join(', ')}`);
    }
    await this.providers.delete(id);
  }

  /** One real model call through chat-expert with the saved credentials. */
  async test(id: string, model: string | undefined): Promise<PreviewResponse> {
    const provider = await this.require(id);
    const chosenModel = model || provider.defaultModel;
    if (!chosenModel) {
      throw new ValidationError('choose a model to test with, or set a default model on the provider');
    }
    return this.preview.run({
      kind: GenerationKind.REPLY,
      agent: {
        agentId: null,
        name: 'Connection test',
        settings: { greeting: { mode: 'NONE' }, reply: { maxParts: 1 } },
        personaPrompt: 'You are a connection test. Answer in at most five words.',
        personaName: 'Test',
        domainPromptText: null,
        masterPromptText: null,
        route: { providerId: provider.id, model: chosenModel },
      },
      history: [],
      userMessage: 'Reply with: connection works',
      user: { externalUserId: 'dashboard-test' },
    });
  }

  private validate(kind: LlmProviderKind, credentials: string | null, baseUrl: string | null): void {
    if (REQUIRES_CREDENTIALS.has(kind) && !credentials) {
      throw new ValidationError(kind === LlmProviderKind.VERTEX_AI ? 'paste the service-account JSON' : 'an API key is required for this provider');
    }
    if (REQUIRES_BASE_URL.has(kind) && !baseUrl) {
      throw new ValidationError('a base URL is required, e.g. http://ollama:11434/v1');
    }
  }

  private toView(provider: LlmProvider): ProviderView {
    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      settings: provider.settings ?? {},
      status: provider.status,
      revision: provider.revision,
      credentialsSet: Boolean(provider.encryptedCredentials),
      credentialsHint: this.hint(provider),
      createdAt: provider.createdAt.toISOString(),
      updatedAt: provider.updatedAt.toISOString(),
    };
  }

  /** "sk-a••••9xYz" for keys, the client email for a service account. */
  private hint(provider: LlmProvider): string | null {
    if (!provider.encryptedCredentials || !this.encryptionKey) {
      return null;
    }
    try {
      const secret = decryptSecret(provider.encryptedCredentials, this.encryptionKey);
      if (provider.kind === LlmProviderKind.VERTEX_AI) {
        return (JSON.parse(secret) as { client_email?: string }).client_email ?? 'service account';
      }
      return maskSecret(secret);
    } catch {
      return 'unreadable — re-enter the credentials';
    }
  }

  private seal(secret: string): string {
    if (!this.encryptionKey) {
      throw new ValidationError('ENCRYPTION_KEY is not configured on the server');
    }
    return encryptSecret(secret.trim(), this.encryptionKey);
  }

  private record(provider: LlmProvider, by: AdminPrincipal): Promise<void> {
    return this.revisions.record(
      ConfigResourceType.LLM_PROVIDER,
      provider.id,
      provider.revision,
      { name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, defaultModel: provider.defaultModel, settings: provider.settings, status: provider.status },
      by,
    );
  }

  private async require(id: string): Promise<LlmProvider> {
    const provider = await this.providers.findById(id);
    if (!provider) {
      throw new NotFoundError('LLM provider');
    }
    return provider;
  }
}

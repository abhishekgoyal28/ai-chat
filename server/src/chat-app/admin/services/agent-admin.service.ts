import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Agent } from '../../../shared/database/entities';
import { readStoredAgentSettings } from '../../../shared/domain/agent-settings';
import { ConfigResourceType, PromptKind } from '../../../shared/domain/enums';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors/app-errors';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { assertCanModify } from '../../auth/resource-ownership';
import { ConversationRepository } from '../../conversation/repositories/conversation.repository';
import { agentInputSchema, agentUpdateSchema } from '../admin.schemas';
import { AgentAdminRepository, KnowledgeRepository, PersonaRepository, PromptRepository, ProviderRepository } from '../repositories/config.repositories';
import { RevisionRecorder } from './revision-recorder.service';

export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentUpdate = z.infer<typeof agentUpdateSchema>;

export interface AgentView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  personaId: string;
  domainPromptId: string | null;
  modelRoutes: Agent['modelRoutes'];
  settings: Agent['settings'];
  createdById: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

const toView = (agent: Agent): AgentView => ({
  id: agent.id,
  slug: agent.slug,
  name: agent.name,
  description: agent.description,
  status: agent.status,
  personaId: agent.personaId,
  domainPromptId: agent.domainPromptId,
  modelRoutes: agent.modelRoutes ?? [],
  settings: readStoredAgentSettings(agent.settings),
  createdById: agent.createdById,
  revision: agent.revision,
  createdAt: agent.createdAt.toISOString(),
  updatedAt: agent.updatedAt.toISOString(),
});

@Injectable()
export class AgentAdminService {
  constructor(
    private readonly agents: AgentAdminRepository,
    private readonly personas: PersonaRepository,
    private readonly prompts: PromptRepository,
    private readonly providers: ProviderRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly conversations: ConversationRepository,
    private readonly runtime: AgentRuntimeService,
    private readonly revisions: RevisionRecorder,
  ) {}

  async list(): Promise<AgentView[]> {
    return (await this.agents.list()).map(toView);
  }

  async get(id: string): Promise<AgentView> {
    return toView(await this.require(id));
  }

  async create(input: AgentInput, by: AdminPrincipal): Promise<AgentView> {
    await this.validateReferences(input);
    const agent = await this.agents.create({
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      personaId: input.personaId,
      domainPromptId: input.domainPromptId,
      modelRoutes: input.modelRoutes,
      settings: input.settings,
      createdById: by.id,
    });
    await this.afterWrite(agent, by);
    return toView(agent);
  }

  async update(id: string, input: AgentUpdate, by: AdminPrincipal): Promise<AgentView> {
    assertCanModify(by, await this.require(id));
    await this.validateReferences(input);
    await this.agents.update(id, input.expectedRevision, {
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      personaId: input.personaId,
      domainPromptId: input.domainPromptId,
      modelRoutes: input.modelRoutes,
      settings: input.settings,
    });
    const agent = await this.require(id);
    await this.afterWrite(agent, by);
    return toView(agent);
  }

  /** Only an agent with no conversations can be deleted; otherwise disable it. */
  async delete(id: string, by: AdminPrincipal): Promise<void> {
    assertCanModify(by, await this.require(id));
    if ((await this.conversations.list({ agentId: id, limit: 1 })).rows.length > 0) {
      throw new ConflictError('this agent has conversations — disable it instead of deleting it');
    }
    await this.agents.delete(id);
    this.runtime.invalidate();
  }

  async restore(id: string, snapshot: Record<string, unknown>, by: AdminPrincipal): Promise<AgentView> {
    const current = await this.require(id);
    const parsed = agentInputSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new ValidationError('this revision can no longer be restored as-is');
    }
    return this.update(id, { ...parsed.data, expectedRevision: current.revision }, by);
  }

  private async afterWrite(agent: Agent, by: AdminPrincipal): Promise<void> {
    const view = toView(agent);
    const snapshot: AgentInput = {
      slug: view.slug,
      name: view.name,
      description: view.description,
      status: agent.status,
      personaId: view.personaId,
      domainPromptId: view.domainPromptId,
      modelRoutes: view.modelRoutes,
      settings: view.settings,
    };
    await this.revisions.record(ConfigResourceType.AGENT, agent.id, agent.revision, snapshot as unknown as Record<string, unknown>, by);
    this.runtime.invalidate();
  }

  /** References are plain ids (no foreign keys), so they are checked here, with messages a form can show. */
  private async validateReferences(input: AgentInput): Promise<void> {
    const issues: Record<string, string> = {};
    const [persona, domainPrompt, providers, bases] = await Promise.all([
      this.personas.findById(input.personaId),
      input.domainPromptId ? this.prompts.findById(input.domainPromptId) : Promise.resolve(null),
      this.providers.findByIds([...new Set(input.modelRoutes.map((route) => route.providerId))]),
      this.knowledge.findBasesByIds(input.settings.knowledge.knowledgeBaseIds),
    ]);
    if (!persona) {
      issues.personaId = 'persona not found';
    }
    if (input.domainPromptId && (!domainPrompt || domainPrompt.kind !== PromptKind.DOMAIN)) {
      issues.domainPromptId = 'domain prompt not found';
    }
    const providerIds = new Set(providers.map((provider) => provider.id));
    input.modelRoutes.forEach((route, index) => {
      if (!providerIds.has(route.providerId)) {
        issues[`modelRoutes.${index}.providerId`] = 'LLM provider not found';
      }
    });
    if (bases.length !== new Set(input.settings.knowledge.knowledgeBaseIds).size) {
      issues['settings.knowledge.knowledgeBaseIds'] = 'a knowledge base was not found';
    }
    const actionNames = input.settings.actions.map((action) => action.name);
    if (new Set(actionNames).size !== actionNames.length) {
      issues['settings.actions'] = 'action names must be unique';
    }
    if (Object.keys(issues).length > 0) {
      throw new ValidationError(Object.values(issues)[0], { issues });
    }
  }

  private async require(id: string): Promise<Agent> {
    const agent = await this.agents.findById(id);
    if (!agent) {
      throw new NotFoundError('agent');
    }
    return agent;
  }
}

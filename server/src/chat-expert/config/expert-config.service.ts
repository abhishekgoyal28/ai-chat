import { Injectable } from '@nestjs/common';
import { config } from '../../shared/config/config';
import { Agent, LlmProvider, Persona, Prompt } from '../../shared/database/entities';
import { AgentSettings, readStoredAgentSettings } from '../../shared/domain/agent-settings';
import { describeError, getLogger } from '../../shared/logger/logger';
import { TtlCache } from '../../shared/utils/ttl-cache';
import { ExpertConfigRepository, KnowledgeDocumentView } from './expert-config.repository';

/** Everything the prompt needs about an agent, resolved and cached. */
export interface ResolvedAgentConfig {
  agent: Pick<Agent, 'id' | 'name' | 'revision' | 'modelRoutes' | 'status'>;
  settings: AgentSettings;
  persona: Pick<Persona, 'displayName' | 'prompt' | 'revision'>;
  domainPrompt: Pick<Prompt, 'text' | 'revision'> | null;
  masterPrompt: Pick<Prompt, 'text' | 'revision'> | null;
  knowledge: KnowledgeDocumentView[];
}

/**
 * Read-through caches over configuration. CONFIG_CACHE_TTL_MS (15s by
 * default) is the propagation delay an operator sees between saving in the
 * dashboard and the next reply using it — short enough to feel live, long
 * enough that a busy conversation does not re-read the agent every turn.
 */
@Injectable()
export class ExpertConfigService {
  private readonly log = getLogger(ExpertConfigService.name);
  private readonly agentCache = new TtlCache<ResolvedAgentConfig>(config.CONFIG_CACHE_TTL_MS);
  private readonly providerCache = new TtlCache<LlmProvider>(config.CONFIG_CACHE_TTL_MS);

  constructor(private readonly repository: ExpertConfigRepository) {}

  resolveAgent(agentId: string): Promise<ResolvedAgentConfig | null> {
    return this.agentCache.get(agentId, () => this.loadAgent(agentId));
  }

  resolveProvider(providerId: string): Promise<LlmProvider | null> {
    return this.providerCache.get(providerId, () => this.repository.findProvider(providerId));
  }

  /** Previews read providers fresh, so "test connection" right after an edit uses the new key. */
  invalidateProvider(providerId: string): void {
    this.providerCache.invalidate(providerId);
  }

  /** The master frame for previews of brand-new agents; null degrades to the built-in default. */
  async resolveMasterPrompt(): Promise<Pick<Prompt, 'text' | 'revision'> | null> {
    try {
      return await this.repository.findMasterPrompt();
    } catch (error) {
      this.log.error({ error: describeError(error) }, 'master prompt lookup failed — using the built-in frame');
      return null;
    }
  }

  async resolveKnowledge(knowledgeBaseIds: string[]): Promise<KnowledgeDocumentView[]> {
    return this.repository.findActiveDocuments(knowledgeBaseIds);
  }

  private async loadAgent(agentId: string): Promise<ResolvedAgentConfig | null> {
    const agent = await this.repository.findAgent(agentId);
    if (!agent) {
      return null;
    }
    const settings = readStoredAgentSettings(agent.settings);
    const [persona, domainPrompt, masterPrompt, knowledge] = await Promise.all([
      this.repository.findPersona(agent.personaId),
      agent.domainPromptId ? this.repository.findPrompt(agent.domainPromptId) : Promise.resolve(null),
      this.resolveMasterPrompt(),
      this.repository.findActiveDocuments(settings.knowledge.knowledgeBaseIds),
    ]);
    if (!persona) {
      this.log.error({ agentId, personaId: agent.personaId }, 'agent references a missing persona');
      return null;
    }
    return {
      agent: { id: agent.id, name: agent.name, revision: agent.revision, modelRoutes: agent.modelRoutes ?? [], status: agent.status },
      settings,
      persona: { displayName: persona.displayName, prompt: persona.prompt, revision: persona.revision },
      domainPrompt: domainPrompt ? { text: domainPrompt.text, revision: domainPrompt.revision } : null,
      masterPrompt: masterPrompt ? { text: masterPrompt.text, revision: masterPrompt.revision } : null,
      knowledge,
    };
  }
}

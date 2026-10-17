import { Injectable } from '@nestjs/common';
import { Agent } from '../../shared/database/entities';
import { AgentSettings, ModelRoute, readStoredAgentSettings } from '../../shared/domain/agent-settings';
import { RecordStatus } from '../../shared/domain/enums';
import { TtlCache } from '../../shared/utils/ttl-cache';
import { AgentRuntimeRepository, PersonaProfile } from './agent-runtime.repository';

export interface RuntimeAgent {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  personaId: string;
  modelRoutes: ModelRoute[];
  settings: AgentSettings;
  revision: number;
}

/** Short enough that a dashboard change reaches every chat-app pod within seconds. */
const AGENT_CACHE_TTL_MS = 5000;

/**
 * Agent configuration for the conversation runtime, parsed and cached. Every
 * consumer and request path reads agents through here, so settings are
 * always parsed one way.
 */
@Injectable()
export class AgentRuntimeService {
  private readonly byId = new TtlCache<RuntimeAgent>(AGENT_CACHE_TTL_MS);
  private readonly bySlug = new TtlCache<RuntimeAgent>(AGENT_CACHE_TTL_MS);
  private readonly personas = new TtlCache<PersonaProfile>(AGENT_CACHE_TTL_MS);

  constructor(private readonly repository: AgentRuntimeRepository) {}

  getById(id: string): Promise<RuntimeAgent | null> {
    return this.byId.get(id, async () => this.toRuntime(await this.repository.findAgentById(id)));
  }

  getBySlug(slug: string): Promise<RuntimeAgent | null> {
    return this.bySlug.get(slug, async () => this.toRuntime(await this.repository.findAgentBySlug(slug)));
  }

  getPersonaProfile(personaId: string): Promise<PersonaProfile | null> {
    return this.personas.get(personaId, () => this.repository.findPersonaProfile(personaId));
  }

  /** Called by the admin services on this pod after a write; other pods catch up within the TTL. */
  invalidate(): void {
    this.byId.invalidate();
    this.bySlug.invalidate();
    this.personas.invalidate();
  }

  private toRuntime(agent: Agent | null): RuntimeAgent | null {
    if (!agent) {
      return null;
    }
    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      active: agent.status === RecordStatus.ACTIVE,
      personaId: agent.personaId,
      modelRoutes: agent.modelRoutes ?? [],
      settings: readStoredAgentSettings(agent.settings),
      revision: agent.revision,
    };
  }
}

/**
 * Weighted pick of a model route for a NEW conversation; the result is pinned
 * on the row so the conversation keeps it. `random` is injectable for tests.
 */
export const pickModelRoute = (routes: ModelRoute[], random: () => number = Math.random): ModelRoute | null => {
  const eligible = routes.filter((route) => route.weight > 0);
  if (eligible.length === 0) {
    return routes[0] ?? null;
  }
  const total = eligible.reduce((sum, route) => sum + route.weight, 0);
  let point = random() * total;
  for (const route of eligible) {
    point -= route.weight;
    if (point < 0) {
      return route;
    }
  }
  return eligible[eligible.length - 1];
};

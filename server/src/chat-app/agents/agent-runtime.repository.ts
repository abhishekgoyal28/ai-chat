import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Agent, Persona } from '../../shared/database/entities';

export type PersonaProfile = Pick<Persona, 'id' | 'displayName' | 'avatarUrl' | 'tagline'>;

/** The agent and persona reads the conversation runtime needs. */
@Injectable()
export class AgentRuntimeRepository {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Persona) private readonly personas: Repository<Persona>,
  ) {}

  findAgentBySlug(slug: string): Promise<Agent | null> {
    return this.agents.findOne({ where: { slug } });
  }

  findAgentById(id: string): Promise<Agent | null> {
    return this.agents.findOne({ where: { id } });
  }

  findPersonaProfile(id: string): Promise<PersonaProfile | null> {
    return this.personas.findOne({ select: ['id', 'displayName', 'avatarUrl', 'tagline'], where: { id } });
  }

  findAgentsByIds(ids: string[]): Promise<Array<Pick<Agent, 'id' | 'slug' | 'name'>>> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.agents.find({ select: ['id', 'slug', 'name'], where: { id: In(ids) } });
  }
}

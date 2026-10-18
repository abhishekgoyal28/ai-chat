import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Persona } from '../../../shared/database/entities';
import { ConfigResourceType } from '../../../shared/domain/enums';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors/app-errors';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { assertCanModify } from '../../auth/resource-ownership';
import { personaInputSchema, personaUpdateSchema } from '../admin.schemas';
import { AgentAdminRepository, PersonaRepository } from '../repositories/config.repositories';
import { RevisionRecorder } from './revision-recorder.service';

type PersonaInput = z.infer<typeof personaInputSchema>;

const snapshotOf = (persona: Persona): PersonaInput => ({
  name: persona.name,
  displayName: persona.displayName,
  avatarUrl: persona.avatarUrl,
  tagline: persona.tagline,
  prompt: persona.prompt,
});

@Injectable()
export class PersonaAdminService {
  constructor(
    private readonly personas: PersonaRepository,
    private readonly agents: AgentAdminRepository,
    private readonly runtime: AgentRuntimeService,
    private readonly revisions: RevisionRecorder,
  ) {}

  list(): Promise<Persona[]> {
    return this.personas.list();
  }

  get(id: string): Promise<Persona> {
    return this.require(id);
  }

  async create(input: PersonaInput, by: AdminPrincipal): Promise<Persona> {
    const persona = await this.personas.create({
      name: input.name,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl ?? null,
      tagline: input.tagline ?? null,
      prompt: input.prompt,
      createdById: by.id,
    });
    await this.revisions.record(ConfigResourceType.PERSONA, persona.id, persona.revision, { ...snapshotOf(persona) }, by);
    return persona;
  }

  async update(id: string, input: z.infer<typeof personaUpdateSchema>, by: AdminPrincipal): Promise<Persona> {
    assertCanModify(by, await this.require(id));
    await this.personas.update(id, input.expectedRevision, {
      name: input.name,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl ?? null,
      tagline: input.tagline ?? null,
      prompt: input.prompt,
    });
    const persona = await this.require(id);
    await this.revisions.record(ConfigResourceType.PERSONA, persona.id, persona.revision, { ...snapshotOf(persona) }, by);
    this.runtime.invalidate();
    return persona;
  }

  async delete(id: string, by: AdminPrincipal): Promise<void> {
    assertCanModify(by, await this.require(id));
    if ((await this.agents.countByPersona(id)) > 0) {
      throw new ConflictError('agents still use this persona — point them at another persona first');
    }
    await this.personas.delete(id);
  }

  async restore(id: string, snapshot: Record<string, unknown>, by: AdminPrincipal): Promise<Persona> {
    const current = await this.require(id);
    const parsed = personaInputSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new ValidationError('this revision can no longer be restored as-is');
    }
    return this.update(id, { ...parsed.data, expectedRevision: current.revision }, by);
  }

  private async require(id: string): Promise<Persona> {
    const persona = await this.personas.findById(id);
    if (!persona) {
      throw new NotFoundError('persona');
    }
    return persona;
  }
}

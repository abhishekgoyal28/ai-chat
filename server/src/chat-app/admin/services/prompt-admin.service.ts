import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prompt } from '../../../shared/database/entities';
import { DEFAULT_MASTER_PROMPT, DEFAULT_MASTER_PROMPT_NAME } from '../../../shared/domain/default-prompts';
import { ConfigResourceType, PromptKind } from '../../../shared/domain/enums';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors/app-errors';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { assertCanModify } from '../../auth/resource-ownership';
import { masterPromptUpdateSchema, promptInputSchema, promptUpdateSchema } from '../admin.schemas';
import { AgentAdminRepository, PromptRepository } from '../repositories/config.repositories';
import { RevisionRecorder } from './revision-recorder.service';

type PromptInput = z.infer<typeof promptInputSchema>;

const snapshotOf = (prompt: Prompt): Record<string, unknown> => ({
  kind: prompt.kind,
  name: prompt.name,
  description: prompt.description,
  text: prompt.text,
});

/** The master prompt (one, platform-wide) and the library of domain prompts. */
@Injectable()
export class PromptAdminService {
  constructor(
    private readonly prompts: PromptRepository,
    private readonly agents: AgentAdminRepository,
    private readonly revisions: RevisionRecorder,
  ) {}

  /** The master always exists: an install whose seed row was deleted gets the default back. */
  async getMaster(): Promise<Prompt & { defaultText: string }> {
    const master =
      (await this.prompts.findMaster()) ??
      (await this.prompts.create({ kind: PromptKind.MASTER, name: DEFAULT_MASTER_PROMPT_NAME, description: null, text: DEFAULT_MASTER_PROMPT, createdById: null }));
    return { ...master, defaultText: DEFAULT_MASTER_PROMPT };
  }

  async updateMaster(input: z.infer<typeof masterPromptUpdateSchema>, by: AdminPrincipal): Promise<Prompt & { defaultText: string }> {
    const master = await this.getMaster();
    assertCanModify(by, master);
    await this.prompts.update(master.id, input.expectedRevision, { text: input.text });
    const updated = await this.require(master.id);
    await this.revisions.record(ConfigResourceType.PROMPT, updated.id, updated.revision, snapshotOf(updated), by);
    return { ...updated, defaultText: DEFAULT_MASTER_PROMPT };
  }

  listDomain(): Promise<Prompt[]> {
    return this.prompts.listByKind(PromptKind.DOMAIN);
  }

  async get(id: string): Promise<Prompt> {
    return this.require(id);
  }

  async createDomain(input: PromptInput, by: AdminPrincipal): Promise<Prompt> {
    const prompt = await this.prompts.create({ kind: PromptKind.DOMAIN, name: input.name, description: input.description ?? null, text: input.text, createdById: by.id });
    await this.revisions.record(ConfigResourceType.PROMPT, prompt.id, prompt.revision, snapshotOf(prompt), by);
    return prompt;
  }

  async updateDomain(id: string, input: z.infer<typeof promptUpdateSchema>, by: AdminPrincipal): Promise<Prompt> {
    assertCanModify(by, await this.requireDomain(id));
    await this.prompts.update(id, input.expectedRevision, { name: input.name, description: input.description ?? null, text: input.text });
    const prompt = await this.require(id);
    await this.revisions.record(ConfigResourceType.PROMPT, prompt.id, prompt.revision, snapshotOf(prompt), by);
    return prompt;
  }

  async deleteDomain(id: string, by: AdminPrincipal): Promise<void> {
    assertCanModify(by, await this.requireDomain(id));
    if ((await this.agents.countByDomainPrompt(id)) > 0) {
      throw new ConflictError('agents still use this domain prompt — detach it from them first');
    }
    await this.prompts.delete(id);
  }

  async restore(id: string, snapshot: Record<string, unknown>, by: AdminPrincipal): Promise<Prompt> {
    const current = await this.require(id);
    const text = typeof snapshot.text === 'string' ? snapshot.text : null;
    if (!text) {
      throw new ValidationError('this revision has no prompt text');
    }
    if (current.kind === PromptKind.MASTER) {
      return this.updateMaster({ text, expectedRevision: current.revision }, by);
    }
    const parsed = promptInputSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new ValidationError('this revision can no longer be restored as-is');
    }
    return this.updateDomain(id, { ...parsed.data, expectedRevision: current.revision }, by);
  }

  private async requireDomain(id: string): Promise<Prompt> {
    const prompt = await this.require(id);
    if (prompt.kind !== PromptKind.DOMAIN) {
      throw new NotFoundError('domain prompt');
    }
    return prompt;
  }

  private async require(id: string): Promise<Prompt> {
    const prompt = await this.prompts.findById(id);
    if (!prompt) {
      throw new NotFoundError('prompt');
    }
    return prompt;
  }
}

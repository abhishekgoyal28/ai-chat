import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { affectedRows, isDuplicateKeyError } from '../../../shared/database/db-errors';
import {
  Agent,
  ConfigRevision,
  KnowledgeBase,
  KnowledgeDocument,
  LlmProvider,
  Persona,
  Prompt,
} from '../../../shared/database/entities';
import { ConfigResourceType, PromptKind } from '../../../shared/domain/enums';
import { ConflictError } from '../../../shared/errors/app-errors';

type Revisioned = { id: string; revision: number };

/**
 * Optimistic concurrency for every editable resource: an update names the
 * revision it was based on, and loses (409) if someone saved in between —
 * two operators editing one prompt never silently overwrite each other.
 */
const updateAtRevision = async <T extends Revisioned>(
  repo: Repository<T>,
  id: string,
  expectedRevision: number,
  values: QueryDeepPartialEntity<T>,
): Promise<void> => {
  const result = await repo
    .createQueryBuilder()
    .update()
    .set({ ...values, revision: () => 'revision + 1' } as QueryDeepPartialEntity<T>)
    .where('id = :id AND revision = :expectedRevision', { id, expectedRevision })
    .execute();
  if (affectedRows(result) === 0) {
    throw new ConflictError('this item was changed by someone else — reload and try again');
  }
};

@Injectable()
export class AgentAdminRepository {
  constructor(@InjectRepository(Agent) private readonly repo: Repository<Agent>) {}

  list(): Promise<Agent[]> {
    return this.repo.find({ order: { id: 'ASC' } });
  }

  findById(id: string): Promise<Agent | null> {
    return this.repo.findOne({ where: { id } });
  }

  async create(values: Omit<Agent, 'id' | 'revision' | 'createdAt' | 'updatedAt'>): Promise<Agent> {
    try {
      return await this.repo.save(this.repo.create({ ...values, revision: 1 }));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictError(`an agent with slug "${values.slug}" already exists`);
      }
      throw error;
    }
  }

  async update(id: string, expectedRevision: number, values: QueryDeepPartialEntity<Agent>): Promise<void> {
    try {
      await updateAtRevision(this.repo, id, expectedRevision, values);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictError('another agent already uses that slug');
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }

  countByPersona(personaId: string): Promise<number> {
    return this.repo.count({ where: { personaId } });
  }

  countByDomainPrompt(promptId: string): Promise<number> {
    return this.repo.count({ where: { domainPromptId: promptId } });
  }

  /** Agents whose JSON settings or routes reference an id — checked before deleting it. */
  async findReferencing(field: 'knowledgeBaseIds' | 'providerId', id: string): Promise<Array<Pick<Agent, 'id' | 'name'>>> {
    const path = field === 'knowledgeBaseIds' ? 'agent.settings' : 'agent.model_routes';
    const needle = field === 'knowledgeBaseIds' ? '$.knowledge.knowledgeBaseIds' : '$[*].providerId';
    return this.repo
      .createQueryBuilder('agent')
      .select(['agent.id', 'agent.name'])
      .where(`JSON_CONTAINS(JSON_EXTRACT(${path}, :needle), JSON_QUOTE(:id))`, { needle, id })
      .getMany();
  }
}

@Injectable()
export class PersonaRepository {
  constructor(@InjectRepository(Persona) private readonly repo: Repository<Persona>) {}

  list(): Promise<Persona[]> {
    return this.repo.find({ order: { id: 'ASC' } });
  }

  findById(id: string): Promise<Persona | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(values: Pick<Persona, 'name' | 'displayName' | 'avatarUrl' | 'tagline' | 'prompt'>): Promise<Persona> {
    return this.repo.save(this.repo.create({ ...values, revision: 1 }));
  }

  update(id: string, expectedRevision: number, values: QueryDeepPartialEntity<Persona>): Promise<void> {
    return updateAtRevision(this.repo, id, expectedRevision, values);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}

@Injectable()
export class PromptRepository {
  constructor(@InjectRepository(Prompt) private readonly repo: Repository<Prompt>) {}

  listByKind(kind: PromptKind): Promise<Prompt[]> {
    return this.repo.find({ where: { kind }, order: { id: 'ASC' } });
  }

  findById(id: string): Promise<Prompt | null> {
    return this.repo.findOne({ where: { id } });
  }

  findMaster(): Promise<Prompt | null> {
    return this.repo.findOne({ where: { kind: PromptKind.MASTER }, order: { id: 'DESC' } });
  }

  create(values: Pick<Prompt, 'kind' | 'name' | 'description' | 'text'>): Promise<Prompt> {
    return this.repo.save(this.repo.create({ ...values, revision: 1 }));
  }

  update(id: string, expectedRevision: number, values: QueryDeepPartialEntity<Prompt>): Promise<void> {
    return updateAtRevision(this.repo, id, expectedRevision, values);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}

export type KnowledgeDocumentSummary = Omit<KnowledgeDocument, 'content'>;

@Injectable()
export class KnowledgeRepository {
  constructor(
    @InjectRepository(KnowledgeBase) private readonly bases: Repository<KnowledgeBase>,
    @InjectRepository(KnowledgeDocument) private readonly documents: Repository<KnowledgeDocument>,
  ) {}

  listBases(): Promise<KnowledgeBase[]> {
    return this.bases.find({ order: { id: 'ASC' } });
  }

  findBase(id: string): Promise<KnowledgeBase | null> {
    return this.bases.findOne({ where: { id } });
  }

  findBasesByIds(ids: string[]): Promise<KnowledgeBase[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.bases.find({ where: { id: In(ids) } });
  }

  createBase(values: Pick<KnowledgeBase, 'name' | 'description'>): Promise<KnowledgeBase> {
    return this.bases.save(this.bases.create({ ...values, revision: 1 }));
  }

  updateBase(id: string, expectedRevision: number, values: QueryDeepPartialEntity<KnowledgeBase>): Promise<void> {
    return updateAtRevision(this.bases, id, expectedRevision, values);
  }

  async deleteBase(id: string): Promise<void> {
    await this.documents.delete({ knowledgeBaseId: id });
    await this.bases.delete({ id });
  }

  /** Without content — a listing never ships megabytes of text. */
  listDocuments(knowledgeBaseId: string): Promise<KnowledgeDocumentSummary[]> {
    return this.documents.find({
      select: ['id', 'knowledgeBaseId', 'title', 'charCount', 'position', 'status', 'revision', 'createdAt', 'updatedAt'],
      where: { knowledgeBaseId },
      order: { position: 'ASC', id: 'ASC' },
    });
  }

  async statsByBase(): Promise<Map<string, { documents: number; chars: number }>> {
    const rows = await this.documents
      .createQueryBuilder('document')
      .select('document.knowledge_base_id', 'baseId')
      .addSelect('COUNT(*)', 'documents')
      .addSelect('COALESCE(SUM(document.char_count), 0)', 'chars')
      .groupBy('document.knowledge_base_id')
      .getRawMany<{ baseId: string; documents: string; chars: string }>();
    return new Map(rows.map((row) => [String(row.baseId), { documents: Number(row.documents), chars: Number(row.chars) }]));
  }

  findDocument(id: string): Promise<KnowledgeDocument | null> {
    return this.documents.findOne({ where: { id } });
  }

  async nextPosition(knowledgeBaseId: string): Promise<number> {
    const row = await this.documents
      .createQueryBuilder('document')
      .select('COALESCE(MAX(document.position), -1) + 1', 'next')
      .where('document.knowledge_base_id = :knowledgeBaseId', { knowledgeBaseId })
      .getRawOne<{ next: string }>();
    return Number(row?.next ?? 0);
  }

  createDocument(values: Pick<KnowledgeDocument, 'knowledgeBaseId' | 'title' | 'content' | 'charCount' | 'position' | 'status'>): Promise<KnowledgeDocument> {
    return this.documents.save(this.documents.create({ ...values, revision: 1 }));
  }

  updateDocument(id: string, expectedRevision: number, values: QueryDeepPartialEntity<KnowledgeDocument>): Promise<void> {
    return updateAtRevision(this.documents, id, expectedRevision, values);
  }

  async deleteDocument(id: string): Promise<void> {
    await this.documents.delete({ id });
  }
}

@Injectable()
export class ProviderRepository {
  constructor(@InjectRepository(LlmProvider) private readonly repo: Repository<LlmProvider>) {}

  list(): Promise<LlmProvider[]> {
    return this.repo.find({ order: { id: 'ASC' } });
  }

  findById(id: string): Promise<LlmProvider | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByIds(ids: string[]): Promise<LlmProvider[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.repo.find({ where: { id: In(ids) } });
  }

  create(values: Omit<LlmProvider, 'id' | 'revision' | 'createdAt' | 'updatedAt'>): Promise<LlmProvider> {
    return this.repo.save(this.repo.create({ ...values, revision: 1 }));
  }

  update(id: string, expectedRevision: number, values: QueryDeepPartialEntity<LlmProvider>): Promise<void> {
    return updateAtRevision(this.repo, id, expectedRevision, values);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}

@Injectable()
export class ConfigRevisionRepository {
  constructor(@InjectRepository(ConfigRevision) private readonly repo: Repository<ConfigRevision>) {}

  async record(resourceType: ConfigResourceType, resourceId: string, revision: number, snapshot: Record<string, unknown>, changedBy: string | null): Promise<void> {
    try {
      await this.repo.insert({ resourceType, resourceId, revision, snapshot, changedBy } as QueryDeepPartialEntity<ConfigRevision>);
    } catch (error) {
      // A retried save writes the same revision twice; the first record stands.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }

  list(resourceType: ConfigResourceType, resourceId: string, limit: number): Promise<ConfigRevision[]> {
    return this.repo.find({ where: { resourceType, resourceId }, order: { revision: 'DESC' }, take: limit });
  }

  find(resourceType: ConfigResourceType, resourceId: string, revision: number): Promise<ConfigRevision | null> {
    return this.repo.findOne({ where: { resourceType, resourceId, revision } });
  }
}

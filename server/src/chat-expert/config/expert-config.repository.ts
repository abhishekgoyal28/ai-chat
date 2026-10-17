import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Agent, KnowledgeDocument, LlmProvider, Persona, Prompt } from '../../shared/database/entities';
import { PromptKind, RecordStatus } from '../../shared/domain/enums';

export type KnowledgeDocumentView = Pick<KnowledgeDocument, 'id' | 'knowledgeBaseId' | 'title' | 'content' | 'position'>;

/** Read-only configuration lookups for chat-expert. It never writes. */
@Injectable()
export class ExpertConfigRepository {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Persona) private readonly personas: Repository<Persona>,
    @InjectRepository(Prompt) private readonly prompts: Repository<Prompt>,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(KnowledgeDocument) private readonly documents: Repository<KnowledgeDocument>,
  ) {}

  findAgent(id: string): Promise<Agent | null> {
    return this.agents.findOne({ where: { id } });
  }

  findPersona(id: string): Promise<Persona | null> {
    return this.personas.findOne({ where: { id } });
  }

  findPrompt(id: string): Promise<Prompt | null> {
    return this.prompts.findOne({ where: { id } });
  }

  /** The newest MASTER row wins; there is normally exactly one. */
  findMasterPrompt(): Promise<Prompt | null> {
    return this.prompts.findOne({ where: { kind: PromptKind.MASTER }, order: { id: 'DESC' } });
  }

  findProvider(id: string): Promise<LlmProvider | null> {
    return this.providers.findOne({ where: { id } });
  }

  /** Active documents of these knowledge bases, in prompt order. */
  findActiveDocuments(knowledgeBaseIds: string[]): Promise<KnowledgeDocumentView[]> {
    if (knowledgeBaseIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.documents.find({
      select: ['id', 'knowledgeBaseId', 'title', 'content', 'position'],
      where: { knowledgeBaseId: In(knowledgeBaseIds), status: RecordStatus.ACTIVE },
      order: { position: 'ASC', id: 'ASC' },
    });
  }
}

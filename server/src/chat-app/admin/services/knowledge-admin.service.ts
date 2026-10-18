import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KnowledgeBase, KnowledgeDocument } from '../../../shared/database/entities';
import { ConfigResourceType } from '../../../shared/domain/enums';
import { ConflictError, NotFoundError } from '../../../shared/errors/app-errors';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { assertCanModify } from '../../auth/resource-ownership';
import {
  knowledgeBaseInputSchema,
  knowledgeBaseUpdateSchema,
  knowledgeDocumentInputSchema,
  knowledgeDocumentUpdateSchema,
} from '../admin.schemas';
import { AgentAdminRepository, KnowledgeDocumentSummary, KnowledgeRepository } from '../repositories/config.repositories';
import { RevisionRecorder } from './revision-recorder.service';

export interface KnowledgeBaseView extends KnowledgeBase {
  documents: number;
  chars: number;
}

/** Normalises pasted or uploaded text: consistent newlines, no trailing whitespace, no NUL bytes. */
export const normaliseDocumentText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

/**
 * Knowledge bases: named collections of text documents an agent can draw on.
 * v1 places them into the prompt within the agent's character budget (no
 * embeddings), so a document's position decides what is kept when the budget
 * is tight.
 */
@Injectable()
export class KnowledgeAdminService {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly agents: AgentAdminRepository,
    private readonly revisions: RevisionRecorder,
  ) {}

  async listBases(): Promise<KnowledgeBaseView[]> {
    const [bases, stats] = await Promise.all([this.knowledge.listBases(), this.knowledge.statsByBase()]);
    return bases.map((base) => ({ ...base, documents: stats.get(base.id)?.documents ?? 0, chars: stats.get(base.id)?.chars ?? 0 }));
  }

  async getBase(id: string): Promise<KnowledgeBase & { documentList: KnowledgeDocumentSummary[] }> {
    const base = await this.requireBase(id);
    return { ...base, documentList: await this.knowledge.listDocuments(id) };
  }

  async createBase(input: z.infer<typeof knowledgeBaseInputSchema>, by: AdminPrincipal): Promise<KnowledgeBase> {
    const base = await this.knowledge.createBase({ name: input.name, description: input.description ?? null, createdById: by.id });
    await this.revisions.record(ConfigResourceType.KNOWLEDGE_BASE, base.id, base.revision, { name: base.name, description: base.description }, by);
    return base;
  }

  async updateBase(id: string, input: z.infer<typeof knowledgeBaseUpdateSchema>, by: AdminPrincipal): Promise<KnowledgeBase> {
    await this.requireModifiableBase(id, by);
    await this.knowledge.updateBase(id, input.expectedRevision, { name: input.name, description: input.description ?? null });
    const base = await this.requireBase(id);
    await this.revisions.record(ConfigResourceType.KNOWLEDGE_BASE, base.id, base.revision, { name: base.name, description: base.description }, by);
    return base;
  }

  async deleteBase(id: string, by: AdminPrincipal): Promise<void> {
    await this.requireModifiableBase(id, by);
    const users = await this.agents.findReferencing('knowledgeBaseIds', id);
    if (users.length > 0) {
      throw new ConflictError(`still used by: ${users.map((agent) => agent.name).join(', ')}`);
    }
    await this.knowledge.deleteBase(id);
  }

  async getDocument(baseId: string, id: string): Promise<KnowledgeDocument> {
    return this.requireDocument(baseId, id);
  }

  async createDocument(baseId: string, input: z.infer<typeof knowledgeDocumentInputSchema>, by: AdminPrincipal): Promise<KnowledgeDocumentSummary> {
    await this.requireModifiableBase(baseId, by);
    const content = normaliseDocumentText(input.content);
    const document = await this.knowledge.createDocument({
      knowledgeBaseId: baseId,
      title: input.title,
      content,
      charCount: content.length,
      position: input.position ?? (await this.knowledge.nextPosition(baseId)),
      status: input.status,
    });
    await this.recordDocument(document, by);
    return this.summarise(document);
  }

  async updateDocument(baseId: string, id: string, input: z.infer<typeof knowledgeDocumentUpdateSchema>, by: AdminPrincipal): Promise<KnowledgeDocumentSummary> {
    await this.requireModifiableBase(baseId, by);
    const existing = await this.requireDocument(baseId, id);
    const content = normaliseDocumentText(input.content);
    await this.knowledge.updateDocument(id, input.expectedRevision, {
      title: input.title,
      content,
      charCount: content.length,
      position: input.position ?? existing.position,
      status: input.status,
    });
    const document = await this.requireDocument(baseId, id);
    await this.recordDocument(document, by);
    return this.summarise(document);
  }

  async deleteDocument(baseId: string, id: string, by: AdminPrincipal): Promise<void> {
    await this.requireModifiableBase(baseId, by);
    await this.requireDocument(baseId, id);
    await this.knowledge.deleteDocument(id);
  }

  private recordDocument(document: KnowledgeDocument, by: AdminPrincipal): Promise<void> {
    return this.revisions.record(
      ConfigResourceType.KNOWLEDGE_DOCUMENT,
      document.id,
      document.revision,
      { title: document.title, content: document.content, status: document.status, position: document.position },
      by,
    );
  }

  private summarise(document: KnowledgeDocument): KnowledgeDocumentSummary {
    return {
      id: document.id,
      knowledgeBaseId: document.knowledgeBaseId,
      title: document.title,
      charCount: document.charCount,
      position: document.position,
      status: document.status,
      revision: document.revision,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  /** Documents have no owner of their own: whoever may change the base may change its documents. */
  private async requireModifiableBase(id: string, by: AdminPrincipal): Promise<KnowledgeBase> {
    const base = await this.requireBase(id);
    assertCanModify(by, base);
    return base;
  }

  private async requireBase(id: string): Promise<KnowledgeBase> {
    const base = await this.knowledge.findBase(id);
    if (!base) {
      throw new NotFoundError('knowledge base');
    }
    return base;
  }

  private async requireDocument(baseId: string, id: string): Promise<KnowledgeDocument> {
    const document = await this.knowledge.findDocument(id);
    if (!document || document.knowledgeBaseId !== baseId) {
      throw new NotFoundError('document');
    }
    return document;
  }
}

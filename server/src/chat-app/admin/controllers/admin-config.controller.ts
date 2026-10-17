import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { KnowledgeBase, KnowledgeDocument, Persona, Prompt } from '../../../shared/database/entities';
import { ConfigResourceType } from '../../../shared/domain/enums';
import { idParamSchema, zodBody } from '../../../shared/http/zod-validation.pipe';
import { AdminAuthGuard, AdminRequest } from '../../auth/admin-auth.guard';
import {
  agentInputSchema,
  agentUpdateSchema,
  knowledgeBaseInputSchema,
  knowledgeBaseUpdateSchema,
  knowledgeDocumentInputSchema,
  knowledgeDocumentUpdateSchema,
  masterPromptUpdateSchema,
  personaInputSchema,
  personaUpdateSchema,
  promptInputSchema,
  promptUpdateSchema,
  revisionRestoreSchema,
} from '../admin.schemas';
import { KnowledgeDocumentSummary } from '../repositories/config.repositories';
import { AgentAdminService, AgentView } from '../services/agent-admin.service';
import { KnowledgeAdminService, KnowledgeBaseView } from '../services/knowledge-admin.service';
import { PersonaAdminService } from '../services/persona-admin.service';
import { PromptAdminService } from '../services/prompt-admin.service';
import { RevisionRecorder } from '../services/revision-recorder.service';

const id = zodBody(idParamSchema);
type Restore = z.infer<typeof revisionRestoreSchema>;

/** Agents, personas, prompts and knowledge — everything EDITOR and ADMIN members may change. */
@Controller('admin/api')
@UseGuards(AdminAuthGuard)
export class AdminConfigController {
  constructor(
    private readonly agents: AgentAdminService,
    private readonly personas: PersonaAdminService,
    private readonly prompts: PromptAdminService,
    private readonly knowledge: KnowledgeAdminService,
    private readonly revisions: RevisionRecorder,
  ) {}

  // --- agents ---------------------------------------------------------------

  @Get('agents')
  listAgents(): Promise<AgentView[]> {
    return this.agents.list();
  }

  @Get('agents/:id')
  getAgent(@Param('id', id) agentId: string): Promise<AgentView> {
    return this.agents.get(agentId);
  }

  @Post('agents')
  createAgent(@Req() request: AdminRequest, @Body(zodBody(agentInputSchema)) body: z.infer<typeof agentInputSchema>): Promise<AgentView> {
    return this.agents.create(body, request.admin);
  }

  @Put('agents/:id')
  updateAgent(
    @Req() request: AdminRequest,
    @Param('id', id) agentId: string,
    @Body(zodBody(agentUpdateSchema)) body: z.infer<typeof agentUpdateSchema>,
  ): Promise<AgentView> {
    return this.agents.update(agentId, body, request.admin);
  }

  @Delete('agents/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteAgent(@Param('id', id) agentId: string): Promise<void> {
    return this.agents.delete(agentId);
  }

  @Post('agents/:id/restore')
  async restoreAgent(@Req() request: AdminRequest, @Param('id', id) agentId: string, @Body(zodBody(revisionRestoreSchema)) body: Restore): Promise<AgentView> {
    return this.agents.restore(agentId, await this.revisions.snapshot(ConfigResourceType.AGENT, agentId, body.revision), request.admin);
  }

  // --- personas -------------------------------------------------------------

  @Get('personas')
  listPersonas(): Promise<Persona[]> {
    return this.personas.list();
  }

  @Get('personas/:id')
  getPersona(@Param('id', id) personaId: string): Promise<Persona> {
    return this.personas.get(personaId);
  }

  @Post('personas')
  createPersona(@Req() request: AdminRequest, @Body(zodBody(personaInputSchema)) body: z.infer<typeof personaInputSchema>): Promise<Persona> {
    return this.personas.create(body, request.admin);
  }

  @Put('personas/:id')
  updatePersona(
    @Req() request: AdminRequest,
    @Param('id', id) personaId: string,
    @Body(zodBody(personaUpdateSchema)) body: z.infer<typeof personaUpdateSchema>,
  ): Promise<Persona> {
    return this.personas.update(personaId, body, request.admin);
  }

  @Delete('personas/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePersona(@Param('id', id) personaId: string): Promise<void> {
    return this.personas.delete(personaId);
  }

  @Post('personas/:id/restore')
  async restorePersona(@Req() request: AdminRequest, @Param('id', id) personaId: string, @Body(zodBody(revisionRestoreSchema)) body: Restore): Promise<Persona> {
    return this.personas.restore(personaId, await this.revisions.snapshot(ConfigResourceType.PERSONA, personaId, body.revision), request.admin);
  }

  // --- prompts --------------------------------------------------------------

  @Get('prompts/master')
  getMaster(): Promise<Prompt & { defaultText: string }> {
    return this.prompts.getMaster();
  }

  @Put('prompts/master')
  updateMaster(@Req() request: AdminRequest, @Body(zodBody(masterPromptUpdateSchema)) body: z.infer<typeof masterPromptUpdateSchema>): Promise<Prompt & { defaultText: string }> {
    return this.prompts.updateMaster(body, request.admin);
  }

  @Get('prompts')
  listDomainPrompts(): Promise<Prompt[]> {
    return this.prompts.listDomain();
  }

  @Get('prompts/:id')
  getPrompt(@Param('id', id) promptId: string): Promise<Prompt> {
    return this.prompts.get(promptId);
  }

  @Post('prompts')
  createPrompt(@Req() request: AdminRequest, @Body(zodBody(promptInputSchema)) body: z.infer<typeof promptInputSchema>): Promise<Prompt> {
    return this.prompts.createDomain(body, request.admin);
  }

  @Put('prompts/:id')
  updatePrompt(
    @Req() request: AdminRequest,
    @Param('id', id) promptId: string,
    @Body(zodBody(promptUpdateSchema)) body: z.infer<typeof promptUpdateSchema>,
  ): Promise<Prompt> {
    return this.prompts.updateDomain(promptId, body, request.admin);
  }

  @Delete('prompts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePrompt(@Param('id', id) promptId: string): Promise<void> {
    return this.prompts.deleteDomain(promptId);
  }

  @Post('prompts/:id/restore')
  async restorePrompt(@Req() request: AdminRequest, @Param('id', id) promptId: string, @Body(zodBody(revisionRestoreSchema)) body: Restore): Promise<Prompt> {
    return this.prompts.restore(promptId, await this.revisions.snapshot(ConfigResourceType.PROMPT, promptId, body.revision), request.admin);
  }

  // --- knowledge ------------------------------------------------------------

  @Get('knowledge-bases')
  listBases(): Promise<KnowledgeBaseView[]> {
    return this.knowledge.listBases();
  }

  @Get('knowledge-bases/:id')
  getBase(@Param('id', id) baseId: string): Promise<KnowledgeBase & { documentList: KnowledgeDocumentSummary[] }> {
    return this.knowledge.getBase(baseId);
  }

  @Post('knowledge-bases')
  createBase(@Req() request: AdminRequest, @Body(zodBody(knowledgeBaseInputSchema)) body: z.infer<typeof knowledgeBaseInputSchema>): Promise<KnowledgeBase> {
    return this.knowledge.createBase(body, request.admin);
  }

  @Put('knowledge-bases/:id')
  updateBase(
    @Req() request: AdminRequest,
    @Param('id', id) baseId: string,
    @Body(zodBody(knowledgeBaseUpdateSchema)) body: z.infer<typeof knowledgeBaseUpdateSchema>,
  ): Promise<KnowledgeBase> {
    return this.knowledge.updateBase(baseId, body, request.admin);
  }

  @Delete('knowledge-bases/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteBase(@Param('id', id) baseId: string): Promise<void> {
    return this.knowledge.deleteBase(baseId);
  }

  @Get('knowledge-bases/:id/documents/:documentId')
  getDocument(@Param('id', id) baseId: string, @Param('documentId', id) documentId: string): Promise<KnowledgeDocument> {
    return this.knowledge.getDocument(baseId, documentId);
  }

  @Post('knowledge-bases/:id/documents')
  createDocument(
    @Req() request: AdminRequest,
    @Param('id', id) baseId: string,
    @Body(zodBody(knowledgeDocumentInputSchema)) body: z.infer<typeof knowledgeDocumentInputSchema>,
  ): Promise<KnowledgeDocumentSummary> {
    return this.knowledge.createDocument(baseId, body, request.admin);
  }

  @Put('knowledge-bases/:id/documents/:documentId')
  updateDocument(
    @Req() request: AdminRequest,
    @Param('id', id) baseId: string,
    @Param('documentId', id) documentId: string,
    @Body(zodBody(knowledgeDocumentUpdateSchema)) body: z.infer<typeof knowledgeDocumentUpdateSchema>,
  ): Promise<KnowledgeDocumentSummary> {
    return this.knowledge.updateDocument(baseId, documentId, body, request.admin);
  }

  @Delete('knowledge-bases/:id/documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteDocument(@Param('id', id) baseId: string, @Param('documentId', id) documentId: string): Promise<void> {
    return this.knowledge.deleteDocument(baseId, documentId);
  }

  // --- history --------------------------------------------------------------

  @Get('revisions/:type/:resourceId')
  listRevisions(
    @Param('type', zodBody(z.nativeEnum(ConfigResourceType))) type: ConfigResourceType,
    @Param('resourceId', zodBody(z.string().min(1).max(80))) resourceId: string,
  ): Promise<unknown[]> {
    return this.revisions.list(type, resourceId);
  }
}

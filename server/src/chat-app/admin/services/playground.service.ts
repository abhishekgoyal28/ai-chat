import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { GenerationKind, HistoryRole, PreviewResponse } from '../../../shared/contracts/generation.contract';
import { NotFoundError } from '../../../shared/errors/app-errors';
import { pickModelRoute } from '../../agents/agent-runtime.service';
import { AdminPrincipal } from '../../auth/admin-auth.service';
import { SessionGrant, SessionService } from '../../conversation/services/session.service';
import { playgroundSchema } from '../admin.schemas';
import { PersonaRepository, PromptRepository } from '../repositories/config.repositories';
import { PreviewService } from './preview.service';

/**
 * Two ways to try an agent from the dashboard:
 *   - preview: one generation against UNSAVED edits, showing the exact system
 *     prompt — for tuning prompts before publishing them.
 *   - test session: a real conversation with the SAVED agent through the real
 *     socket, exactly as an end user would get it.
 */
@Injectable()
export class PlaygroundService {
  constructor(
    private readonly personas: PersonaRepository,
    private readonly prompts: PromptRepository,
    private readonly preview: PreviewService,
    private readonly sessions: SessionService,
  ) {}

  async run(input: z.infer<typeof playgroundSchema>): Promise<PreviewResponse> {
    const persona = await this.personas.findById(input.agent.personaId);
    if (!persona) {
      throw new NotFoundError('persona');
    }
    const domainPrompt = input.agent.domainPromptId ? await this.prompts.findById(input.agent.domainPromptId) : null;
    const route = pickModelRoute(input.agent.modelRoutes);

    return this.preview.run({
      kind: input.kind as GenerationKind.REPLY | GenerationKind.GREETING | GenerationKind.FAREWELL,
      agent: {
        agentId: input.agent.agentId,
        name: input.agent.name,
        settings: input.agent.settings,
        personaPrompt: input.agent.personaPrompt ?? persona.prompt,
        personaName: persona.displayName,
        domainPromptText: input.agent.domainPromptText ?? domainPrompt?.text ?? null,
        masterPromptText: input.agent.masterPromptText ?? null,
        route: route ? { providerId: route.providerId, model: route.model } : null,
      },
      history: input.history.map((entry) => ({ role: entry.role as HistoryRole, body: entry.body })),
      userMessage: input.message,
      user: { externalUserId: 'dashboard-playground', name: input.user.name ?? null, attributes: input.user.attributes },
      context: input.context ?? null,
    });
  }

  /** A real session for the signed-in operator. `fresh` starts a new conversation each time. */
  testSession(agentSlug: string, fresh: boolean, admin: AdminPrincipal): Promise<SessionGrant> {
    return this.sessions.startOrResume({
      agentSlug,
      externalUserId: `dashboard:${admin.id}`,
      scope: fresh ? `test-${Date.now()}` : 'test',
      userName: admin.name,
      metadata: { source: 'dashboard-test' },
    });
  }

  /** Only for the operator's own test conversations — never a way into a real user's session. */
  async refreshTestToken(conversationId: string, admin: AdminPrincipal): Promise<SessionGrant> {
    const summary = await this.sessions.getSummary(conversationId);
    if (summary.externalUserId !== `dashboard:${admin.id}`) {
      throw new NotFoundError('test conversation');
    }
    return this.sessions.refreshToken(conversationId);
  }
}

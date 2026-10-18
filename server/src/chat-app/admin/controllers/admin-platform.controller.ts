import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PreviewResponse } from '../../../shared/contracts/generation.contract';
import { AdminRole, ConfigResourceType, ConversationStatus } from '../../../shared/domain/enums';
import { idParamSchema, zodBody } from '../../../shared/http/zod-validation.pipe';
import { AdminAuthGuard, AdminRequest, RequireRole } from '../../auth/admin-auth.guard';
import { SessionGrant } from '../../conversation/services/session.service';
import { WebhookService } from '../../integrations/webhook.service';
import { PlatformSettingsService } from '../../platform/platform-settings.service';
import {
  apiKeyCreateSchema,
  conversationListQuerySchema,
  playgroundSchema,
  providerInputSchema,
  providerTestSchema,
  providerUpdateSchema,
  pushSettingsSchema,
  retentionSettingsSchema,
  teamMemberCreateSchema,
  teamMemberUpdateSchema,
  testSessionSchema,
  webhookSettingsSchema,
} from '../admin.schemas';
import { AccessAdminService, ApiKeyView, TeamMemberView } from '../services/access-admin.service';
import { ConversationAdminService } from '../services/conversation-admin.service';
import { OverviewService } from '../services/overview.service';
import { PlaygroundService } from '../services/playground.service';
import { ProviderAdminService, ProviderView } from '../services/provider-admin.service';
import { RevisionRecorder } from '../services/revision-recorder.service';

const id = zodBody(idParamSchema);

@Controller('admin/api')
@UseGuards(AdminAuthGuard)
export class AdminPlatformController {
  constructor(
    private readonly overviewService: OverviewService,
    private readonly providers: ProviderAdminService,
    private readonly conversations: ConversationAdminService,
    private readonly playground: PlaygroundService,
    private readonly access: AccessAdminService,
    private readonly settings: PlatformSettingsService,
    private readonly webhooks: WebhookService,
    private readonly revisions: RevisionRecorder,
  ) {}

  @Get('overview')
  overview(): Promise<Record<string, unknown>> {
    return this.overviewService.overview();
  }

  @Get('meta')
  meta(): Record<string, unknown> {
    return this.overviewService.meta();
  }

  // --- LLM providers (ADMIN: they hold credentials) ---------------------------

  @Get('providers')
  listProviders(): Promise<ProviderView[]> {
    return this.providers.list();
  }

  @Post('providers')
  @RequireRole(AdminRole.ADMIN)
  createProvider(@Req() request: AdminRequest, @Body(zodBody(providerInputSchema)) body: z.infer<typeof providerInputSchema>): Promise<ProviderView> {
    return this.providers.create(body, request.admin);
  }

  @Put('providers/:id')
  @RequireRole(AdminRole.ADMIN)
  updateProvider(
    @Req() request: AdminRequest,
    @Param('id', id) providerId: string,
    @Body(zodBody(providerUpdateSchema)) body: z.infer<typeof providerUpdateSchema>,
  ): Promise<ProviderView> {
    return this.providers.update(providerId, body, request.admin);
  }

  @Delete('providers/:id')
  @RequireRole(AdminRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteProvider(@Param('id', id) providerId: string): Promise<void> {
    return this.providers.delete(providerId);
  }

  @Post('providers/:id/test')
  @HttpCode(HttpStatus.OK)
  testProvider(@Param('id', id) providerId: string, @Body(zodBody(providerTestSchema)) body: z.infer<typeof providerTestSchema>): Promise<PreviewResponse> {
    return this.providers.test(providerId, body.model);
  }

  // --- conversations --------------------------------------------------------

  @Get('conversations')
  listConversations(@Query(zodBody(conversationListQuerySchema)) query: z.infer<typeof conversationListQuerySchema>): Promise<unknown> {
    return this.conversations.list({ ...query, status: query.status as ConversationStatus | undefined });
  }

  @Get('conversations/:id')
  getConversation(@Param('id', id) conversationId: string): Promise<unknown> {
    return this.conversations.get(conversationId);
  }

  @Post('conversations/:id/end')
  @HttpCode(HttpStatus.OK)
  @RequireRole(AdminRole.ADMIN, AdminRole.EDITOR)
  async endConversation(@Param('id', id) conversationId: string): Promise<{ ending: true }> {
    await this.conversations.end(conversationId);
    return { ending: true };
  }

  // --- playground -----------------------------------------------------------

  @Post('playground')
  @HttpCode(HttpStatus.OK)
  runPlayground(@Body(zodBody(playgroundSchema)) body: z.infer<typeof playgroundSchema>): Promise<PreviewResponse> {
    return this.playground.run(body);
  }

  @Post('test-sessions')
  @HttpCode(HttpStatus.OK)
  testSession(@Req() request: AdminRequest, @Body(zodBody(testSessionSchema)) body: z.infer<typeof testSessionSchema>): Promise<SessionGrant> {
    return this.playground.testSession(body.agentSlug, body.fresh, request.admin);
  }

  /** A fresh token for the operator's own test conversation. */
  @Post('test-sessions/:id/token')
  @HttpCode(HttpStatus.OK)
  refreshTestToken(@Req() request: AdminRequest, @Param('id', id) conversationId: string): Promise<SessionGrant> {
    return this.playground.refreshTestToken(conversationId, request.admin);
  }

  // --- access (ADMIN) -------------------------------------------------------

  @Get('api-keys')
  @RequireRole(AdminRole.ADMIN)
  listKeys(): Promise<ApiKeyView[]> {
    return this.access.listKeys();
  }

  @Post('api-keys')
  @RequireRole(AdminRole.ADMIN)
  createKey(@Req() request: AdminRequest, @Body(zodBody(apiKeyCreateSchema)) body: z.infer<typeof apiKeyCreateSchema>): Promise<ApiKeyView & { key: string }> {
    return this.access.createKey(body.name, request.admin);
  }

  @Delete('api-keys/:id')
  @RequireRole(AdminRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeKey(@Param('id', id) keyId: string): Promise<void> {
    return this.access.revokeKey(keyId);
  }

  @Get('team')
  @RequireRole(AdminRole.ADMIN)
  listTeam(): Promise<TeamMemberView[]> {
    return this.access.listMembers();
  }

  @Post('team')
  @RequireRole(AdminRole.ADMIN)
  addMember(@Body(zodBody(teamMemberCreateSchema)) body: z.infer<typeof teamMemberCreateSchema>): Promise<TeamMemberView> {
    return this.access.createMember(body);
  }

  @Put('team/:id')
  @RequireRole(AdminRole.ADMIN)
  updateMember(
    @Req() request: AdminRequest,
    @Param('id', id) memberId: string,
    @Body(zodBody(teamMemberUpdateSchema)) body: z.infer<typeof teamMemberUpdateSchema>,
  ): Promise<TeamMemberView> {
    return this.access.updateMember(memberId, body, request.admin);
  }

  // --- platform settings (ADMIN) --------------------------------------------

  @Get('settings')
  @RequireRole(AdminRole.ADMIN)
  getSettings(): Promise<unknown> {
    return this.settings.describe();
  }

  @Put('settings/webhooks')
  @RequireRole(AdminRole.ADMIN)
  async saveWebhooks(@Req() request: AdminRequest, @Body(zodBody(webhookSettingsSchema)) body: z.infer<typeof webhookSettingsSchema>): Promise<unknown> {
    const saved = await this.settings.saveWebhooks(body, request.admin.email);
    await this.revisions.record(ConfigResourceType.PLATFORM_SETTINGS, 'webhooks', Number(saved.revision), saved, request.admin);
    return saved;
  }

  @Post('settings/webhooks/test')
  @RequireRole(AdminRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  testWebhook(): Promise<unknown> {
    return this.webhooks.sendTest();
  }

  @Put('settings/push')
  @RequireRole(AdminRole.ADMIN)
  async savePush(@Req() request: AdminRequest, @Body(zodBody(pushSettingsSchema)) body: z.infer<typeof pushSettingsSchema>): Promise<unknown> {
    const saved = await this.settings.savePush(body, request.admin.email);
    await this.revisions.record(ConfigResourceType.PLATFORM_SETTINGS, 'push', Number(saved.revision), saved, request.admin);
    return saved;
  }

  @Put('settings/retention')
  @RequireRole(AdminRole.ADMIN)
  async saveRetention(@Req() request: AdminRequest, @Body(zodBody(retentionSettingsSchema)) body: z.infer<typeof retentionSettingsSchema>): Promise<unknown> {
    const saved = await this.settings.saveRetention(body, request.admin.email);
    await this.revisions.record(ConfigResourceType.PLATFORM_SETTINGS, 'retention', Number(saved.revision), saved, request.admin);
    return saved;
  }
}

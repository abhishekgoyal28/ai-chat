import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ConversationEndReason } from '../../shared/domain/enums';
import { idParamSchema, zodBody } from '../../shared/http/zod-validation.pipe';
import { HostApiKeyGuard } from '../auth/host-api-key.guard';
import { DataLifecycleService } from '../conversation/services/data-lifecycle.service';
import { HistoryPage, HistoryService } from '../conversation/services/history.service';
import { SessionGrant, SessionService, SessionSummary } from '../conversation/services/session.service';
import { UserDeviceRepository } from '../integrations/integration.repositories';
import {
  externalUserIdSchema,
  listSessionsQuerySchema,
  registerDeviceSchema,
  startSessionSchema,
  StartSessionBody,
  transcriptQuerySchema,
  updateContextSchema,
} from './host-api.schemas';
import { z } from 'zod';

/**
 * The host API: called by YOUR backend with an API key, never by a browser or
 * app. The typical flow — your backend calls POST /v1/sessions for the
 * signed-in user and hands the returned token and socketUrl to your client.
 */
@Controller('v1')
@UseGuards(HostApiKeyGuard)
export class HostApiController {
  constructor(
    private readonly sessions: SessionService,
    private readonly history: HistoryService,
    private readonly lifecycle: DataLifecycleService,
    private readonly devices: UserDeviceRepository,
  ) {}

  /** Create the conversation, or resume it — same agent + user + scope is always the same conversation. */
  @Post('sessions')
  @HttpCode(HttpStatus.OK)
  startSession(@Body(zodBody(startSessionSchema)) body: StartSessionBody): Promise<SessionGrant> {
    return this.sessions.startOrResume({
      agentSlug: body.agent,
      externalUserId: body.user.id,
      scope: body.scope,
      userName: body.user.name,
      userAttributes: body.user.attributes,
      context: body.context,
      metadata: body.metadata,
    });
  }

  @Get('sessions/:id')
  getSession(@Param('id', zodBody(idParamSchema)) id: string): Promise<SessionSummary> {
    return this.sessions.getSummary(id);
  }

  /** A fresh client token, e.g. before the old one expires in a long-running session. */
  @Post('sessions/:id/token')
  @HttpCode(HttpStatus.OK)
  refreshToken(@Param('id', zodBody(idParamSchema)) id: string): Promise<SessionGrant> {
    return this.sessions.refreshToken(id);
  }

  /** Update what the agent knows about the user or the topic; applies from the next turn. */
  @Patch('sessions/:id/context')
  updateContext(
    @Param('id', zodBody(idParamSchema)) id: string,
    @Body(zodBody(updateContextSchema)) body: z.infer<typeof updateContextSchema>,
  ): Promise<SessionSummary> {
    return this.sessions.updateContext(id, {
      userName: body.user?.name,
      userAttributes: body.user?.attributes,
      context: body.context,
    });
  }

  @Post('sessions/:id/end')
  @HttpCode(HttpStatus.OK)
  endSession(@Param('id', zodBody(idParamSchema)) id: string): Promise<SessionSummary> {
    return this.sessions.end(id, ConversationEndReason.HOST_ENDED);
  }

  @Get('sessions/:id/messages')
  getMessages(
    @Param('id', zodBody(idParamSchema)) id: string,
    @Query(zodBody(transcriptQuerySchema)) query: z.infer<typeof transcriptQuerySchema>,
  ): Promise<HistoryPage> {
    return this.history.getPage(id, query);
  }

  @Get('users/:userId/sessions')
  listSessions(
    @Param('userId', zodBody(externalUserIdSchema)) userId: string,
    @Query(zodBody(listSessionsQuerySchema)) query: z.infer<typeof listSessionsQuerySchema>,
  ): Promise<{ sessions: SessionSummary[]; nextBefore: string | null }> {
    return this.sessions.listForUser(userId, query.before, query.limit);
  }

  /** Right to erasure: every conversation, message and device token of this user. */
  @Delete('users/:userId')
  eraseUser(@Param('userId', zodBody(externalUserIdSchema)) userId: string): Promise<{ conversations: number }> {
    return this.lifecycle.eraseUser(userId);
  }

  /** Push tokens, used when the platform push mode is FCM. */
  @Put('users/:userId/devices')
  async registerDevice(
    @Param('userId', zodBody(externalUserIdSchema)) userId: string,
    @Body(zodBody(registerDeviceSchema)) body: z.infer<typeof registerDeviceSchema>,
  ): Promise<{ registered: true }> {
    await this.devices.upsert(userId, body.platform, body.token);
    return { registered: true };
  }

  @Delete('users/:userId/devices')
  async removeDevice(
    @Param('userId', zodBody(externalUserIdSchema)) userId: string,
    @Body(zodBody(registerDeviceSchema.pick({ token: true }))) body: { token: string },
  ): Promise<{ removed: true }> {
    await this.devices.deleteToken(userId, body.token);
    return { removed: true };
  }
}

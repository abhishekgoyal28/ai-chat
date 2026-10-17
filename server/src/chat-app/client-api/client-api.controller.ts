import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ConversationEndReason } from '../../shared/domain/enums';
import { idParamSchema, zodBody } from '../../shared/http/zod-validation.pipe';
import { ClientRequest, ClientSessionGuard } from '../auth/client-session.guard';
import { HISTORY_PAGE_MAX, HistoryFilter, HistoryPage, HistoryService } from '../conversation/services/history.service';
import { ClientSessionView, SessionService, SessionSummary } from '../conversation/services/session.service';
import { WireMessage } from '../conversation/serializers/message.serializer';

const historyQuerySchema = z.object({
  before: z.string().regex(/^\d+$/).optional(),
  after: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
  filter: z.nativeEnum(HistoryFilter).optional(),
});

/** A single reaction: up to 32 characters covers multi-codepoint emoji (skin tones, ZWJ sequences). */
const reactionSchema = z.object({ reaction: z.string().min(1).max(32) });

/**
 * The client API: called by the browser or app with the session token the
 * host minted. The conversation always comes from the token.
 */
@Controller('v1/client')
@UseGuards(ClientSessionGuard)
export class ClientApiController {
  constructor(
    private readonly sessions: SessionService,
    private readonly history: HistoryService,
  ) {}

  /** Everything the chat screen needs on open: agent identity, behaviour, the newest page, suggestions. */
  @Get('session')
  getSession(@Req() request: ClientRequest): Promise<ClientSessionView> {
    return this.sessions.getClientView(request.session.cid);
  }

  /** `before` scrolls back; `after` resyncs after a reconnect; `filter` lists starred or pinned. */
  @Get('messages')
  getMessages(@Req() request: ClientRequest, @Query(zodBody(historyQuerySchema)) query: z.infer<typeof historyQuerySchema>): Promise<HistoryPage> {
    return this.history.getPage(request.session.cid, query);
  }

  @Post('end')
  @HttpCode(HttpStatus.OK)
  end(@Req() request: ClientRequest): Promise<SessionSummary> {
    return this.sessions.end(request.session.cid, ConversationEndReason.USER_ENDED);
  }

  @Put('messages/:id/pin')
  pin(@Req() request: ClientRequest, @Param('id', zodBody(idParamSchema)) id: string): Promise<WireMessage[]> {
    return this.history.pin(request.session.cid, id);
  }

  @Delete('messages/:id/pin')
  unpin(@Req() request: ClientRequest, @Param('id', zodBody(idParamSchema)) id: string): Promise<WireMessage[]> {
    return this.history.unpin(request.session.cid, id);
  }

  @Put('messages/:id/star')
  star(@Req() request: ClientRequest, @Param('id', zodBody(idParamSchema)) id: string): Promise<WireMessage[]> {
    return this.history.star(request.session.cid, id, true);
  }

  @Delete('messages/:id/star')
  unstar(@Req() request: ClientRequest, @Param('id', zodBody(idParamSchema)) id: string): Promise<WireMessage[]> {
    return this.history.star(request.session.cid, id, false);
  }

  @Put('messages/:id/reaction')
  react(
    @Req() request: ClientRequest,
    @Param('id', zodBody(idParamSchema)) id: string,
    @Body(zodBody(reactionSchema)) body: z.infer<typeof reactionSchema>,
  ): Promise<WireMessage[]> {
    return this.history.react(request.session.cid, id, body.reaction);
  }

  @Delete('messages/:id/reaction')
  unreact(@Req() request: ClientRequest, @Param('id', zodBody(idParamSchema)) id: string): Promise<WireMessage[]> {
    return this.history.react(request.session.cid, id, null);
  }
}

import { Injectable } from '@nestjs/common';
import { buildGreetingTurnId } from '../../../shared/contracts/generation.contract';
import { MessageSendPayload, ServerEvent, SocketErrorCode } from '../../../shared/contracts/socket-protocol';
import { TransportEventEnvelope, TransportEventType } from '../../../shared/contracts/transport-events';
import { TurnRejection, validateTurnPayload } from '../../../shared/contracts/turn-validation';
import { config } from '../../../shared/config/config';
import { Conversation } from '../../../shared/database/entities';
import { ConversationEndReason } from '../../../shared/domain/enums';
import { getLogger } from '../../../shared/logger/logger';
import { metrics } from '../../../shared/observability/metrics';
import { AgentRuntimeService, RuntimeAgent } from '../../agents/agent-runtime.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { ConversationPublisher } from './conversation-publisher.service';
import { GenerationDispatcher } from './generation-dispatcher.service';
import { SessionEndService } from './session-end.service';

/** A turn sent just before expiry may arrive just after; this is how late it may be. */
const EXPIRY_GRACE_MS = 5000;

/** Device clocks lie; tap times further off than this are replaced with server time. */
const CLIENT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * chat-app's half of the inbound path: everything chat-socket forwards.
 *
 * chat-socket already validated shape and caps, but this is the trust
 * boundary — a scripted client bypasses the socket's checks — so every rule
 * is applied again with the agent's live settings. Rejections go back as
 * error frames keyed by turnId; the socket ack was sent long before this ran.
 */
@Injectable()
export class InboundHandler {
  private readonly log = getLogger(InboundHandler.name);

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentRuntimeService,
    private readonly dispatcher: GenerationDispatcher,
    private readonly sessionEnd: SessionEndService,
    private readonly publisher: ConversationPublisher,
  ) {}

  async handle(envelope: TransportEventEnvelope): Promise<void> {
    if (!envelope?.type || !envelope.conversationId || !envelope.externalUserId) {
      this.log.warn({ type: envelope?.type }, 'malformed transport event dropped');
      return;
    }
    const conversation = await this.conversations.findById(envelope.conversationId);
    if (!conversation || conversation.externalUserId !== envelope.externalUserId) {
      this.log.warn({ conversationId: envelope.conversationId }, 'transport event for an unknown conversation — dropped');
      return;
    }

    if (envelope.type === TransportEventType.CONNECTION_INIT) {
      await this.announceGenerationInProgress(conversation);
      return;
    }
    if (envelope.type === TransportEventType.MESSAGE_SEND && envelope.payload) {
      await this.handleTurn(conversation, envelope.payload);
    }
  }

  /**
   * On (re)connect, a client that missed the typing frame — published before
   * it subscribed — still learns that a reply is on its way.
   */
  private async announceGenerationInProgress(conversation: Conversation): Promise<void> {
    if (!conversation.inflightDispatchId || !this.sessionEnd.isAcceptingTurns(conversation)) {
      return;
    }
    const greetingPending = (await this.messages.countMessages(conversation.id)) === 0;
    await this.publisher.publishQuietly(conversation.id, ServerEvent.AGENT_TYPING, {
      conversationId: conversation.id,
      turnId: greetingPending ? buildGreetingTurnId(conversation.id) : 'in-progress',
      maxDurationMs: config.GENERATION_TIMEOUT_MS,
    });
  }

  private async handleTurn(conversation: Conversation, payload: MessageSendPayload): Promise<void> {
    const agent = await this.agents.getById(conversation.agentId);
    if (!agent) {
      await this.reject(conversation, payload.clientTurnId, { code: SocketErrorCode.SESSION_ENDED, message: 'this agent no longer exists' });
      return;
    }

    if (this.isPastExpiry(conversation) && this.sessionEnd.isAcceptingTurns(conversation)) {
      // Lazy expiry: start the end now rather than waiting for the sweeper.
      await this.sessionEnd.initiateEnd(conversation, ConversationEndReason.TIMER_EXPIRED);
      conversation.endInitiatedAt = new Date();
    }

    const rejection = this.validate(conversation, agent, payload) ?? (await this.validateReplyTargets(conversation, payload));
    if (rejection) {
      metrics.turnsReceived.inc({ outcome: rejection.code });
      await this.reject(conversation, payload.clientTurnId, rejection);
      return;
    }

    const { rows, inserted } = await this.messages.insertUserMessages(
      conversation.id,
      payload.clientTurnId,
      payload.messages.map((message) => ({
        clientMessageId: message.clientMessageId,
        body: message.body,
        clientSentAt: this.resolveClientSentAt(message.sentAt),
        replyToId: message.replyToId ?? null,
      })),
    );
    if (!inserted && (payload.retryAttempt ?? 0) > 0) {
      // A deliberate retry after turn.failed: put the failed rows back in line.
      await this.messages.resetFailedUserMessages(conversation.id, rows.map((row) => row.id));
    }
    metrics.turnsReceived.inc({ outcome: inserted ? 'persisted' : 'duplicate' });

    await this.publisher.publishQuietly(conversation.id, ServerEvent.TURN_PERSISTED, {
      conversationId: conversation.id,
      turnId: payload.clientTurnId,
      messages: rows.map((row) => ({ clientMessageId: row.clientMessageId, id: row.id })),
    });

    // BUSY is normal: a reply is generating and this turn is answered after it.
    await this.dispatcher.dispatchPendingReply(conversation);
  }

  private validate(conversation: Conversation, agent: RuntimeAgent, payload: MessageSendPayload): TurnRejection | null {
    if (!this.sessionEnd.isAcceptingTurns(conversation)) {
      return { code: SocketErrorCode.SESSION_ENDED, message: 'this conversation has ended' };
    }
    if (this.isPastExpiry(conversation)) {
      return { code: SocketErrorCode.SESSION_ENDED, message: 'this conversation has expired' };
    }
    return validateTurnPayload(payload, {
      maxMessagesPerTurn: agent.settings.client.maxMessagesPerTurn,
      maxBodyChars: agent.settings.client.maxBodyChars,
    });
  }

  /** Every replyToId must name a visible message in THIS conversation — ids are guessable. */
  private async validateReplyTargets(conversation: Conversation, payload: MessageSendPayload): Promise<TurnRejection | null> {
    const replyIds = payload.messages.map((message) => message.replyToId).filter((id): id is string => Boolean(id));
    if (replyIds.length === 0) {
      return null;
    }
    const found = await this.messages.findVisibleByIds(conversation.id, replyIds);
    return replyIds.every((id) => found.has(String(id)))
      ? null
      : { code: SocketErrorCode.INVALID_REPLY_TARGET, message: 'replyToId does not name a message in this conversation' };
  }

  private async reject(conversation: Conversation, turnId: string, rejection: TurnRejection): Promise<void> {
    this.log.info({ conversationId: conversation.id, turnId, code: rejection.code }, 'turn rejected');
    await this.publisher.publishQuietly(conversation.id, ServerEvent.ERROR, { code: rejection.code, message: rejection.message, turnId });
  }

  private isPastExpiry(conversation: Conversation): boolean {
    return conversation.expiresAt !== null && Date.now() > conversation.expiresAt.getTime() + EXPIRY_GRACE_MS;
  }

  private resolveClientSentAt(sentAt: string): Date {
    const parsed = Date.parse(sentAt);
    if (Number.isNaN(parsed) || Math.abs(Date.now() - parsed) > CLIENT_CLOCK_SKEW_TOLERANCE_MS) {
      return new Date();
    }
    return new Date(parsed);
  }
}

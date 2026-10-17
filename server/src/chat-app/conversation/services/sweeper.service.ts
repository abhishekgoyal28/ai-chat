import { Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { config } from '../../../shared/config/config';
import { buildGreetingTurnId } from '../../../shared/contracts/generation.contract';
import { ServerEvent, TurnFailedPayload } from '../../../shared/contracts/socket-protocol';
import { Conversation } from '../../../shared/database/entities';
import { ConversationEndReason, ConversationStatus } from '../../../shared/domain/enums';
import { describeError, getLogger } from '../../../shared/logger/logger';
import { REDIS_CLIENT } from '../../../shared/redis/redis.providers';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { ConversationPublisher } from './conversation-publisher.service';
import { GreetingService } from './greeting.service';
import { RevealScheduler } from './reveal-scheduler.service';
import { SessionEndService } from './session-end.service';

const SWEEP_INTERVAL_MS = 5000;
const SWEEP_BATCH = 100;
/** A generation claimed this long ago without a response has been lost. */
const GENERATION_GRACE_MS = 15_000;
/** An end started this long ago without finishing is force-finalised. */
const END_GRACE_MS = 30_000;
/** A pending part this overdue lost its reveal job; it is rescheduled. */
const REVEAL_RESCHEDULE_AFTER_MS = 30_000;
/** A pending part this overdue will never reveal; it is marked FAILED so later parts can go. */
const REVEAL_GIVE_UP_AFTER_MS = 10 * 60_000;

/**
 * The server-side backstop for everything time-based. Every 5 seconds, on
 * exactly one chat-app pod (a Redis lock elects it per tick):
 *
 *   1. Expired timers   → start the end (TIMER_EXPIRED).
 *   2. Lost generations → release the claim; fail the user's turn so the
 *                         client offers a retry (or post the template
 *                         greeting, or finish an end).
 *   3. Stalled ends     → force-finalise with the fixed farewell.
 *   4. Lost reveals     → reschedule; past the give-up point, mark FAILED so
 *                         the parts behind it are not blocked forever.
 *
 * Each step works through compare-and-set claims, so a sweep racing a live
 * request is harmless, and every result set shrinks as it is processed — no
 * row can park in a query and starve the ones behind it.
 */
@Injectable()
export class SweeperService {
  private readonly log = getLogger(SweeperService.name);
  private running = false;

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly agents: AgentRuntimeService,
    private readonly sessionEnd: SessionEndService,
    private readonly greeting: GreetingService,
    private readonly reveals: RevealScheduler,
    private readonly publisher: ConversationPublisher,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    if (this.running || !(await this.acquireTickLock())) {
      return;
    }
    this.running = true;
    try {
      await this.step('expired timers', () => this.endExpired());
      await this.step('lost generations', () => this.recoverLostGenerations());
      await this.step('stalled ends', () => this.finishStalledEnds());
      await this.step('lost reveals', () => this.recoverLostReveals());
    } finally {
      this.running = false;
    }
  }

  async endExpired(): Promise<void> {
    for (const conversation of await this.conversations.findExpired(new Date(), SWEEP_BATCH)) {
      await this.isolate(conversation.id, () => this.sessionEnd.initiateEnd(conversation, ConversationEndReason.TIMER_EXPIRED));
    }
  }

  async recoverLostGenerations(): Promise<void> {
    const before = new Date(Date.now() - config.GENERATION_TIMEOUT_MS - GENERATION_GRACE_MS);
    for (const conversation of await this.conversations.findStaleGenerations(before, SWEEP_BATCH)) {
      await this.isolate(conversation.id, () => this.recoverLostGeneration(conversation));
    }
  }

  async finishStalledEnds(): Promise<void> {
    const before = new Date(Date.now() - config.GENERATION_TIMEOUT_MS - END_GRACE_MS);
    for (const conversation of await this.conversations.findStalledEnds(before, SWEEP_BATCH)) {
      await this.isolate(conversation.id, () => this.sessionEnd.forceFinalize(conversation));
    }
  }

  async recoverLostReveals(): Promise<void> {
    const now = Date.now();
    for (const part of await this.messages.findOverduePending(new Date(now - REVEAL_RESCHEDULE_AFTER_MS), SWEEP_BATCH)) {
      await this.isolate(part.conversationId, async () => {
        if (part.revealAt && now - part.revealAt.getTime() > REVEAL_GIVE_UP_AFTER_MS) {
          this.log.error({ messageId: part.id, conversationId: part.conversationId }, 'part never revealed — marking FAILED');
          await this.messages.markPartFailed(part.id);
          const conversation = await this.conversations.findById(part.conversationId);
          if (conversation?.status === ConversationStatus.ENDED) {
            await this.sessionEnd.publishCompletedIfFinal(conversation.id, conversation.endReason ?? ConversationEndReason.TIMER_EXPIRED);
          }
          return;
        }
        await this.reveals.schedule({ messageId: part.id, conversationId: part.conversationId }, 0);
      });
    }
  }

  private async recoverLostGeneration(conversation: Conversation): Promise<void> {
    if (!conversation.inflightDispatchId || !(await this.conversations.releaseGeneration(conversation.id, conversation.inflightDispatchId))) {
      return;
    }
    this.log.warn({ conversationId: conversation.id }, 'generation lost — claim released');

    if (conversation.status !== ConversationStatus.ACTIVE) {
      return;
    }
    if (conversation.endInitiatedAt) {
      await this.sessionEnd.forceFinalize(conversation);
      return;
    }
    const outstanding = await this.messages.findOutstandingUserMessages(conversation.id);
    if (outstanding.length > 0) {
      await this.messages.markUserMessagesFailed(conversation.id, outstanding.map((message) => message.id));
      const payload: TurnFailedPayload = {
        conversationId: conversation.id,
        turnId: outstanding[outstanding.length - 1].turnId,
        reason: 'TIMEOUT',
        retryable: true,
      };
      await this.publisher.publishQuietly(conversation.id, ServerEvent.TURN_FAILED, { ...payload });
      return;
    }
    // Nothing from the user yet: the lost generation was the LLM greeting.
    if ((await this.messages.findTurn(conversation.id, buildGreetingTurnId(conversation.id))).length === 0) {
      const agent = await this.agents.getById(conversation.agentId);
      if (agent) {
        const persona = await this.agents.getPersonaProfile(agent.personaId);
        await this.greeting.persistTemplateGreeting(conversation, agent, persona?.displayName ?? agent.name);
      }
    }
  }

  /** One pod per tick; the lock expires before the next tick so a dead pod never blocks sweeping. */
  private async acquireTickLock(): Promise<boolean> {
    try {
      const result = await this.redis.set(`${config.QUEUE_PREFIX}:lock:sweeper`, process.pid.toString(), 'PX', SWEEP_INTERVAL_MS - 500, 'NX');
      return result === 'OK';
    } catch (error) {
      this.log.error({ error: describeError(error) }, 'sweeper lock unavailable — skipping tick');
      return false;
    }
  }

  private async step(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.log.error({ step: name, error: describeError(error) }, 'sweep step failed — next tick retries');
    }
  }

  /** One bad row must not starve the rest of the batch. */
  private async isolate(conversationId: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.log.error({ conversationId, error: describeError(error) }, 'sweep failed for conversation — next tick retries');
    }
  }
}

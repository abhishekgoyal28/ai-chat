import type { ClientBehaviour } from './types';

export interface PendingMessage {
  clientMessageId: string;
  body: string;
  sentAt: string;
  replyToId?: string;
}

export interface TimerApi {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

export const realTimers: TimerApi = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Text endpointing: collects what the user types in one go into ONE turn,
 * the chat equivalent of detecting the end of an utterance.
 *
 * A turn goes out `debounceMs` after the last message. If the user starts
 * typing again inside that window, the batch waits for them — up to
 * `typingHoldMs` beyond the last message, and never later than
 * `maxTurnWaitMs` after the first. `maxMessagesPerTurn` sends at once.
 * Keystrokes from BEFORE a message was sent never delay it.
 */
export class TurnBatcher {
  private pending: PendingMessage[] = [];
  private flushTimer: unknown = null;
  private firstQueuedAt = 0;
  private lastAddedAt = 0;
  private lastTypingAt = Number.NEGATIVE_INFINITY;

  constructor(
    private config: ClientBehaviour,
    private readonly onFlush: (messages: PendingMessage[]) => void,
    private readonly timers: TimerApi = realTimers,
  ) {}

  updateConfig(config: ClientBehaviour): void {
    this.config = config;
  }

  add(message: PendingMessage): void {
    const now = this.timers.now();
    if (this.pending.length === 0) {
      this.firstQueuedAt = now;
    }
    this.lastAddedAt = now;
    this.pending.push(message);
    if (this.pending.length >= this.config.maxMessagesPerTurn) {
      this.flush();
      return;
    }
    this.schedule(this.config.debounceMs);
  }

  /** Call on keystrokes: a user still composing holds the batch open. */
  typing(): void {
    this.lastTypingAt = this.timers.now();
  }

  flush(): void {
    this.clearTimer();
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    this.onFlush(batch);
  }

  get size(): number {
    return this.pending.length;
  }

  dispose(): void {
    this.clearTimer();
    this.pending = [];
  }

  private onTimer(): void {
    this.flushTimer = null;
    const now = this.timers.now();
    const typedSinceLastMessage = this.lastTypingAt > this.lastAddedAt;
    const sinceTyping = now - this.lastTypingAt;
    const holdDeadline = Math.min(this.lastAddedAt + this.config.debounceMs + this.config.typingHoldMs, this.firstQueuedAt + this.config.maxTurnWaitMs);
    if (typedSinceLastMessage && sinceTyping < this.config.debounceMs && now < holdDeadline) {
      this.schedule(Math.min(this.config.debounceMs - sinceTyping, holdDeadline - now));
      return;
    }
    this.flush();
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    const deadline = this.firstQueuedAt + this.config.maxTurnWaitMs;
    const delay = Math.max(0, Math.min(delayMs, deadline - this.timers.now()));
    this.flushTimer = this.timers.set(() => this.onTimer(), delay);
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) {
      this.timers.clear(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

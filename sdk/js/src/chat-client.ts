import { io, Socket } from 'socket.io-client';
import { MessageStore } from './message-store';
import { PendingMessage, TurnBatcher } from './turn-batcher';
import type {
  ChatClientEvents,
  ChatMessage,
  ClientBehaviour,
  ConnectionState,
  HistoryPage,
  SessionView,
  StreamItem,
  SuggestedChip,
  WireMessage,
} from './types';

export interface ChatClientOptions {
  /** chat-app's public URL, e.g. https://chat.example.com */
  apiUrl: string;
  /** Where the WebSocket is served. Defaults to apiUrl (path-based routing). */
  socketUrl?: string;
  /** The session token your backend received from POST /v1/sessions. */
  token: string;
  /**
   * Called when the token is rejected or about to expire. Ask your backend for
   * a new one (it calls POST /v1/sessions again, or POST /v1/sessions/:id/token).
   */
  refreshToken?: () => Promise<string>;
  /** socket.io path, when a proxy mounts it elsewhere. */
  socketPath?: string;
}

type Handler<K extends keyof ChatClientEvents> = (payload: ChatClientEvents[K]) => void;

interface InFlightTurn {
  clientTurnId: string;
  retryAttempt: number;
  messages: PendingMessage[];
}

const ACK_TIMEOUT_MS = 8000;
const MAX_SEND_ATTEMPTS = 6;
const RESYNC_PAGE = 200;

const newId = (): string => {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return random.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
};

const isChips = (item: StreamItem): item is Extract<StreamItem, { kind: 'SUGGESTED_CHIPS' }> =>
  (item as { kind?: string }).kind === 'SUGGESTED_CHIPS';

/**
 * One conversation, end to end: loads the session, keeps a merged transcript,
 * batches what the user types into turns, delivers each turn until the server
 * acknowledges it, and resyncs after every reconnect so nothing published
 * while offline is missed.
 *
 *   const chat = new ChatClient({ apiUrl, token, refreshToken });
 *   chat.on('messages', render);
 *   await chat.connect();
 *   chat.send('Hello!');
 */
export class ChatClient {
  private readonly store = new MessageStore();
  private readonly handlers = new Map<keyof ChatClientEvents, Set<Handler<keyof ChatClientEvents>>>();
  private socket: Socket | null = null;
  private batcher: TurnBatcher | null = null;
  private token: string;
  private sending: Promise<void> = Promise.resolve();
  private readonly turnsById = new Map<string, InFlightTurn>();
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private state: ConnectionState = 'idle';
  private sessionView: SessionView | null = null;

  constructor(private readonly options: ChatClientOptions) {
    this.token = options.token;
  }

  get session(): SessionView | null {
    return this.sessionView;
  }

  get messages(): ChatMessage[] {
    return this.store.list();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  on<K extends keyof ChatClientEvents>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler<keyof ChatClientEvents>);
    this.handlers.set(event, set);
    return () => set.delete(handler as Handler<keyof ChatClientEvents>);
  }

  /** Loads the session and opens the live connection. Resolves with the session view. */
  async connect(): Promise<SessionView> {
    this.setState('connecting');
    const view = await this.request<SessionView>('GET', '/v1/client/session');
    this.sessionView = view;
    this.batcher = new TurnBatcher(view.config, (batch) => this.queueTurn(batch));
    this.ingestStream(view.messages);
    if (view.status === 'ENDED') {
      this.setState('closed');
      return view;
    }
    this.openSocket();
    return view;
  }

  /** Queues a message. It is sent with whatever else the user types in the next moments as one turn. */
  send(text: string, options: { replyToId?: string } = {}): ChatMessage {
    const body = text.trim();
    if (!body) {
      throw new Error('message is empty');
    }
    if (!this.batcher || !this.sessionView) {
      throw new Error('call connect() first');
    }
    if (!this.sessionView.acceptingMessages) {
      throw new Error('this conversation has ended');
    }
    if (body.length > this.sessionView.config.maxBodyChars) {
      throw new Error(`messages are limited to ${this.sessionView.config.maxBodyChars} characters`);
    }
    const message: PendingMessage = { clientMessageId: newId(), body, sentAt: new Date().toISOString(), ...(options.replyToId && { replyToId: options.replyToId }) };
    const local = this.store.addLocal({
      clientMessageId: message.clientMessageId,
      conversationId: this.sessionView.conversationId,
      turnId: '',
      senderType: 'USER',
      kind: 'TEXT',
      status: 'QUEUED',
      partIndex: 0,
      partsTotal: 1,
      body,
      sentAt: message.sentAt,
    });
    this.emit('suggestions', []);
    this.emitMessages();
    this.batcher.add(message);
    return local;
  }

  /** Call on every keystroke: holds the batch open while the user is still typing. */
  notifyTyping(): void {
    this.batcher?.typing();
  }

  /** Sends whatever is batched right now (e.g. when the user presses Enter twice). */
  flush(): void {
    this.batcher?.flush();
  }

  /** Retries a turn that failed (turn.failed). Same messages, next attempt number. */
  retry(turnId: string): void {
    const turn = this.turnsById.get(turnId) ?? this.rebuildTurn(turnId);
    if (!turn) {
      throw new Error(`unknown turn ${turnId}`);
    }
    turn.retryAttempt += 1;
    this.store.markTurn(turnId, 'SENDING');
    this.emitMessages();
    this.enqueueDelivery(turn);
  }

  /** Loads older messages. Resolves false when the beginning of the conversation is reached. */
  async loadOlder(limit = 50): Promise<boolean> {
    const before = this.store.oldestId;
    if (!before) {
      return false;
    }
    const page = await this.request<HistoryPage>('GET', `/v1/client/messages?before=${before}&limit=${limit}`);
    this.store.upsert(page.messages);
    this.emitMessages();
    return page.page.hasMore;
  }

  async end(): Promise<void> {
    this.batcher?.flush();
    await this.request('POST', '/v1/client/end');
  }

  async pin(messageId: string, pinned = true): Promise<void> {
    this.applyUpdates(await this.request<WireMessage[]>(pinned ? 'PUT' : 'DELETE', `/v1/client/messages/${messageId}/pin`));
  }

  async star(messageId: string, starred = true): Promise<void> {
    this.applyUpdates(await this.request<WireMessage[]>(starred ? 'PUT' : 'DELETE', `/v1/client/messages/${messageId}/star`));
  }

  async react(messageId: string, reaction: string | null): Promise<void> {
    this.applyUpdates(
      await this.request<WireMessage[]>(reaction ? 'PUT' : 'DELETE', `/v1/client/messages/${messageId}/reaction`, reaction ? { reaction } : undefined),
    );
  }

  async listStarred(): Promise<WireMessage[]> {
    return (await this.request<HistoryPage>('GET', '/v1/client/messages?filter=starred')).messages;
  }

  disconnect(): void {
    this.batcher?.flush();
    this.batcher?.dispose();
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  // --- socket -----------------------------------------------------------------

  private openSocket(): void {
    const socket = io(this.options.socketUrl ?? this.options.apiUrl, {
      transports: ['websocket'],
      path: this.options.socketPath ?? '/socket.io',
      auth: (callback) => callback({ token: this.token }),
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
    });
    this.socket = socket;

    socket.on('connect', () => void this.onConnected());
    socket.on('disconnect', () => this.setState(this.state === 'closed' ? 'closed' : 'reconnecting'));
    socket.on('connect_error', (error) => void this.onConnectError(error));
    socket.on('message.part', (payload: WireMessage | Extract<StreamItem, { kind: 'SUGGESTED_CHIPS' }>) => this.onPart(payload));
    socket.on('message.updated', (payload: WireMessage) => this.applyUpdates([payload]));
    socket.on('turn.persisted', (payload: { messages: Array<{ clientMessageId: string; id: string }> }) => {
      this.store.confirm(payload.messages);
      this.emitMessages();
    });
    socket.on('agent.typing', (payload: { maxDurationMs: number }) => this.setTyping(true, payload.maxDurationMs));
    socket.on('turn.failed', (payload: ChatClientEvents['turnFailed']) => {
      this.setTyping(false);
      this.store.markTurn(payload.turnId, 'FAILED');
      this.emitMessages();
      this.emit('turnFailed', payload);
    });
    socket.on('session.ended', (payload: ChatClientEvents['sessionEnded']) => {
      if (this.sessionView) {
        this.sessionView = { ...this.sessionView, status: 'ENDED', acceptingMessages: false, endReason: payload.endReason };
      }
      this.emit('suggestions', []);
      this.emit('sessionEnded', payload);
    });
    socket.on('session.completed', (payload: ChatClientEvents['sessionCompleted']) => {
      this.setTyping(false);
      this.emit('sessionCompleted', payload);
      this.disconnect();
    });
    socket.on('error', (payload: ChatClientEvents['error']) => {
      if (payload?.turnId) {
        this.store.markTurn(payload.turnId, 'FAILED');
        this.emitMessages();
      }
      if (payload?.code === 'SESSION_ENDED' && this.sessionView) {
        this.sessionView = { ...this.sessionView, acceptingMessages: false };
      }
      if (payload?.code === 'UNAUTHORIZED') {
        void this.renewToken();
      }
      this.emit('error', payload);
    });
    socket.on('server.shutdown', (payload: { graceMs: number }) => {
      // Reconnect early, spread out, so a rollout does not reconnect everyone at once.
      setTimeout(() => socket.disconnect().connect(), Math.random() * Math.max(500, payload.graceMs));
    });
  }

  private async onConnected(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    const ack = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('subscribe', {}).catch(() => null);
    if (!ack?.ok) {
      socket.disconnect().connect();
      return;
    }
    this.setState('connected');
    await this.resync();
    await this.refreshSuggestions();
  }

  /**
   * Suggestions are not stored messages: ones published before this client
   * subscribed are re-read from the session view while the user has not
   * spoken yet.
   */
  private async refreshSuggestions(): Promise<void> {
    if (this.store.list().some((message) => message.senderType === 'USER')) {
      return;
    }
    const view = await this.request<SessionView>('GET', '/v1/client/session').catch(() => null);
    const chips = view?.messages.find(isChips);
    if (chips) {
      this.emit('suggestions', chips.chips);
    }
  }

  private async onConnectError(error: Error): Promise<void> {
    if (error.message === 'UNAUTHORIZED') {
      await this.renewToken();
    }
  }

  private async renewToken(): Promise<void> {
    if (!this.options.refreshToken) {
      this.emit('error', { code: 'UNAUTHORIZED', message: 'session token expired and no refreshToken callback was given' });
      this.disconnect();
      return;
    }
    try {
      this.token = await this.options.refreshToken();
      this.socket?.disconnect().connect();
    } catch (error) {
      this.emit('error', { code: 'UNAUTHORIZED', message: `token refresh failed: ${(error as Error).message}` });
    }
  }

  /**
   * Everything newer than the newest message held — whatever was published
   * while disconnected, including an opening message that landed between
   * loading the session and subscribing.
   */
  private async resync(): Promise<void> {
    let after = this.store.newestId ?? '0';
    for (let page = 0; page < 20; page += 1) {
      const result: HistoryPage | null = await this.request<HistoryPage>('GET', `/v1/client/messages?after=${after}&limit=${RESYNC_PAGE}`).catch(() => null);
      if (!result || result.messages.length === 0) {
        break;
      }
      this.store.upsert(result.messages);
      after = result.messages[result.messages.length - 1].id;
      if (!result.page.hasMore) {
        break;
      }
    }
    this.emitMessages();
  }

  // --- sending ----------------------------------------------------------------

  private queueTurn(messages: PendingMessage[]): void {
    const turn: InFlightTurn = { clientTurnId: newId(), retryAttempt: 0, messages };
    this.turnsById.set(turn.clientTurnId, turn);
    for (const message of messages) {
      const entry = this.store.list().find((candidate) => candidate.clientMessageId === message.clientMessageId);
      if (entry) {
        entry.turnId = turn.clientTurnId;
      }
    }
    this.store.setLocalStatus(messages.map((message) => message.clientMessageId), 'SENDING');
    this.emitMessages();
    this.enqueueDelivery(turn);
  }

  /** Turns go out one at a time, in order; each is resent until acknowledged. */
  private enqueueDelivery(turn: InFlightTurn): void {
    this.sending = this.sending.then(() => this.deliver(turn)).catch(() => undefined);
  }

  private async deliver(turn: InFlightTurn): Promise<void> {
    const payload = { clientTurnId: turn.clientTurnId, retryAttempt: turn.retryAttempt, messages: turn.messages };
    const ids = turn.messages.map((message) => message.clientMessageId);
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      const socket = this.socket;
      if (socket?.connected) {
        // Resends reuse the identical payload: the server deduplicates them.
        const ack = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('message.send', payload).catch(() => null);
        if (ack?.ok) {
          this.store.setLocalStatus(ids, 'ACCEPTED');
          this.emitMessages();
          return;
        }
        if (ack && ack.error !== 'ENQUEUE_FAILED' && ack.error !== 'NOT_SUBSCRIBED' && ack.error !== 'RATE_LIMITED') {
          this.store.setLocalStatus(ids, 'FAILED');
          this.emitMessages();
          this.emit('error', { code: ack.error ?? 'SEND_FAILED', message: ack.message ?? 'message rejected', turnId: turn.clientTurnId });
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt)));
    }
    this.store.setLocalStatus(ids, 'FAILED');
    this.emitMessages();
    this.emit('error', { code: 'SEND_FAILED', message: 'could not deliver the message', turnId: turn.clientTurnId });
  }

  private rebuildTurn(turnId: string): InFlightTurn | null {
    const messages = this.store.turnMessages(turnId);
    if (messages.length === 0) {
      return null;
    }
    const turn: InFlightTurn = {
      clientTurnId: turnId,
      retryAttempt: 0,
      messages: messages.map((message) => ({
        clientMessageId: message.clientMessageId ?? newId(),
        body: message.body ?? '',
        sentAt: message.sentAt ?? new Date().toISOString(),
        ...(message.replyTo && { replyToId: message.replyTo.id }),
      })),
    };
    this.turnsById.set(turnId, turn);
    return turn;
  }

  // --- incoming ---------------------------------------------------------------

  private onPart(payload: WireMessage | Extract<StreamItem, { kind: 'SUGGESTED_CHIPS' }>): void {
    if (isChips(payload)) {
      this.emit('suggestions', payload.chips);
      return;
    }
    this.store.upsert([payload]);
    if (payload.senderType === 'AGENT' && payload.requestTurnId) {
      this.store.markAnsweredBefore(payload.id);
    }
    if (payload.partIndex + 1 >= payload.partsTotal) {
      this.setTyping(false);
    }
    this.emitMessages();
  }

  private ingestStream(items: StreamItem[]): void {
    let chips: SuggestedChip[] = [];
    const messages: WireMessage[] = [];
    for (const item of items) {
      if (isChips(item)) {
        chips = item.chips;
      } else {
        messages.push(item);
      }
    }
    this.store.upsert(messages);
    this.emitMessages();
    this.emit('suggestions', chips);
  }

  private applyUpdates(messages: WireMessage[]): void {
    this.store.upsert(messages);
    this.emitMessages();
  }

  private setTyping(typing: boolean, maxDurationMs = 0): void {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    if (typing && maxDurationMs > 0) {
      this.typingTimer = setTimeout(() => this.setTyping(false), maxDurationMs);
    }
    this.emit('typing', typing);
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('connection', state);
    }
  }

  private emitMessages(): void {
    this.emit('messages', this.store.list());
  }

  private emit<K extends keyof ChatClientEvents>(event: K, payload: ChatClientEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        (handler as Handler<K>)(payload);
      } catch (error) {
        console.error(`ai-chat: "${event}" handler threw`, error);
      }
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const response = await fetch(`${this.options.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (response.status === 401 && this.options.refreshToken && !retried) {
      this.token = await this.options.refreshToken();
      return this.request<T>(method, path, body, true);
    }
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = parsed?.error ?? { code: `HTTP_${response.status}`, message: response.statusText };
      throw Object.assign(new Error(error.message), { code: error.code, status: response.status });
    }
    return parsed as T;
  }
}

export type { ClientBehaviour };
